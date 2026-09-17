import path from "node:path";
import { runLocalProcess as defaultRunLocalProcess } from "../../../core/execution/local-process.mjs";

function payload64(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function createScheduler({ pluginRoot, sqlitePath, powershellPath = "pwsh.exe", runLocalProcess = defaultRunLocalProcess }) {
  const installer = path.resolve(pluginRoot, "powershell", "install-game-timer.ps1");
  const common = ["-NoProfile", "-NonInteractive", "-File", installer];

  async function invoke(args, signal) {
    const completed = await runLocalProcess({
      executable: powershellPath,
      args: [...common, ...args],
      timeoutMs: 30_000,
      output: "json",
      jsonMode: "last-line",
      maxStdoutBytes: 2 * 1024 * 1024,
      maxStderrBytes: 128 * 1024,
      signal,
    });
    return completed.value;
  }

  return Object.freeze({
    schedule(task, { signal } = {}) {
      return invoke(["-Mode", "Schedule", "-TaskPayloadBase64", payload64(task), "-SqlitePath", path.resolve(sqlitePath)], signal);
    },
    remove(taskNames, { signal } = {}) {
      return invoke(["-Mode", "Remove", "-TaskPayloadBase64", payload64(taskNames), "-SqlitePath", path.resolve(sqlitePath)], signal);
    },
  });
}
