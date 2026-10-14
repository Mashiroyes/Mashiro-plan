import path from "node:path";
import { fileURLToPath } from "node:url";

export function resolvePlanRoot({ env = process.env, moduleUrl = import.meta.url } = {}) {
  const explicit = String(env.MASHIROBOT_PLAN_ROOT ?? "").trim();
  if (explicit) return path.resolve(explicit);
  const inferred = path.resolve(path.dirname(fileURLToPath(moduleUrl)), "..", "..");
  const captureSegment = `${path.sep}plugin-captures${path.sep}`.toLowerCase();
  if (`${inferred}${path.sep}`.toLowerCase().includes(captureSegment)) {
    throw new Error("MASHIROBOT_PLAN_ROOT is required when OpenClaw loads a captured plugin copy");
  }
  return inferred;
}
