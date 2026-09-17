import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGameVaultStore } from "../core/game-vault-storage.mjs";

test("vault queue is replay-safe and blocks the same game", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "game-vault-store-"));
  try {
    const store = createGameVaultStore(path.join(root, "test.sqlite"));
    const task = { id: "t1", gameKey: "g1", displayName: "Game", executablePath: "D:\\Games\\game.exe" };
    const first = store.queue(task, new Date("2026-09-15T04:00:00Z"));
    const replay = store.queue(task, new Date("2026-09-15T04:01:00Z"));
    assert.equal(first.id, replay.id);
    assert.equal(store.listOpen().length, 1);
    assert.equal(store.hasProtectedGame("g1")?.taskId, "t1");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
