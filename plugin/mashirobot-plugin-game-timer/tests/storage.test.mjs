import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildTask } from "../core/timer-manager.mjs";
import { createGameTimerStore } from "../core/storage.mjs";

const game = {
  key: "dst",
  displayName: "饥荒联机版",
  processName: "dontstarve_steam_x64.exe",
  executablePath: "E:\\Games\\dontstarve_steam_x64.exe",
};

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "game-timer-"));
  return { root, sqlitePath: path.join(root, "planner.sqlite") };
}

test("build deterministic reminder force and lock times", () => {
  const task = buildTask({
    game, minutes: 15, forceAfter: 5,
    now: new Date("2026-08-05T01:00:00.000Z"), id: "one",
  });
  assert.equal(task.reminderAt, "2026-08-05T01:15:00.000Z");
  assert.equal(task.forceAt, "2026-08-05T01:20:00.000Z");
  assert.equal(task.lockUntil, "2026-08-05T01:30:00.000Z");
  assert.equal("priority" in task, false);
});

test("persist lock across stores and release exactly at expiry", () => {
  const { root, sqlitePath } = fixture();
  try {
    const now = new Date("2026-08-05T01:00:00.000Z");
    const task = buildTask({ game, minutes: 15, forceAfter: 5, now, id: "one" });
    const first = createGameTimerStore(sqlitePath).createPending(task);
    assert.equal(first.created, true);
    assert.equal("priority" in createGameTimerStore(sqlitePath).get("one"), false);
    const reopened = createGameTimerStore(sqlitePath);
    assert.equal(reopened.getActiveByExecutable(task.executableKey, new Date("2026-08-05T01:29:59Z"))?.id, "one");
    assert.equal(reopened.getActiveByExecutable(task.executableKey, new Date(task.lockUntil)), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("same executable cannot replace active timer while another executable can", () => {
  const { root, sqlitePath } = fixture();
  try {
    const now = new Date("2026-08-05T01:00:00.000Z");
    const store = createGameTimerStore(sqlitePath);
    const first = buildTask({ game, minutes: 15, forceAfter: 5, now, id: "one" });
    assert.equal(store.createPending(first).created, true);
    const alias = buildTask({ game: { ...game, displayName: "饥荒" }, minutes: 1, forceAfter: 1, now, id: "two" });
    assert.equal(store.createPending(alias).created, false);
    const other = buildTask({ game: {
      ...game, key: "other", displayName: "其他", processName: "other.exe",
      executablePath: "E:\\Games\\other.exe",
    }, minutes: 1, forceAfter: 1, now, id: "three" });
    assert.equal(store.createPending(other).created, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("failed task releases lock", () => {
  const { root, sqlitePath } = fixture();
  try {
    const now = new Date("2026-08-05T01:00:00.000Z");
    const store = createGameTimerStore(sqlitePath);
    const first = buildTask({ game, minutes: 15, forceAfter: 5, now, id: "one" });
    store.createPending(first);
    store.fail(first.id, "schedule failed", now.toISOString());
    const next = buildTask({ game, minutes: 1, forceAfter: 1, now, id: "two" });
    assert.equal(store.createPending(next).created, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
