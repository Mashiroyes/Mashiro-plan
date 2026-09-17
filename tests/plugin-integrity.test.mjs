import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const testRoot = path.dirname(fileURLToPath(import.meta.url));
const tool = path.resolve(testRoot, "..", "tools", "plugin-integrity.ps1");

function execPwsh(args) {
  return execFileAsync("pwsh.exe", ["-NoProfile", "-File", ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
}

test("integrity snapshot is deterministic and contains only stable fields", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "plugin-integrity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plugin = path.join(root, "plugin");
  const firstSnapshot = path.join(root, "first.json");
  const secondSnapshot = path.join(root, "second.json");
  await mkdir(path.join(plugin, "nested"), { recursive: true });
  await writeFile(path.join(plugin, "z.txt"), "z\n");
  await writeFile(path.join(plugin, "nested", "a.txt"), "a\n");

  await execPwsh([tool, "-Mode", "Snapshot", "-PluginPath", plugin, "-SnapshotPath", firstSnapshot]);
  await execPwsh([tool, "-Mode", "Snapshot", "-PluginPath", plugin, "-SnapshotPath", secondSnapshot]);

  const firstBytes = await readFile(firstSnapshot, "utf8");
  const secondBytes = await readFile(secondSnapshot, "utf8");
  assert.equal(firstBytes, secondBytes);
  const rows = JSON.parse(firstBytes);
  assert.deepEqual(rows.map((row) => row.path), ["nested/a.txt", "z.txt"]);
  assert.deepEqual(Object.keys(rows[0]), ["path", "size", "sha256"]);
  assert.match(rows[0].sha256, /^[a-f0-9]{64}$/u);
});

test("integrity comparison detects changed bytes and names the path", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "plugin-integrity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = path.join(root, "snapshot.json");
  const plugin = path.join(root, "plugin");
  await mkdir(plugin);
  await writeFile(path.join(plugin, "index.mjs"), "export const value = 1;\n");
  await execPwsh([tool, "-Mode", "Snapshot", "-PluginPath", plugin, "-SnapshotPath", snapshot]);
  await writeFile(path.join(plugin, "index.mjs"), "export const value = 2;\n");

  await assert.rejects(
    execPwsh([tool, "-Mode", "Compare", "-PluginPath", plugin, "-SnapshotPath", snapshot]),
    (error) => error.code === 2 && /index\.mjs/u.test(`${error.stderr}\n${error.stdout}`),
  );
});

test("integrity comparison reports added and removed files", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "plugin-integrity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = path.join(root, "snapshot.json");
  const plugin = path.join(root, "plugin");
  await mkdir(plugin);
  await writeFile(path.join(plugin, "removed.txt"), "old\n");
  await execPwsh([tool, "-Mode", "Snapshot", "-PluginPath", plugin, "-SnapshotPath", snapshot]);
  await rm(path.join(plugin, "removed.txt"));
  await writeFile(path.join(plugin, "added.txt"), "new\n");

  await assert.rejects(
    execPwsh([tool, "-Mode", "Compare", "-PluginPath", plugin, "-SnapshotPath", snapshot]),
    (error) => {
      const output = `${error.stderr}\n${error.stdout}`;
      return error.code === 2 && /added\.txt/u.test(output) && /removed\.txt/u.test(output);
    },
  );
});
