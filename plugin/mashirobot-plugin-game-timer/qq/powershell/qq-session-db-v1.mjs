#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cooldownMinutesForDailySession } from "../../core/qq-session-model.mjs";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const versionedStorage = path.resolve(moduleDirectory, "../../core/qq-session-storage-v2.mjs");
const canonicalStorage = path.resolve(moduleDirectory, "../../core/qq-session-storage.mjs");
const { createQqSessionStore } = await import(pathToFileURL(fs.existsSync(versionedStorage) ? versionedStorage : canonicalStorage));

function shanghaiDateBounds(value) {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) throw new Error("Invalid compensation window");
  const fields = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(instant).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const start = Date.UTC(Number(fields.year), Number(fields.month) - 1, Number(fields.day), -8);
  return { start: new Date(start).toISOString(), end: new Date(start + 24 * 60 * 60_000).toISOString() };
}

function decode(value) {
  return JSON.parse(Buffer.from(String(value), "base64").toString("utf8"));
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function withDb(sqlitePath, callback) {
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
  const db = new DatabaseSync(sqlitePath);
  db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
  try { return callback(db); } finally { db.close(); }
}

const [command, sqlitePath, payload64] = process.argv.slice(2);
if (!command || !sqlitePath) throw new Error("Usage: qq-session-db-v1.mjs <command> <sqlitePath> [payload64]");
const store = createQqSessionStore(sqlitePath);
store.initialize();
const payload = payload64 ? decode(payload64) : {};

switch (command) {
  case "create64":
    output(store.createPreparing(payload));
    break;
  case "active":
    output(store.getBlockingSession(payload.now ?? new Date()));
    break;
  case "get":
    output(store.get(payload.id));
    break;
  case "latest-open":
    output(withDb(sqlitePath, (db) => {
      const row = db.prepare(`
        SELECT id FROM qq_timed_sessions
        WHERE phase IN ('preparing','playing','cooldown','uninstall_failed')
        ORDER BY requested_at DESC LIMIT 1
      `).get();
      return row ? store.get(row.id) : null;
    }));
    break;
  case "activate64":
    output(store.activateAfterInstall(payload.id, payload.confirmedAt ?? new Date(), payload.tasks ?? {}));
    break;
  case "phase64":
    output(store.setPhase(payload.id, payload.phase, payload.event ?? null, payload.updatedAt));
    break;
  case "compensate64":
    output(withDb(sqlitePath, (db) => {
      const now = new Date(payload.confirmedAt);
      const minutes = Number(payload.minutes);
      if (Number.isNaN(now.getTime()) || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 60) throw new Error("Invalid compensation window");
      const playEndsAt = new Date(now.getTime() + minutes * 60_000).toISOString();
      const day = shanghaiDateBounds(now);
      const priorCount = Number(db.prepare(`SELECT COUNT(*) AS count FROM qq_timed_sessions
        WHERE id <> ? AND confirmed_at IS NOT NULL AND phase <> 'failed' AND confirmed_at >= ? AND confirmed_at < ?`).get(payload.id, day.start, day.end).count);
      const cooldownEndsAt = new Date(new Date(playEndsAt).getTime() + cooldownMinutesForDailySession(priorCount + 1) * 60_000).toISOString();
      const result = db.prepare(`UPDATE qq_timed_sessions SET confirmed_at=?,play_ends_at=?,cooldown_ends_at=?,updated_at=? WHERE id=? AND phase='playing'`).run(
        now.toISOString(), playEndsAt, cooldownEndsAt, now.toISOString(), payload.id);
      if (Number(result.changes) !== 1) throw new Error("Playing session was not found for compensation");
      return { id: payload.id, confirmedAt: now.toISOString(), playEndsAt, cooldownEndsAt };
    }));
    break;
  case "fail64":
    output(store.fail(payload.id, payload.error, payload.updatedAt));
    break;
  case "event64":
    output(store.appendEvent(payload.sessionId ?? null, payload.event, payload.occurredAt));
    break;
  case "vault-capture64":
    output(withDb(sqlitePath, (db) => {
      const now = payload.updatedAt ?? new Date().toISOString();
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("UPDATE qq_installer_vault SET state='superseded', updated_at=? WHERE state='active'").run(now);
        const result = db.prepare(`
          INSERT INTO qq_installer_vault
            (original_name, source_path, vault_path, sha256, signer, state, captured_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
        `).run(payload.originalName, payload.sourcePath, payload.vaultPath, payload.sha256, payload.signer, now, now);
        db.exec("COMMIT");
        return { inserted: Number(result.changes), id: Number(result.lastInsertRowid) };
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    }));
    break;
  case "vault-active":
    output(withDb(sqlitePath, (db) => db.prepare(`
      SELECT id, original_name AS originalName, source_path AS sourcePath,
        vault_path AS vaultPath, sha256, signer, state, captured_at AS capturedAt, error
      FROM qq_installer_vault WHERE state='active' ORDER BY captured_at DESC LIMIT 1
    `).get() ?? null));
    break;
  case "vault-list":
    output(withDb(sqlitePath, (db) => db.prepare(`
      SELECT id, original_name AS originalName, source_path AS sourcePath,
        vault_path AS vaultPath, sha256, signer, state, captured_at AS capturedAt, error
      FROM qq_installer_vault ORDER BY captured_at DESC
    `).all()));
    break;
  case "vault-update64":
    output(withDb(sqlitePath, (db) => db.prepare(`
      UPDATE qq_installer_vault SET state=?, error=?, updated_at=? WHERE id=?
    `).run(payload.state, payload.error ?? null, payload.updatedAt ?? new Date().toISOString(), payload.id)));
    break;
  case "installed-vault-active":
    output(store.getInstalledExecutableVault());
    break;
  case "installed-vault-upsert64":
    output(store.setInstalledExecutableVault(payload));
    break;
  case "installed-vault-update64": {
    const current = store.getInstalledExecutableVault();
    if (!current) throw new Error("Installed executable vault record does not exist");
    output(store.setInstalledExecutableVault({ ...current, ...payload }));
    break;
  }
  default:
    throw new Error(`Unknown QQ DB command: ${command}`);
}
