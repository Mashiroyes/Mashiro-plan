import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const stores = new Map();
const closeCallbacks = new WeakMap();

function validateDate(value) {
  const text = String(value ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(text)) throw new TypeError("entryDate 必须为 YYYY-MM-DD。");
  return text;
}

function timestamp(now) {
  const value = new Date(now ?? Date.now());
  if (Number.isNaN(value.getTime())) throw new TypeError("now 必须是有效时间。");
  return value.toISOString();
}

function mapRow(row) {
  return row ? { entryDate: row.entry_date, content: row.content, createdAt: row.created_at, updatedAt: row.updated_at } : null;
}

function keyFor(sqlitePath) {
  return path.resolve(String(sqlitePath)).toLocaleLowerCase("en");
}

function translateDatabaseError(error) {
  if (error?.code === "SQLITE_BUSY" || /database is locked|database is busy/iu.test(String(error?.message ?? ""))) {
    const translated = new Error("战利品数据库正忙，请稍后重试。", { cause: error });
    translated.code = "LOOT_DB_BUSY";
    return translated;
  }
  return error;
}

export function createLootStore(sqlitePath, { databaseFactory = (target) => new DatabaseSync(target) } = {}) {
  const resolved = path.resolve(String(sqlitePath));
  const key = keyFor(resolved);
  const existing = stores.get(key);
  if (existing) return existing;

  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  let db;
  try {
    db = databaseFactory(resolved);
    db.exec(`
      PRAGMA busy_timeout=5000;
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS loot_entries (
        entry_date TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  } catch (error) {
    try { db?.close(); } catch {}
    throw translateDatabaseError(error);
  }

  let closed = false;
  function use(callback) {
    if (closed) throw new Error("战利品数据库连接已关闭。");
    try {
      return callback(db);
    } catch (error) {
      throw translateDatabaseError(error);
    }
  }

  const store = Object.freeze({
    sqlitePath: resolved,
    initialize() { return use(() => true); },
    save(entryDate, content, now = new Date()) {
      const date = validateDate(entryDate);
      const body = String(content ?? "").trim();
      if (!body) throw new TypeError("content 不能为空。");
      const updatedAt = timestamp(now);
      return use((database) => {
        database.prepare(`
          INSERT INTO loot_entries(entry_date, content, created_at, updated_at)
          VALUES(?, ?, ?, ?)
          ON CONFLICT(entry_date) DO UPDATE SET content=excluded.content, updated_at=excluded.updated_at
        `).run(date, body, updatedAt, updatedAt);
        return mapRow(database.prepare("SELECT * FROM loot_entries WHERE entry_date=?").get(date));
      });
    },
    get(entryDate) {
      const date = validateDate(entryDate);
      return use((database) => mapRow(database.prepare("SELECT * FROM loot_entries WHERE entry_date=?").get(date)));
    },
    dropLegacyNotes() {
      return use((database) => { database.exec("DROP TABLE IF EXISTS notes;"); return true; });
    },
    close() { return closeLootStore(resolved); },
  });
  stores.set(key, store);
  // Closure-owned cleanup stays outside the frozen public surface.
  closeCallbacks.set(store, () => {
    if (closed) return false;
    closed = true;
    try { db.close(); } finally { if (stores.get(key) === store) stores.delete(key); }
    return true;
  });
  return store;
}

export function closeLootStore(sqlitePath) {
  const store = stores.get(keyFor(sqlitePath));
  return store ? closeCallbacks.get(store)?.() ?? false : false;
}

export function closeAllLootStores() {
  let count = 0;
  for (const store of [...stores.values()]) if (closeCallbacks.get(store)?.()) count += 1;
  return count;
}
