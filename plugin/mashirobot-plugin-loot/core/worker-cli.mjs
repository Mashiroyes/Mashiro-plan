import { buildEveningReminder, buildReplayMessage } from "./messages.mjs";
import { previousDate, shanghaiParts } from "./dates.mjs";
import { closeLootStore, createLootStore } from "./store.mjs";
import { pathToFileURL } from "node:url";

function argumentValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

function parseNow(value) {
  const now = value ? new Date(value) : new Date();
  if (Number.isNaN(now.getTime())) throw new TypeError("now 必须是有效时间。");
  return now;
}

function decision(action, store, now) {
  const local = shanghaiParts(now);
  store.initialize();

  if (action === "evening") {
    const minutes = local.hour * 60 + local.minute;
    if (minutes < 21 * 60 || minutes > 22 * 60) {
      return { ok: true, action: "skip", reason: "outside-evening-window", entryDate: local.date };
    }
    if (store.get(local.date)) {
      return { ok: true, action: "skip", reason: "already-recorded", entryDate: local.date };
    }
    return { ok: true, action: "send", reason: "missing-record", entryDate: local.date, message: buildEveningReminder() };
  }

  if (action === "morning") {
    const entryDate = previousDate(local.date);
    const entry = store.get(entryDate);
    if (!entry) return { ok: true, action: "skip", reason: "no-previous-record", entryDate };
    return { ok: true, action: "send", reason: "previous-record", entryDate, message: buildReplayMessage(entryDate, entry.content) };
  }

  throw new Error("action 必须是 evening 或 morning。");
}

export function runWorkerCli(argv = process.argv.slice(2)) {
  const action = argumentValue(argv, "--action");
  const sqlitePath = argumentValue(argv, "--sqlite");
  if (!action || !sqlitePath) throw new Error("需要 --action 和 --sqlite。");
  const store = createLootStore(sqlitePath);
  try {
    return decision(action, store, parseNow(argumentValue(argv, "--now")));
  } finally {
    closeLootStore(sqlitePath);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(runWorkerCli())}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
