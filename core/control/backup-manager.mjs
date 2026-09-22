import fs from "node:fs";
import path from "node:path";
import { openControlDatabase } from "./database.mjs";

function shanghaiParts(now) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  return Object.fromEntries(parts.filter((x) => x.type !== "literal").map((x) => [x.type, x.value]));
}

function dateKey(now) {
  const p = shanghaiParts(now);
  return `${p.year}-${p.month}-${p.day}`;
}

function weekKey(now) {
  const p = shanghaiParts(now);
  const date = new Date(`${p.year}-${p.month}-${p.day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

function readManifest(root) {
  const file = path.join(root, "manifest.json");
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { version: 1, backups: [] }; }
}

function writeManifest(root, manifest) {
  const file = path.join(root, "manifest.json");
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

export function createRotatingBackup({ sqlitePath, backupRoot, now = new Date(), reason = "scheduled" }) {
  const source = path.resolve(sqlitePath);
  const root = path.resolve(backupRoot);
  fs.mkdirSync(root, { recursive: true });
  const db = openControlDatabase(source);
  try {
    const integrity = db.prepare("PRAGMA integrity_check").get()?.integrity_check;
    if (integrity !== "ok") throw new Error(`SQLite integrity check failed: ${integrity ?? "unknown"}`);
    db.exec("PRAGMA wal_checkpoint(FULL)");
  } finally { db.close(); }
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const directory = path.join(root, `control-${stamp}`);
  fs.mkdirSync(directory);
  const files = [];
  for (const candidate of [source, `${source}-wal`, `${source}-shm`]) {
    if (!fs.existsSync(candidate)) continue;
    const destination = path.join(directory, path.basename(candidate));
    fs.copyFileSync(candidate, destination);
    files.push({ name: path.basename(candidate), size: fs.statSync(destination).size });
  }
  const manifest = readManifest(root);
  manifest.backups.push({ directory: path.basename(directory), createdAt: new Date(now).toISOString(), dateKey: dateKey(now), weekKey: weekKey(now), reason, files });
  const ordered = [...manifest.backups].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const daily = new Set();
  const weekly = new Set();
  const keep = new Set();
  for (const item of ordered) {
    if (daily.size < 7 && !daily.has(item.dateKey)) { daily.add(item.dateKey); keep.add(item.directory); }
    if (weekly.size < 4 && !weekly.has(item.weekKey)) { weekly.add(item.weekKey); keep.add(item.directory); }
  }
  for (const item of ordered) {
    if (keep.has(item.directory)) continue;
    const target = path.resolve(root, item.directory);
    if (path.dirname(target) === root && fs.existsSync(target)) fs.rmSync(target, { recursive: true });
  }
  manifest.backups = ordered.filter((item) => keep.has(item.directory));
  writeManifest(root, manifest);
  return { ok: true, directory, retained: manifest.backups.length, files };
}
