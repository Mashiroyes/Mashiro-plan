#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { Buffer } from "node:buffer";
import { DatabaseSync } from "node:sqlite";

const [command, sqlitePath, payload64] = process.argv.slice(2);
if (!command || !sqlitePath) throw new Error("Usage: game-locker-db-v1.mjs <command> <sqlitePath> [payload64]");
const payload = payload64 ? JSON.parse(Buffer.from(payload64, "base64").toString("utf8")) : {};
fs.mkdirSync(path.dirname(sqlitePath), { recursive: true });
const db = new DatabaseSync(sqlitePath);
db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;");
db.exec(`CREATE TABLE IF NOT EXISTS game_executable_vault (
 id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL UNIQUE, game_key TEXT NOT NULL,
 display_name TEXT NOT NULL, original_path TEXT NOT NULL, vault_path TEXT, sha256 TEXT,
 state TEXT NOT NULL CHECK(state IN ('pending','preparing','quarantined','restored','missing','invalid','restore_conflict','failed')),
 requested_at TEXT NOT NULL, protected_at TEXT, restore_due_at TEXT, restored_at TEXT,
 restore_task_name TEXT, error TEXT, updated_at TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS idx_game_vault_due ON game_executable_vault(state,restore_due_at);`);
const out = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
try {
  if (command === "queue64") {
    const now = payload.requestedAt ?? new Date().toISOString();
    db.prepare(`INSERT OR IGNORE INTO game_executable_vault
      (task_id,game_key,display_name,original_path,state,requested_at,updated_at) VALUES (?,?,?,?,'pending',?,?)`).run(
      payload.taskId,payload.gameKey,payload.displayName,payload.originalPath,now,now);
    out(db.prepare("SELECT * FROM game_executable_vault WHERE task_id=?").get(payload.taskId));
  } else if (command === "open") out(db.prepare("SELECT * FROM game_executable_vault WHERE state IN ('pending','preparing','quarantined','restore_conflict') ORDER BY requested_at").all());
  else if (command === "get") out(db.prepare("SELECT * FROM game_executable_vault WHERE id=?").get(payload.id) ?? null);
  else if (command === "update64") {
    const allowed = new Set(["state","vault_path","sha256","protected_at","restore_due_at","restored_at","restore_task_name","error","updated_at"]);
    const entries = Object.entries(payload.values ?? {}).filter(([key]) => allowed.has(key));
    if (!entries.length) throw new Error("No allowed update values");
    const result = db.prepare(`UPDATE game_executable_vault SET ${entries.map(([key]) => `${key}=?`).join(",")} WHERE id=?`).run(...entries.map(([,value]) => value), payload.id);
    out({ ok: result.changes === 1 });
  } else if (command === "status") out(db.prepare("SELECT state,COUNT(*) count FROM game_executable_vault GROUP BY state").all());
  else throw new Error(`Unknown game locker DB command: ${command}`);
} finally { db.close(); }
