import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { closeAllLootStores, closeLootStore, createLootStore } from "../core/store.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mashirobot-loot-store-"));
  t.after(() => {
    closeAllLootStores();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return path.join(root, "planner.sqlite");
}

test("stores only the last entry for each Shanghai date", (t) => {
  const sqlitePath = fixture(t);
  const store = createLootStore(sqlitePath);
  store.initialize();
  store.save("2026-08-18", "第一次", new Date("2026-08-18T13:01:00Z"));
  store.save("2026-08-18", "第二次\n完整内容", new Date("2026-08-18T13:05:00Z"));
  store.save("2026-08-19", "另一天", new Date("2026-08-19T13:01:00Z"));

  assert.equal(store.get("2026-08-18").content, "第二次\n完整内容");
  assert.equal(store.get("2026-08-19").content, "另一天");
  assert.equal(store.get("2026-08-17"), null);
});

test("reuses one initialized connection for the same database", (t) => {
  const sqlitePath = fixture(t);
  const first = createLootStore(sqlitePath);
  const second = createLootStore(path.resolve(sqlitePath));
  assert.equal(first, second);
  first.save("2026-09-16", "one", new Date("2026-09-16T05:00:00Z"));
  assert.equal(second.get("2026-09-16").content, "one");
});

test("closing removes the cached store and allows a clean reopen", (t) => {
  const sqlitePath = fixture(t);
  const first = createLootStore(sqlitePath);
  first.save("2026-09-16", "before close", new Date("2026-09-16T05:00:00Z"));
  assert.equal(closeLootStore(sqlitePath), true);
  assert.equal(closeLootStore(sqlitePath), false);

  const reopened = createLootStore(sqlitePath);
  assert.notEqual(reopened, first);
  assert.equal(reopened.get("2026-09-16").content, "before close");
});

test("translates SQLITE_BUSY into a bounded Chinese error", (t) => {
  const sqlitePath = fixture(t);
  const busy = new Error("database is locked");
  busy.code = "SQLITE_BUSY";
  const startedAt = Date.now();
  assert.throws(
    () => createLootStore(sqlitePath, {
      databaseFactory: () => ({ exec() { throw busy; }, close() {} }),
    }),
    (error) => error.code === "LOOT_DB_BUSY" && /数据库正忙/u.test(error.message),
  );
  assert.ok(Date.now() - startedAt < 500, "busy injection should fail without an unbounded retry");
});

test("drops the legacy notes table without exporting rows", (t) => {
  const sqlitePath = fixture(t);
  const db = new DatabaseSync(sqlitePath);
  db.exec(`
    CREATE TABLE notes(id INTEGER PRIMARY KEY, label INTEGER, content TEXT);
    CREATE INDEX idx_notes_active_id ON notes(id DESC);
    CREATE UNIQUE INDEX idx_notes_active_label ON notes(label);
    INSERT INTO notes(label, content) VALUES(1, '旧笔记一'), (2, '旧笔记二');
  `);
  db.close();

  const store = createLootStore(sqlitePath);
  store.dropLegacyNotes();

  const check = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    const names = check.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%notes%' OR name LIKE 'idx_notes_%'").all();
    assert.deepEqual(names, []);
  } finally {
    check.close();
  }
});
