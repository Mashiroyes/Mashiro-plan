import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectDeploymentIdentity } from "../core/health/deployment-identity.mjs";

test("reports optional Git and runtime metadata without making either required", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mashiro-identity-"));
  const runtime = path.join(root, "runtime");
  mkdirSync(path.join(root, ".git", "refs", "heads"), { recursive: true });
  mkdirSync(runtime, { recursive: true });
  writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFileSync(path.join(root, ".git", "refs", "heads", "main"), `${"a".repeat(40)}\n`);
  writeFileSync(path.join(runtime, "runtime-commit.txt"), `${"b".repeat(40)}\n`);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const identity = collectDeploymentIdentity({ planRoot: root, sqlitePath: path.join(root, "db.sqlite"), env: { LOCALAPPDATA: root, MASHIROBOT_RUNTIME_ROOT: runtime }, startedAt: "2026-09-22T00:00:00.000Z" });
  assert.equal(identity.sourceCommit, "a".repeat(40));
  assert.equal(identity.runtimeCommit, "b".repeat(40));
  assert.equal(identity.runtimeVersion, "unknown");
});
