import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createQqSessionScheduler } from "../core/qq-session-scheduler.mjs";

function schedulerFor(status) {
  return createQqSessionScheduler({
    pluginRoot: process.cwd(),
    sqlitePath: "planner.sqlite",
    stateRoot: path.join(os.tmpdir(), `qq-scheduler-no-cache-${Math.random()}`),
    runLocalProcess: async () => ({ value: { ok: true, status } }),
  });
}

test("QQ preflight accepts an intentionally released barrier while playing", async () => {
  const result = await schedulerFor({ phase: "playing", authorizationActive: true, clientBarrierActive: false, websiteBlockActive: true, executableReady: true }).preflight();
  assert.equal(result.ok, true);
});

test("QQ preflight still rejects a missing barrier outside an authorized session", async () => {
  const result = await schedulerFor({ phase: "ready", authorizationActive: false, clientBarrierActive: false, websiteBlockActive: true, executableReady: true }).preflight();
  assert.equal(result.ok, false);
  assert.match(result.errors.join("；"), /客户端常驻拦截未生效/u);
});

test("QQ preflight uses a fresh status cache without launching PowerShell", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qq-scheduler-cache-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "last-status.json"), JSON.stringify({ ok: true, phase: "ready", authorizationActive: false, clientBarrierActive: true, websiteBlockActive: true, executableReady: true }));
  const scheduler = createQqSessionScheduler({
    pluginRoot: process.cwd(), sqlitePath: "planner.sqlite", stateRoot: root,
    runLocalProcess: async () => { throw new Error("PowerShell should not run"); },
  });
  assert.equal((await scheduler.preflight()).ok, true);
});

test("QQ begin starts the resident task and polls without blocking other promises", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qq-scheduler-begin-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const session = { id: "fast-session", phase: "preparing" };
  let started = 0;
  const scheduler = createQqSessionScheduler({
    pluginRoot: process.cwd(), sqlitePath: "planner.sqlite", stateRoot: root, timeoutMs: 200, pollIntervalMs: 5,
    startTask: async () => {
      started += 1;
      setTimeout(() => fs.writeFileSync(path.join(root, "last-status.json"), JSON.stringify({ ok: true, sessionId: session.id, phase: "playing", authorizationActive: true, qqInstalled: true, interactiveProcessActive: true, session: { ...session, confirmedAt: "2026-09-16T05:00:00.000Z", phase: "playing" } })), 20);
    },
  });
  let concurrent = false;
  const pending = scheduler.begin(session);
  await Promise.resolve().then(() => { concurrent = true; });
  const result = await pending;
  assert.equal(concurrent, true);
  assert.equal(result.session.id, session.id);
  assert.equal(started, 1);
});

for (const [label, status] of [
  ["wrong session", { sessionId: "other", phase: "playing", authorizationActive: true, qqInstalled: true, interactiveProcessActive: true }],
  ["missing desktop process", { sessionId: "target", phase: "playing", authorizationActive: true, qqInstalled: true, interactiveProcessActive: false }],
  ["inactive authorization", { sessionId: "target", phase: "playing", authorizationActive: false, qqInstalled: true, interactiveProcessActive: true }],
]) {
  test(`QQ begin rejects ${label}`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "qq-scheduler-invalid-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const scheduler = createQqSessionScheduler({
      pluginRoot: process.cwd(), sqlitePath: "planner.sqlite", stateRoot: root, timeoutMs: 25, pollIntervalMs: 2,
      startTask: async () => { fs.writeFileSync(path.join(root, "last-status.json"), JSON.stringify(status)); },
    });
    await assert.rejects(scheduler.begin({ id: "target" }), (error) => error?.code === "QQ_START_UNVERIFIED");
  });
}

test("QQ begin rejects a status file older than the begin operation", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qq-scheduler-stale-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const statusPath = path.join(root, "last-status.json");
  fs.writeFileSync(statusPath, JSON.stringify({ sessionId: "target", phase: "playing", authorizationActive: true, qqInstalled: true, interactiveProcessActive: true }));
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(statusPath, old, old);
  const scheduler = createQqSessionScheduler({ pluginRoot: process.cwd(), sqlitePath: "planner.sqlite", stateRoot: root, timeoutMs: 20, pollIntervalMs: 2, startTask: async () => {} });
  await assert.rejects(scheduler.begin({ id: "target" }), (error) => error?.code === "QQ_START_UNVERIFIED" && error.lastStatus === null);
});
