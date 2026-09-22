import { buildTask } from "../core/timer-manager.mjs";
import { createGameTimerStore } from "../core/storage.mjs";
import { createJobManager } from "../../../core/control/job-manager.mjs";

const [mode, sqlitePath, id, executablePath = ""] = process.argv.slice(2);
const store = createGameTimerStore(sqlitePath);

if (mode === "create") {
  const processName = executablePath.replaceAll("/", "\\").split("\\").at(-1);
  const task = buildTask({
    game: { key: id, displayName: "测试游戏", processName, executablePath },
    minutes: 1, forceAfter: 1, now: new Date(), id,
  });
  store.createPending(task);
  store.activate(id, { reminderTaskName: `test-reminder-${id}`, forceTaskName: `test-force-${id}` });
  createJobManager({ sqlitePath }).upsertDesired({ jobId: `worker:${id}`, version: 1, owner: "test", kind: "game-force", taskName: `test-force-${id}`, payload: {} });
  process.stdout.write(JSON.stringify(task));
} else if (mode === "get") {
  process.stdout.write(JSON.stringify(store.get(id)));
} else {
  process.exit(2);
}
