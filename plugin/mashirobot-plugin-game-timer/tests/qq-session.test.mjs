import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseQqSessionCommand, canStartQqSession, evaluateQqSessionWindow } from "../core/qq-session-parser.mjs";
import { buildQqRequest, activateQqRequest, cooldownMinutesForDailySession, QQ_WINDOW_POLICIES, phaseAt } from "../core/qq-session-model.mjs";
import { createQqSessionStore } from "../core/qq-session-storage.mjs";

function fixture() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "qq-session-")); return { root, sqlitePath: path.join(root, "planner.sqlite") }; }

test("QQ accepts one through sixty minutes in the daily Shanghai window", () => {
  assert.deepEqual(parseQqSessionCommand("玩QQ1分钟"), { kind: "qq-session", minutes: 1 });
  assert.deepEqual(parseQqSessionCommand("玩QQ10分钟"), { kind: "qq-session", minutes: 10 });
  assert.deepEqual(parseQqSessionCommand("玩QQ60分钟"), { kind: "qq-session", minutes: 60 });
  assert.equal(parseQqSessionCommand("玩QQ0分钟"), null);
  assert.equal(parseQqSessionCommand("玩QQ61分钟"), null);
  assert.equal(parseQqSessionCommand("玩QQ1小时"), null);
  for (const date of ["2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-19", "2026-09-20"]) {
    assert.equal(canStartQqSession(new Date(`${date}T04:00:00Z`), 10), true, `${date} must be accepted at noon`);
  }
  assert.equal(canStartQqSession(new Date("2026-09-20T03:59:59Z")), false);
  assert.equal(canStartQqSession(new Date("2026-09-20T04:00:00Z")), true);
  assert.equal(canStartQqSession(new Date("2026-09-20T13:00:00Z"), 60), true);
  assert.equal(canStartQqSession(new Date("2026-09-20T13:50:00Z"), 20), false);
  assert.equal(canStartQqSession(new Date("2026-09-20T14:00:00Z"), 1), false);
});

test("requested play time receives its daily escalating cooldown after installation", () => {
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
    store.createPreparing(buildQqRequest({ now: "2026-09-15T06:24:00Z", id: "three", minutes: 10 }));
    const third = store.activateAfterInstall("three", "2026-09-15T06:25:00Z");
    assert.equal(third.cooldownEndsAt, "2026-09-15T07:55:00.000Z");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("daily cooldown count resets at Shanghai midnight and excludes Sunday special sessions", () => {
  const { root, sqlitePath } = fixture();
  try {
    const store = createQqSessionStore(sqlitePath);
    store.createPreparing(buildQqRequest({ now: "2026-10-11T04:00:00Z", id: "daily-one", minutes: 10 }));
    const first = store.activateAfterInstall("daily-one", "2026-10-11T04:01:00Z");
    assert.equal(first.cooldownEndsAt, "2026-10-11T05:11:00.000Z");
    store.setPhase("daily-one", "cooldown", null, "2026-10-11T04:11:00Z");
    store.setPhase("daily-one", "ready", null, "2026-10-11T05:11:00Z");

    const special = buildQqRequest({
      now: "2026-10-11T05:12:00Z", id: "special", minutes: 240,
      windowPolicy: QQ_WINDOW_POLICIES.SUNDAY_FOUR_HOURS, specialLocalDate: "2026-10-11",
    });
    store.createPreparing(special);
    const specialActive = store.activateAfterInstall("special", "2026-10-11T05:13:00Z");
    assert.equal(specialActive.cooldownEndsAt, "2026-10-11T10:13:00.000Z");
    store.setPhase("special", "cooldown", null, "2026-10-11T09:13:00Z");
    store.setPhase("special", "ready", null, "2026-10-11T10:13:00Z");

    store.createPreparing(buildQqRequest({ now: "2026-10-11T10:14:00Z", id: "daily-two", minutes: 10 }));
    const second = store.activateAfterInstall("daily-two", "2026-10-11T10:15:00Z");
    assert.equal(second.cooldownEndsAt, "2026-10-11T11:35:00.000Z");
    store.setPhase("daily-two", "cooldown", null, "2026-10-11T10:25:00Z");
    store.setPhase("daily-two", "ready", null, "2026-10-11T11:35:00Z");

    store.createPreparing(buildQqRequest({ now: "2026-10-12T04:00:00Z", id: "next-day", minutes: 10 }));
    const reset = store.activateAfterInstall("next-day", "2026-10-12T04:01:00Z");
    assert.equal(reset.cooldownEndsAt, "2026-10-12T05:11:00.000Z");
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

test("failed QQ launch does not increase the next session's daily cooldown", () => {
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

test("stored historical cooldown deadlines remain authoritative", () => {
  const historical = {
    phase: "cooldown",
    playEndsAt: "2026-09-15T04:20:00.000Z",
    cooldownEndsAt: "2026-09-15T05:20:00.000Z",
  };
  assert.equal(phaseAt(historical, "2026-09-15T05:19:59.999Z"), "cooldown");
  assert.equal(phaseAt(historical, "2026-09-15T05:20:00.000Z"), "ready");
});

test("installed QQ executable vault persists its protected file record", () => {
  const { root, sqlitePath } = fixture();
  try {
    const store = createQqSessionStore(sqlitePath);
    const saved = store.setInstalledExecutableVault({
      originalPath: "C:\\fixture\\QQ.exe", vaultPath: "C:\\vault\\random.bin",
      formatVersion: 2, sha256: "a".repeat(64), signer: "Fixture Tencent", state: "protected",
      protectedAt: "2026-09-15T04:20:00.000Z", updatedAt: "2026-09-15T04:20:00.000Z",
    });
    assert.equal(saved.state, "protected");
    assert.equal(store.getInstalledExecutableVault().originalPath, "C:\\fixture\\QQ.exe");
    assert.equal(store.getInstalledExecutableVault().vaultPath, "C:\\vault\\random.bin");
    assert.equal(store.getInstalledExecutableVault().formatVersion, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Sunday four-hour requests truncate at midnight and keep a fixed cooldown", () => {
  const request = buildQqRequest({
    now: "2026-10-11T13:00:00Z",
    id: "sunday-one",
    minutes: 240,
    windowPolicy: QQ_WINDOW_POLICIES.SUNDAY_FOUR_HOURS,
    specialLocalDate: "2026-10-11",
  });
  assert.equal(request.playMinutes, 240);
  assert.equal(request.windowPolicy, "sunday-4h");
  assert.equal(request.specialLocalDate, "2026-10-11");
  assert.throws(() => buildQqRequest({ minutes: 240 }), /window policy|minutes/i);
  const active = activateQqRequest(request, "2026-10-11T13:01:00Z");
  assert.equal(active.playMinutes, 179);
  assert.equal(active.playEndsAt, "2026-10-11T16:00:00.000Z");
  assert.equal(active.cooldownEndsAt, "2026-10-11T17:00:00.000Z");
});

test("Sunday command is capped at Shanghai midnight", () => {
  const command = parseQqSessionCommand("周末玩QQ4h");
  assert.deepEqual(command, { kind: "qq-session", minutes: 240, windowPolicy: "sunday-4h" });
  assert.deepEqual(parseQqSessionCommand("周末玩QQ 4H"), command);
  assert.equal(evaluateQqSessionWindow(new Date("2026-10-11T12:00:00Z"), command).playMinutes, 240);
  assert.equal(evaluateQqSessionWindow(new Date("2026-10-11T13:00:00Z"), command).playMinutes, 180);
  assert.equal(evaluateQqSessionWindow(new Date("2026-10-11T15:59:00Z"), command).playMinutes, 1);
  assert.equal(evaluateQqSessionWindow(new Date("2026-10-11T15:59:59Z"), command).localDate, "2026-10-11");
  assert.equal(evaluateQqSessionWindow(new Date("2026-10-11T15:59:59Z"), command).reason, "sunday-ended");
  assert.equal(evaluateQqSessionWindow(new Date("2026-10-11T16:00:00Z"), command).reason, "not-sunday");
  assert.equal(evaluateQqSessionWindow(new Date("2026-10-10T13:00:00Z"), command).reason, "not-sunday");
});

test("Sunday allowance is consumed only after a verified start and only once per local date", () => {
  const { root, sqlitePath } = fixture();
  try {
    const store = createQqSessionStore(sqlitePath);
    const firstRequest = buildQqRequest({
      now: "2026-10-11T13:00:00Z", id: "sunday-one", minutes: 240,
      windowPolicy: QQ_WINDOW_POLICIES.SUNDAY_FOUR_HOURS, specialLocalDate: "2026-10-11",
    });
    assert.equal(store.createPreparing(firstRequest).created, true);
    const active = store.activateAfterInstall("sunday-one", "2026-10-11T13:01:00Z");
    assert.equal(active.specialConsumedAt, null);
    const consumed = store.consumeSundayAllowance("sunday-one", "2026-10-11T13:01:05Z");
    assert.equal(consumed.specialConsumedAt, "2026-10-11T13:01:05.000Z");
    store.setPhase("sunday-one", "cooldown", null, "2026-10-11T16:00:00Z");
    store.setPhase("sunday-one", "ready", null, "2026-10-11T17:00:00Z");

    const secondRequest = buildQqRequest({
      now: "2026-10-11T18:02:00Z", id: "sunday-two", minutes: 240,
      windowPolicy: QQ_WINDOW_POLICIES.SUNDAY_FOUR_HOURS, specialLocalDate: "2026-10-11",
    });
    const second = store.createPreparing(secondRequest);
    assert.equal(second.created, false);
    assert.equal(second.reason, "sunday-limit");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("failed Sunday launch before consumption permits one retry", () => {
  const { root, sqlitePath } = fixture();
  try {
    const store = createQqSessionStore(sqlitePath);
    const request = (id, at) => buildQqRequest({
      now: at, id, minutes: 240,
      windowPolicy: QQ_WINDOW_POLICIES.SUNDAY_FOUR_HOURS, specialLocalDate: "2026-10-11",
    });
    assert.equal(store.createPreparing(request("failed", "2026-10-11T04:00:00Z")).created, true);
    store.activateAfterInstall("failed", "2026-10-11T04:01:00Z");
    store.setPhase("failed", "failed", { action: "launch_failed", result: "failed" }, "2026-10-11T04:01:01Z");
    assert.equal(store.createPreparing(request("retry", "2026-10-11T04:02:00Z")).created, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
