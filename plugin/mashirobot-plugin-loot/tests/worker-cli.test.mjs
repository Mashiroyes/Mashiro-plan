import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runWorkerCli } from "../core/worker-cli.mjs";
import { closeAllLootStores, createLootStore } from "../core/store.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mashirobot-loot-worker-"));
  t.after(() => {
    closeAllLootStores();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return path.join(root, "planner.sqlite");
}

function run(sqlite, action, now) {
  return runWorkerCli(["--sqlite", sqlite, "--action", action, "--now", now]);
}

test("enforces the evening 21:00 through 22:00 window", (t) => {
  const sqlite = fixture(t);
  assert.equal(run(sqlite, "evening", "2026-08-18T20:59:00+08:00").reason, "outside-evening-window");
  assert.equal(run(sqlite, "evening", "2026-08-18T21:00:00+08:00").action, "send");
  assert.equal(run(sqlite, "evening", "2026-08-18T22:00:00+08:00").action, "send");
  assert.equal(run(sqlite, "evening", "2026-08-18T22:01:00+08:00").reason, "outside-evening-window");
  createLootStore(sqlite).save("2026-08-18", "今天的记录", new Date("2026-08-18T14:00:00Z"));
  assert.equal(run(sqlite, "evening", "2026-08-18T21:30:00+08:00").reason, "already-recorded");
});

test("replays only the previous Shanghai date in the morning", (t) => {
  const sqlite = fixture(t);
  createLootStore(sqlite).save("2026-08-17", "前一天\n原始记录", new Date("2026-08-17T14:00:00Z"));
  const result = run(sqlite, "morning", "2026-08-18T10:00:00+08:00");
  assert.equal(result.action, "send");
  assert.match(result.message, /2026年8月17日的爽点/);
  assert.match(result.message, /前一天\n原始记录/);
  assert.equal(run(sqlite, "morning", "2026-08-19T10:00:00+08:00").reason, "no-previous-record");
});
