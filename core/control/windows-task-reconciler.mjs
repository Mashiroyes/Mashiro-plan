import path from "node:path";
import { runLocalProcess } from "../execution/local-process.mjs";
import { resolvePlanSourcePath } from "../runtime/source-paths.mjs";

const script = resolvePlanSourcePath("core", "control", "windows", "job-reconcile.ps1");
export async function reconcileWindowsTasks({ sqlitePath, apply = true, runner = runLocalProcess } = {}) {
  const completed = await runner({ executable: process.env.MASHIROBOT_PWSH || "pwsh.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Mode", apply ? "Apply" : "Inspect", "-SqlitePath", path.resolve(sqlitePath)], timeoutProfile: "powershell", operation: apply ? "windows-task-reconcile" : "windows-task-inspect", output: "json", jsonMode: "last-line" });
  return completed.value;
}
