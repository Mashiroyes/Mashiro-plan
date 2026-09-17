import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { handle } from "../index.mjs";

test("game scheduling yields while the external scheduler is pending", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "game-nonblocking-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executablePath = path.join(root, "game.exe");
  fs.copyFileSync(path.join(process.env.SystemRoot, "System32", "cmd.exe"), executablePath);
  const config = path.join(root, "games.json");
  fs.writeFileSync(config, JSON.stringify({ games: [{ key: "game", displayName: "Game", executablePath, processName: "game.exe" }] }));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const context = {
    gameTimerConfigPath: config,
    sqlitePath: path.join(root, "planner.sqlite"),
    now: new Date("2026-09-16T12:00:00+08:00"),
    gameTimerScheduler: {
      async schedule() { await gate; return { reminderTaskName: "reminder", forceTaskName: "force" }; },
      async remove() { return { ok: true }; },
    },
  };
  let concurrent = false;
  const pending = handle("玩Game 10分钟", context);
  await Promise.resolve().then(() => { concurrent = true; });
  assert.equal(concurrent, true);
  release();
  assert.match((await pending).reply, /已设置 Game/u);
});
