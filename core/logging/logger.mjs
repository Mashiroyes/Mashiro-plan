import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

let logQueue = Promise.resolve();

function resolveLogPath() {
  const profile = process.env.USERPROFILE || process.env.HOME;
  if (!profile) {
    throw new Error("USERPROFILE and HOME are both unavailable");
  }
  return path.join(profile, ".openclaw", "logs", "mashirobot.log");
}

function finiteMetric(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function normalizeRecord(record = {}) {
  return {
    timestamp: new Date().toISOString(),
    level: String(record.level || "info"),
    requestId: String(record.requestId || ""),
    pluginId: String(record.pluginId || "mashirobot-core"),
    event: String(record.event || "log"),
    elapsedMs: finiteMetric(record.elapsedMs),
    externalElapsedMs: finiteMetric(record.externalElapsedMs),
    matchElapsedMs: finiteMetric(record.matchElapsedMs),
    handleElapsedMs: finiteMetric(record.handleElapsedMs),
    errorCode: String(record.errorCode || ""),
    message: String(record.message || "").replace(/\s+/gu, " ").trim().slice(0, 240),
  };
}

async function writeRecord(record) {
  const logPath = resolveLogPath();
  await mkdir(path.dirname(logPath), { recursive: true });
  await appendFile(logPath, `${JSON.stringify(record)}\n`, "utf8");
}

/**
 * Queue one UTF-8 JSON line without blocking or breaking message handling.
 * The returned promise is deliberately failure-safe; tests can await
 * flushMashiroLogs() when they need to inspect durable output.
 */
export function appendMashiroLog(record = {}) {
  const normalized = normalizeRecord(record);
  const pending = logQueue.then(() => writeRecord(normalized));
  logQueue = pending.catch(() => undefined);
  return logQueue;
}

export async function flushMashiroLogs() {
  await logQueue;
}
