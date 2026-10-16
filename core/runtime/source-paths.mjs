import path from "node:path";
import { fileURLToPath } from "node:url";

const fallbackPlanRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function resolvePlanSourcePath(...segments) {
  const configured = String(process.env.MASHIROBOT_PLAN_ROOT || "").trim();
  return path.resolve(configured || fallbackPlanRoot, ...segments);
}
