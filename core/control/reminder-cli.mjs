#!/usr/bin/env node
import { createReminderManager } from "./reminder-manager.mjs";

const [, , action, sqlitePath, payload64 = ""] = process.argv;
if (!action || !sqlitePath) throw new Error("usage: reminder-cli.mjs <action> <sqlite-path> [payload-base64]");
const payload = payload64 ? JSON.parse(Buffer.from(payload64, "base64").toString("utf8")) : {};
const manager = createReminderManager({ sqlitePath });
let result;
if (action === "dispatch") {
  const registered = manager.register(payload);
  const selected = manager.claimForDispatch(registered.reminder.id, { limit: 20 });
  if (!selected.length) result = { ok: true, shouldSend: false, reminder: registered.reminder, reason: "paused-silent-or-not-due" };
  else {
    const lines = selected.map((item) => `${item.requiresAck ? `[${item.shortId}] ` : ""}${item.content}`);
    result = { ok: true, shouldSend: true, reminderIds: selected.map((item) => item.id), message: lines.join("\n") };
  }
} else if (action === "finish") {
  for (const id of payload.reminderIds ?? []) manager.finishDelivery(id, { ok: Boolean(payload.ok), error: payload.error });
  result = { ok: true };
} else if (action === "list") result = manager.listCurrent();
else throw new Error(`unknown reminder action: ${action}`);
process.stdout.write(`${JSON.stringify(result)}\n`);
