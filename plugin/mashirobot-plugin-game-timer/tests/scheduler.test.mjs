import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createScheduler } from "../core/scheduler.mjs";

const pluginRoot = path.resolve("plan/plugin/mashirobot-plugin-game-timer");
const sqlitePath = path.resolve("plan/sqlite/test.sqlite");

test("scheduler passes trusted paths and base64 payload", async () => {
  let call;
  const scheduler = createScheduler({
    pluginRoot, sqlitePath, powershellPath: "fake-pwsh",
    async runLocalProcess(options) {
      call = options;
      return { value: { reminderTaskName: "OpenClaw-GameTimer-Reminder-abc", forceTaskName: "OpenClaw-GameTimer-Force-abc" } };
    },
  });
  const result = await scheduler.schedule({ id: "abc", displayName: "饥荒联机版" });
  assert.equal(call.executable, "fake-pwsh");
  assert.ok(call.args.includes(path.join(pluginRoot, "powershell", "install-game-timer.ps1")));
  const encoded = call.args[call.args.indexOf("-TaskPayloadBase64") + 1];
  assert.equal(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")).id, "abc");
  assert.equal(result.forceTaskName, "OpenClaw-GameTimer-Force-abc");
});

test("scheduler remove uses only encoded task names", async () => {
  let args;
  const scheduler = createScheduler({
    pluginRoot, sqlitePath,
    async runLocalProcess(options) { args = options.args; return { value: { ok: true } }; },
  });
  await scheduler.remove({ reminderTaskName: "OpenClaw-GameTimer-Reminder-a", forceTaskName: "OpenClaw-GameTimer-Force-a" });
  assert.equal(args[args.indexOf("-Mode") + 1], "Remove");
  const payload = JSON.parse(Buffer.from(args[args.indexOf("-TaskPayloadBase64") + 1], "base64").toString("utf8"));
  assert.equal(payload.reminderTaskName, "OpenClaw-GameTimer-Reminder-a");
});
