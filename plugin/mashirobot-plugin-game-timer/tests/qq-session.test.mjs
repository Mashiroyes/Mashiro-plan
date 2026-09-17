import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseQqSessionCommand, canStartQqSession } from "../core/qq-session-parser.mjs";
import { buildQqRequest, activateQqRequest, cooldownMinutesForDailySession, phaseAt } from "../core/qq-session-model.mjs";
import { createQqSessionStore } from "../core/qq-session-storage.mjs";

function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "qq-session-")); return { root, sqlitePath: path.join(root, "planner.sqlite") }; }

test("QQ accepts one through sixty minutes and applies Shanghai noon gate", () => {
  assert.deepEqual(parseQqSessionCommand("玩QQ1分钟"), { kind: "qq-session", minutes: 1 });
  assert.deepEqual(parseQqSessionCommand("玩QQ10分钟"), { kind: "qq-session", minutes: 10 });
  assert.deepEqual(parseQqSessionCommand("玩QQ60分钟"), { kind: "qq-session", minutes: 60 });
  assert.equal(parseQqSessionCommand("玩QQ0分钟"), null);
  assert.equal(parseQqSessionCommand("玩QQ61分钟"), null);
  assert.equal(parseQqSessionCommand("玩QQ1小时"), null);
  assert.equal(canStartQqSession(new Date("2026-09-15T03:59:59Z")), false);
  assert.equal(canStartQqSession(new Date("2026-09-15T04:00:00Z")), true);
});

test("requested play time and first daily cooldown start after installation", () => {
  const request = buildQqRequest({ now: "2026-09-15T04:00:00Z", id: "one", minutes: 20 });
  assert.equal(request.confirmedAt, null);
  assert.equal(phaseAt(request, "2026-09-15T04:04:59Z"), "preparing");
  const active = activateQqRequest(request, "2026-09-15T04:05:00Z");
  assert.equal(active.playEndsAt, "2026-09-15T04:25:00.000Z");
  assert.equal(active.cooldownEndsAt, "2026-09-15T05:25:00.000Z");
  assert.equal(active.cooldownMinutes, 60);
  assert.equal(phaseAt(active, "2026-09-15T04:25:00Z"), "cooldown");
});

test("daily cooldown starts at one hour and increases ten minutes per successful QQ start", () => {
  assert.equal(cooldownMinutesForDailySession(1), 60);
  assert.equal(cooldownMinutesForDailySession(2), 70);
  assert.equal(cooldownMinutesForDailySession(3), 80);
  assert.throws(() => cooldownMinutesForDailySession(0), /positive/);
  const { root, sqlitePath } = fixture();
  try {
    const store = createQqSessionStore(sqlitePath);
    store.createPreparing(buildQqRequest({ now: "2026-09-15T04:00:00Z", id: "one", minutes: 10 }));
    const first = store.activateAfterInstall("one", "2026-09-15T04:01:00Z");
    assert.equal(first.cooldownEndsAt, "2026-09-15T05:11:00.000Z");
    store.setPhase("one", "cooldown", null, "2026-09-15T04:11:00Z");
    store.setPhase("one", "ready", null, "2026-09-15T05:11:00Z");
    store.createPreparing(buildQqRequest({ now: "2026-09-15T05:12:00Z", id: "two", minutes: 10 }));
    const second = store.activateAfterInstall("two", "2026-09-15T05:13:00Z");
    assert.equal(second.cooldownEndsAt, "2026-09-15T06:33:00.000Z");
    store.setPhase("two", "cooldown", null, "2026-09-15T05:23:00Z");
    store.setPhase("two", "ready", null, "2026-09-15T06:33:00Z");
    store.createPreparing(buildQqRequest({ now: "2026-09-15T16:01:00Z", id: "three", minutes: 10 }));
    const nextDay = store.activateAfterInstall("three", "2026-09-15T16:02:00Z");
    assert.equal(nextDay.cooldownEndsAt, "2026-09-15T17:12:00.000Z");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("store prevents overlap during preparation and fixes timestamps once", () => {
  const { root, sqlitePath } = fixture();
  try {
    const store = createQqSessionStore(sqlitePath);
    const one = buildQqRequest({ now: "2026-09-15T04:00:00Z", id: "one", minutes: 15 });
    assert.equal(store.createPreparing(one).created, true);
    assert.equal(store.createPreparing(buildQqRequest({ now: "2026-09-15T04:01:00Z", id: "two", minutes: 20 })).created, false);
    const active = store.activateAfterInstall("one", "2026-09-15T04:05:00Z", { transitionTaskName: "watch" });
    assert.equal(active.playEndsAt, "2026-09-15T04:20:00.000Z");
    assert.throws(() => store.activateAfterInstall("one", "2026-09-15T04:06:00Z"), /cannot activate/);
    assert.equal(store.get("one").playEndsAt, "2026-09-15T04:20:00.000Z");
    store.setPhase("one", "cooldown", { action: "uninstalled", result: "ok" }, "2026-09-15T04:20:00Z");
    assert.equal(store.listRecentEvents("one")[0].action, "uninstalled");
    assert.equal(store.createPreparing(buildQqRequest({ now: "2026-09-15T04:16:00Z", id: "three", minutes: 20 })).created, false);
    store.setPhase("one", "ready", { action: "cooldown_completed", result: "ok" }, "2026-09-15T05:50:00Z");
    assert.equal(store.createPreparing(buildQqRequest({ now: "2026-09-15T05:50:00Z", id: "four", minutes: 60 })).created, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("failed preparation releases the request lock", () => {
  const { root, sqlitePath } = fixture();
  try {
    const store = createQqSessionStore(sqlitePath);
    store.createPreparing(buildQqRequest({ now: "2026-09-15T04:00:00Z", id: "one", minutes: 10 }));
    store.fail("one", "install failed", "2026-09-15T04:01:00Z");
    assert.equal(store.createPreparing(buildQqRequest({ now: "2026-09-15T04:01:01Z", id: "two", minutes: 10 })).created, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("failed QQ launch after activation does not increase the daily cooldown count", () => {
  const { root, sqlitePath } = fixture();
  try {
    const store = createQqSessionStore(sqlitePath);
    store.createPreparing(buildQqRequest({ now: "2026-09-16T04:00:00Z", id: "failed-launch", minutes: 10 }));
    store.activateAfterInstall("failed-launch", "2026-09-16T04:01:00Z");
    store.setPhase("failed-launch", "failed", { action: "launch_failed", result: "failed" }, "2026-09-16T04:01:01Z");
    store.createPreparing(buildQqRequest({ now: "2026-09-16T04:02:00Z", id: "first-success", minutes: 10 }));
    const firstSuccess = store.activateAfterInstall("first-success", "2026-09-16T04:03:00Z");
    assert.equal(firstSuccess.playEndsAt, "2026-09-16T04:13:00.000Z");
    assert.equal(firstSuccess.cooldownEndsAt, "2026-09-16T05:13:00.000Z");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("installed QQ executable vault persists its protected file record", () => {
  const { root, sqlitePath } = fixture();
  try {
    const store = createQqSessionStore(sqlitePath);
    const saved = store.setInstalledExecutableVault({
      originalPath: "C:\\fixture\\QQ.exe", vaultPath: "C:\\vault\\random.bin",
      sha256: "a".repeat(64), signer: "Fixture Tencent", state: "protected",
      protectedAt: "2026-09-15T04:20:00.000Z", updatedAt: "2026-09-15T04:20:00.000Z",
    });
    assert.equal(saved.state, "protected");
    assert.equal(store.getInstalledExecutableVault().originalPath, "C:\\fixture\\QQ.exe");
    assert.equal(store.getInstalledExecutableVault().vaultPath, "C:\\vault\\random.bin");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
