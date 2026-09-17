import { readFile } from "node:fs/promises";
import path from "node:path";
import { runLocalProcess as defaultRunLocalProcess } from "../../../../core/execution/local-process.mjs";

const TASK_NAME = "MashiroBot-mashirobot-plugin-block-Reapply";
const DEFAULT_STATE_PATH = path.join(process.env.ProgramData ?? "C:\\ProgramData", "MashiroBot", "mashirobot-plugin-block", "state.json");

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export function createBlockSyncer({
  taskName = TASK_NAME,
  statePath = DEFAULT_STATE_PATH,
  runLocalProcess = defaultRunLocalProcess,
  readState = () => readJson(statePath),
  sleep = wait,
  now = () => Date.now(),
  verifyTimeoutMs = 15_000,
  pollMs = 200,
} = {}) {
  return Object.freeze({
    async apply({ signal } = {}) {
      let previousCompletedAt = null;
      try { previousCompletedAt = (await readState())?.LastSync?.completedAt ?? null; } catch {}
      const startedAt = now();
      try {
        await runLocalProcess({
          executable: "schtasks.exe",
          args: ["/Run", "/TN", taskName],
          timeoutMs: 10_000,
          output: "text",
          maxStdoutBytes: 64 * 1024,
          maxStderrBytes: 64 * 1024,
          signal,
        });
      } catch (error) {
        throw new Error("系统同步任务未运行，请重新安装禁止名单 worker", { cause: error });
      }

      const deadline = startedAt + verifyTimeoutMs;
      while (now() <= deadline) {
        if (signal?.aborted) throw signal.reason ?? new Error("系统同步已取消");
        try {
          const state = await readState();
          const sync = state?.LastSync;
          const completed = sync?.completedAt ? new Date(sync.completedAt).getTime() : Number.NaN;
          if (sync?.completedAt !== previousCompletedAt && Number.isFinite(completed) && completed >= startedAt - 2_000) {
            if (!sync.ok) throw new Error(`禁止名单 worker 同步失败：${sync.error ?? "未知错误"}`);
            return { ok: true, taskName, verified: true, sync };
          }
        } catch (error) {
          if (/worker 同步失败/u.test(String(error?.message))) throw error;
        }
        await sleep(pollMs);
      }
      throw new Error("禁止名单 worker 已启动，但未在规定时间内返回新的成功状态");
    },
  });
}
