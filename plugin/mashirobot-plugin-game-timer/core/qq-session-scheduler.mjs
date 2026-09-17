import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { runLocalProcess as defaultRunLocalProcess } from "../../../core/execution/local-process.mjs";

function defaultDelay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error("QQ session polling was cancelled");
      error.code = "PROCESS_ABORTED";
      reject(error);
      return;
    }
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      const error = new Error("QQ session polling was cancelled");
      error.code = "PROCESS_ABORTED";
      reject(error);
    }
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

function boundedStatus(status) {
  if (!status || typeof status !== "object") return null;
  const summary = Object.fromEntries(["sessionId", "ok", "phase", "authorizationActive", "qqInstalled", "interactiveProcessActive", "error"].map((key) => [key, status[key]]));
  return JSON.stringify(summary).slice(0, 1_000);
}

export function createQqSessionScheduler({
  pluginRoot,
  sqlitePath,
  powershellPath = "pwsh.exe",
  runLocalProcess = defaultRunLocalProcess,
  startTask = null,
  stateRoot = path.join(process.env.ProgramData ?? "C:\\ProgramData", "MashiroBot", "mashirobot-plugin-game-timer", "qq"),
  cacheMaxAgeMs = 6 * 60_000,
  now = () => Date.now(),
  monotonicNow = () => performance.now(),
  delay = defaultDelay,
  pollIntervalMs = 100,
  timeoutMs = 300_000,
} = {}) {
  const installer = path.resolve(pluginRoot, "qq", "powershell", "install-qq-session.ps1");
  const common = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", installer];
  const statusPath = path.join(stateRoot, "last-status.json");
  const startReconcile = startTask ?? (() => runLocalProcess({
    executable: "schtasks.exe",
    args: ["/Run", "/TN", "MashiroBot-QQSession-Reconcile"],
    timeoutMs: 10_000,
    output: "text",
    maxStdoutBytes: 64 * 1024,
    maxStderrBytes: 64 * 1024,
  }));

  async function cachedStatus({ freshOnly = false, notBeforeMs = null } = {}) {
    try {
      const details = await stat(statusPath);
      if (freshOnly && now() - details.mtimeMs > cacheMaxAgeMs) return null;
      if (notBeforeMs !== null && details.mtimeMs < notBeforeMs) return null;
      return JSON.parse(await readFile(statusPath, "utf8"));
    } catch {
      return null;
    }
  }

  async function invoke(mode, sessionId = null, signal = undefined) {
    const args = [...common, "-Mode", mode, "-SqlitePath", path.resolve(sqlitePath)];
    if (sessionId) args.push("-SessionId", String(sessionId));
    const completed = await runLocalProcess({
      executable: powershellPath,
      args,
      timeoutMs: Math.max(30_000, timeoutMs),
      output: "json",
      jsonMode: "last-line",
      maxStdoutBytes: 2 * 1024 * 1024,
      maxStderrBytes: 128 * 1024,
      signal,
    });
    return completed.value;
  }

  return Object.freeze({
    status({ signal } = {}) { return invoke("Status", null, signal); },
    async preflight({ signal } = {}) {
      const cached = await cachedStatus({ freshOnly: true });
      const status = cached ? { ok: cached.ok !== false, status: cached, source: "cache" } : await invoke("Status", null, signal);
      const worker = status.status;
      const errors = [];
      if (!status.ok) errors.push("QQ限时执行器未安装或状态异常");
      const authorizedPlaying = worker?.phase === "playing" && worker?.authorizationActive;
      if (!authorizedPlaying && !worker?.clientBarrierActive) errors.push("CodexFocusLock 的QQ客户端常驻拦截未生效");
      if (!worker?.websiteBlockActive) errors.push("CodexFocusLock 的QQ官网常驻拦截未生效");
      if (!worker?.executableReady) errors.push("没有找到可恢复或已安装的腾讯 QQ.exe");
      return { ok: errors.length === 0, errors, status };
    },
    async begin(session, { signal } = {}) {
      const beganAt = now();
      const deadline = monotonicNow() + timeoutMs;
      await startReconcile({ signal });
      let last = null;
      while (monotonicNow() < deadline) {
        const worker = await cachedStatus({ notBeforeMs: beganAt });
        if (worker?.sessionId === session.id && worker?.ok === false) throw new Error(worker.error ?? "QQ启动失败");
        if (worker?.sessionId === session.id && worker?.phase === "playing" && worker?.authorizationActive === true && worker?.qqInstalled === true && worker?.interactiveProcessActive === true) {
          return { session: worker.session, status: worker };
        }
        if (worker) last = worker;
        await delay(Math.min(pollIntervalMs, Math.max(0, deadline - monotonicNow())), signal);
      }
      const error = new Error(`QQ限时执行器未确认桌面QQ已启动；最后状态：${boundedStatus(last) ?? "无"}`);
      error.code = "QQ_START_UNVERIFIED";
      error.lastStatus = last;
      throw error;
    },
    recover({ signal } = {}) { return invoke("Recover", null, signal); },
  });
}
