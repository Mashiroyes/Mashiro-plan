import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadCommandConfig } from "../core/config/command-config.mjs";

test("loads the checked-in YAML registry and normalizes aliases", () => {
  const config = loadCommandConfig(path.resolve("."));
  assert.ok(config.commands.length >= 19);
  assert.equal(config.normalize("status"), "状态");
  assert.equal(config.normalize("/状态详细"), "/状态详细");
  assert.equal(config.normalize("玩QQ 5分钟"), "玩QQ 5分钟");
  assert.equal(Object.isFrozen(config), true);
  assert.equal(Object.isFrozen(config.get("status.status")), true);
});

test("rejects duplicate aliases with a useful startup error", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mashiro-command-config-"));
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, "commands.yaml"), "version: 1\ncommands:\n  - id: one\n    plugin: p\n    names: [same]\n  - id: two\n    plugin: p\n    names: [same]\n", "utf8");
  try {
    assert.throws(() => loadCommandConfig(root), /same is used by one and two/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
