import fs from "node:fs";
import path from "node:path";

export const deploymentPhases = Object.freeze(["preflight", "configure", "backup", "adapter", "gateway-watchdog", "core-features", "optional-features", "gateway-start", "static-verify", "acceptance", "report"]);

export function createRunState({ runId, profile = "Standard", phases = deploymentPhases, startedAt = new Date().toISOString() } = {}) {
  return { schemaVersion: 1, runId: runId ?? crypto.randomUUID(), profile, startedAt, status: "running", phases: Object.fromEntries(phases.map((name) => [name, { status: "pending", startedAt: null, finishedAt: null, exitCode: null, evidencePaths: [], warnings: [], error: null }])) };
}

export function nextPhase(state) { return Object.entries(state.phases).find(([, value]) => !["passed", "skipped"].includes(value.status))?.[0] ?? null; }
export function summarizeRun({ requiredFailures = [], warnings = [], unverified = [] } = {}) { if (requiredFailures.length) return "failed"; if (unverified.length) return "unverified"; if (warnings.length) return "completed_with_warnings"; return "passed"; }
function redact(key, value) { if (!/token|secret|password|credential|weixinTarget/i.test(key)) return value; const text = String(value ?? ""); return text ? `***${text.slice(-4)}` : ""; }
export function redactReport(value) { if (Array.isArray(value)) return value.map(redactReport); if (!value || typeof value !== "object") return value; return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redact(key, redactReport(entry))])); }
export function writeRunState(filePath, state) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); const temporary = `${filePath}.tmp-${process.pid}`; fs.writeFileSync(temporary, `${JSON.stringify(redactReport(state), null, 2)}\n`, "utf8"); fs.renameSync(temporary, filePath); }
