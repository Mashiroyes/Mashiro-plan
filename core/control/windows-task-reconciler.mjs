import path from "node:path";
import { fileURLToPath } from "node:url";
import { runLocalProcess } from "../execution/local-process.mjs";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "windows", "job-reconcile.ps1");
export async function reconcileWindowsTasks({ sqlitePath, apply = true, runner = runLocalProcess } = {}) {
  const completed = await runner({ executable: process.env.MASHIROBOT_PWSH || "pwsh.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Mode", apply ? "Apply" : "Inspect", "-SqlitePath", path.resolve(sqlitePath)], timeoutProfile: "powershell", operation: apply ? "windows-task-reconcile" : "windows-task-inspect", output: "json", jsonMode: "last-line" });
  return completed.value;
}
