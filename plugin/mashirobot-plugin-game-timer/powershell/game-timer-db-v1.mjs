import { DatabaseSync } from "node:sqlite";

const [mode, sqlitePath, id, payload64 = ""] = process.argv.slice(2);
if (!mode || !sqlitePath || !id) process.exit(2);
const db = new DatabaseSync(sqlitePath);
db.exec("PRAGMA busy_timeout=5000");
db.exec(`CREATE TABLE IF NOT EXISTS game_executable_vault (
 id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL UNIQUE, game_key TEXT NOT NULL,
 display_name TEXT NOT NULL, original_path TEXT NOT NULL, vault_path TEXT, sha256 TEXT,
 state TEXT NOT NULL CHECK(state IN ('pending','preparing','quarantined','restored','missing','invalid','restore_conflict','failed')),
 requested_at TEXT NOT NULL, protected_at TEXT, restore_due_at TEXT, restored_at TEXT,
 restore_task_name TEXT, error TEXT, updated_at TEXT NOT NULL);`);
try {
  if (mode === "get") {
    const row = db.prepare("SELECT * FROM game_timer_tasks WHERE id=?").get(id);
    process.stdout.write(JSON.stringify(row ?? null));
  } else if (mode === "get64") {
    const row = db.prepare("SELECT * FROM game_timer_tasks WHERE id=?").get(id);
    process.stdout.write(Buffer.from(JSON.stringify(row ?? null), "utf8").toString("base64"));
  } else if (mode === "update") {
    const payload = JSON.parse(Buffer.from(payload64, "base64").toString("utf8"));
    const allowed = new Set(["status", "reminded_at", "closed_pids_json", "error", "updated_at"]);
    const entries = Object.entries(payload).filter(([key]) => allowed.has(key));
    if (!entries.length) throw new Error("no allowed update fields");
    const sql = `UPDATE game_timer_tasks SET ${entries.map(([key]) => `${key}=?`).join(",")} WHERE id=?`;
    db.prepare(sql).run(...entries.map(([, value]) => value), id);
    process.stdout.write(JSON.stringify({ ok: true }));
  } else if (mode === "queue-vault") {
    const task = db.prepare("SELECT * FROM game_timer_tasks WHERE id=?").get(id);
    if (!task) throw new Error("timer task was not found");
    const now = new Date().toISOString();
    db.prepare(`INSERT OR IGNORE INTO game_executable_vault
      (task_id,game_key,display_name,original_path,state,requested_at,updated_at)
      VALUES (?,?,?,?,'pending',?,?)`).run(task.id,task.game_key,task.display_name,task.executable_path,now,now);
    process.stdout.write(JSON.stringify({ ok: true }));
  } else {
    throw new Error(`unknown mode: ${mode}`);
  }
} finally {
  db.close();
}
