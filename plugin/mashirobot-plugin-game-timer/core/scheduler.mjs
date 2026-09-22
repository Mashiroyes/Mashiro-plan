import path from "node:path";
import { runLocalProcess as defaultRunLocalProcess } from "../../../core/execution/local-process.mjs";
import { createJobManager } from "../../../core/control/job-manager.mjs";

function payload64(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function createScheduler({ pluginRoot, sqlitePath, powershellPath = "pwsh.exe", runLocalProcess = defaultRunLocalProcess }) {
  const installer = path.resolve(pluginRoot, "powershell", "install-game-timer.ps1");
  const common = ["-NoProfile", "-NonInteractive", "-File", installer];
  const jobs = createJobManager({ sqlitePath });

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
    async schedule(task, { signal } = {}) {
      const shortId = String(task.id).replaceAll("-", "").slice(0, 12);
      const worker = path.join(process.env.LOCALAPPDATA ?? pluginRoot, "MashiroBot", "game-timer", "workers", "game-timer-worker-v1.ps1");
      const version = task.version ?? 1;
      const reminderJobId = `${task.id}:reminder`;
      const forceJobId = `${task.id}:force`;
      const reminderTaskName = `OpenClaw-GameTimer-Reminder-${shortId}`;
      const forceTaskName = `OpenClaw-GameTimer-Force-${shortId}`;
      const execution = (mode, jobId, taskName) => ({ executable: powershellPath, arguments: `-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${worker}" -Mode ${mode} -TaskId "${task.id}" -TaskVersion "${version}" -JobId "${jobId}" -SqlitePath "${path.resolve(sqlitePath)}" -ScheduledTaskName "${taskName}"` });
      const reminderJob = jobs.upsertDesired({ jobId: reminderJobId, version, owner: "mashirobot-plugin-game-timer", kind: "game-reminder", taskName: reminderTaskName, runAt: task.reminderAt, payload: { taskId: task.id, taskVersion: version, execution: execution("Reminder", reminderJobId, reminderTaskName) } });
      const forceJob = jobs.upsertDesired({ jobId: forceJobId, version, owner: "mashirobot-plugin-game-timer", kind: "game-force", taskName: forceTaskName, runAt: task.forceAt, payload: { taskId: task.id, taskVersion: version, execution: execution("Force", forceJobId, forceTaskName) } });
      try {
        return await invoke(["-Mode", "Schedule", "-TaskPayloadBase64", payload64({ ...task, reminderJobId: reminderJob.jobId, forceJobId: forceJob.jobId }), "-SqlitePath", path.resolve(sqlitePath)], signal);
      } catch (error) {
        jobs.cancel(reminderJob.jobId); jobs.cancel(forceJob.jobId); throw error;
      }
    },
    async remove(taskNames, { signal } = {}) {
      if (taskNames?.id) { jobs.cancel(`${taskNames.id}:reminder`); jobs.cancel(`${taskNames.id}:force`); }
      return invoke(["-Mode", "Remove", "-TaskPayloadBase64", payload64(taskNames), "-SqlitePath", path.resolve(sqlitePath)], signal);
    },
    forceNow(task, { signal } = {}) {
      const worker = path.resolve(pluginRoot, "powershell", "game-timer-worker-v1.ps1");
      const jobId = `${task.id}:manual-force:${task.version}`;
      jobs.upsertDesired({ jobId, version: task.version, owner: "mashirobot-plugin-game-timer", kind: "game-manual-force", taskName: `OpenClaw-GameTimer-Manual-${String(task.id).slice(0, 12)}`, runAt: new Date().toISOString(), payload: { taskId: task.id, taskVersion: task.version } });
      return runLocalProcess({
        executable: powershellPath,
        args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", worker, "-Mode", "Force", "-TaskId", task.id, "-TaskVersion", String(task.version), "-JobId", jobId, "-SqlitePath", path.resolve(sqlitePath), "-ScheduledTaskName", `OpenClaw-GameTimer-Manual-${task.id}`],
        timeoutMs: 30_000, output: "text", signal,
      });
    },
  });
}
