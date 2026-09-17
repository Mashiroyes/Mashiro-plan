import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.dirname(fileURLToPath(import.meta.url));
const planRoot = path.resolve(pluginRoot, "..", "..");
const HEALTH_LEVELS = new Set(["file", "registered", "heartbeat", "verified"]);

function checkedAtValue(now) {
  const value = new Date(typeof now === "function" ? now() : now ?? Date.now());
  if (Number.isNaN(value.getTime())) throw new TypeError("健康检查时间无效。");
  return value.toISOString();
}

export function healthEntry({ ok, level, evidence, now }) {
  if (!HEALTH_LEVELS.has(level)) throw new TypeError(`未知健康级别：${level}`);
  return Object.freeze({ ok: Boolean(ok), level, evidence, checkedAt: checkedAtValue(now) });
}

export function evaluateRegisteredTaskHealth({ registered, statusCheckedAt, statusOk = false, now, maxAgeMs = 10 * 60_000 }) {
  const current = new Date(now ?? Date.now()).getTime();
  const checked = statusCheckedAt == null ? Number.NaN : new Date(statusCheckedAt).getTime();
  const ageMs = Number.isFinite(checked) ? Math.max(0, current - checked) : null;
  if (!registered) return healthEntry({ ok: false, level: "registered", evidence: { registered: false }, now: current });
  if (ageMs === null || ageMs > maxAgeMs) {
    return healthEntry({ ok: false, level: "heartbeat", evidence: { registered: true, statusCheckedAt: statusCheckedAt ?? null, ageMs, maxAgeMs }, now: current });
  }
  return healthEntry({ ok: statusOk, level: statusOk ? "verified" : "heartbeat", evidence: { registered: true, statusCheckedAt, ageMs, maxAgeMs, statusOk }, now: current });
}

export function evaluateHeartbeatHealth({ heartbeatAt, now, maxAgeMs = 10 * 60_000 }) {
  const current = new Date(now ?? Date.now()).getTime();
  const heartbeat = heartbeatAt == null ? Number.NaN : new Date(heartbeatAt).getTime();
  const ageMs = Number.isFinite(heartbeat) ? Math.max(0, current - heartbeat) : null;
  return healthEntry({
    ok: ageMs !== null && ageMs <= maxAgeMs,
    level: "heartbeat",
    evidence: { heartbeatAt: heartbeatAt ?? null, ageMs, maxAgeMs },
    now: current,
  });
}

export function evaluateAdapterImportHealth({ imported, modulePath, now }) {
  return healthEntry({
    ok: Boolean(imported),
    level: imported ? "verified" : "file",
    evidence: { imported: Boolean(imported), modulePath: String(modulePath ?? "") },
    now,
  });
}

export async function collectPluginHealth(registry) {
  const entries = await Promise.all(registry.plugins.map(async (entry) => [
    entry.manifest.id,
    await entry.module.healthCheck(),
  ]));
  return Object.fromEntries(entries);
}

export function runPlanHealthChecks({ exists = existsSync, now = Date.now } = {}) {
  const python = process.env.OPENCLAW_PYTHON_PATH
    ?? process.env.MASHIROBOT_PYTHON
    ?? path.join(os.homedir(), "AppData", "Local", "Python", "pythoncore-3.14-64", "python.exe");
  const paths = {
    manifest: path.join(pluginRoot, "plugin.json"),
    planner: path.join(pluginRoot, "planner", "planner.py"),
    managePlan: path.join(pluginRoot, "windows", "manage-plan.ps1"),
    routineReminder: path.join(pluginRoot, "windows", "routine-reminder.ps1"),
    database: path.join(planRoot, "sqlite", "openclaw-planner.sqlite"),
    python,
  };
  const checks = Object.fromEntries(Object.entries(paths).map(([name, target]) => [name, healthEntry({
    ok: exists(target),
    level: "file",
    evidence: { path: target },
    now,
  })]));
  return { ok: Object.values(checks).every((entry) => entry.ok), checks, checkedAt: checkedAtValue(now) };
}
