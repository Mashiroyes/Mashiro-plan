import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { normalizePluginResult } from "../core/contracts/plugin-result.mjs";
import { loadPlugins } from "../core/loader/plugin-loader.mjs";
import { appendMashiroLog, flushMashiroLogs } from "../core/logging/logger.mjs";

const VALID_MODULE = `
export function match() { return false; }
export function handle() { return { handled: true, command: "fixture" }; }
export function healthCheck() { return { ok: true }; }
export function getHelp() { return { groups: [], fallbackText: "fixture" }; }
`;

function validManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "mashirobot-plugin-plan",
    name: "计划",
    version: "1.0.0",
    description: "计划、记录、作息与提醒",
    menuIndex: 1,
    priority: 100,
    enabled: true,
    entry: "index.mjs",
    exactCommands: ["/计划", "/计划详细"],
    ...overrides,
  };
}

async function createFixture(t) {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "mashirobot-loader-"));
  t.after(async () => rm(fixtureRoot, { recursive: true, force: true }));
  return fixtureRoot;
}

async function writePlugin(pluginRoot, options = {}) {
  const directoryName = options.directoryName ?? options.manifest?.id ?? "mashirobot-plugin-plan";
  const pluginDirectory = path.join(pluginRoot, directoryName);
  const manifest = validManifest({ id: directoryName, ...options.manifest });
  await mkdir(pluginDirectory, { recursive: true });
  await writeFile(path.join(pluginDirectory, "plugin.json"), JSON.stringify(manifest, null, 2), "utf8");
  if (options.writeEntry !== false) {
    const entryPath = path.resolve(pluginDirectory, manifest.entry);
    if (entryPath.startsWith(pluginDirectory + path.sep)) {
      await mkdir(path.dirname(entryPath), { recursive: true });
      await writeFile(entryPath, options.moduleSource ?? VALID_MODULE, "utf8");
    }
  }
  if (options.writeReadme !== false) {
    await writeFile(path.join(pluginDirectory, "README.md"), `# ${manifest.name}\n`, "utf8");
  }
  return pluginDirectory;
}

test("loads one valid plugin and indexes it by menu number and exact command", async (t) => {
  const fixtureRoot = await createFixture(t);
  await writePlugin(fixtureRoot);
  const logs = [];

  const registry = await loadPlugins({ pluginRoot: fixtureRoot, logger: (entry) => logs.push(entry) });

  assert.equal(registry.plugins.length, 1);
  assert.equal(registry.plugins[0].manifest.id, "mashirobot-plugin-plan");
  assert.equal(registry.byMenuIndex.get(1).manifest.id, "mashirobot-plugin-plan");
  assert.equal(registry.byExactCommand.get("/计划详细").manifest.id, "mashirobot-plugin-plan");
  assert.deepEqual(registry.failures, []);
  assert.equal(logs.some((entry) => entry.event === "plugin_loaded"), true);
});

test("does not import or expose a disabled plugin", async (t) => {
  const fixtureRoot = await createFixture(t);
  await writePlugin(fixtureRoot, {
    manifest: { enabled: false },
    moduleSource: `throw new Error("disabled plugin must not be imported");`,
  });

  const registry = await loadPlugins({ pluginRoot: fixtureRoot, logger: () => {} });

  assert.deepEqual(registry.plugins, []);
  assert.equal(registry.byMenuIndex.size, 0);
  assert.equal(registry.byExactCommand.size, 0);
  assert.deepEqual(registry.failures, []);
});

test("rejects a directory and manifest ID mismatch", async (t) => {
  const fixtureRoot = await createFixture(t);
  await writePlugin(fixtureRoot, {
    directoryName: "mashirobot-plugin-wrong-directory",
    manifest: { id: "mashirobot-plugin-plan" },
  });

  const registry = await loadPlugins({ pluginRoot: fixtureRoot, logger: () => {} });

  assert.equal(registry.plugins.length, 0);
  assert.equal(registry.failures.some((failure) => failure.code === "DIRECTORY_ID_MISMATCH"), true);
});

test("rejects an entry path that escapes the plugin directory", async (t) => {
  const fixtureRoot = await createFixture(t);
  await writeFile(path.join(fixtureRoot, "outside.mjs"), VALID_MODULE, "utf8");
  await writePlugin(fixtureRoot, {
    manifest: { entry: "../outside.mjs" },
    writeEntry: false,
  });

  const registry = await loadPlugins({ pluginRoot: fixtureRoot, logger: () => {} });

  assert.equal(registry.plugins.length, 0);
  assert.equal(registry.failures.some((failure) => failure.code === "ENTRY_PATH_TRAVERSAL"), true);
});

test("keeps the first priority-ordered plugin when menu numbers conflict", async (t) => {
  const fixtureRoot = await createFixture(t);
  await writePlugin(fixtureRoot, {
    directoryName: "mashirobot-plugin-plan",
    manifest: { menuIndex: 1, priority: 100, exactCommands: ["/计划"] },
  });
  await writePlugin(fixtureRoot, {
    directoryName: "mashirobot-plugin-other",
    manifest: { menuIndex: 1, priority: 10, exactCommands: ["/其他"] },
  });

  const registry = await loadPlugins({ pluginRoot: fixtureRoot, logger: () => {} });

  assert.deepEqual(registry.plugins.map((plugin) => plugin.manifest.id), ["mashirobot-plugin-plan"]);
  assert.equal(registry.byMenuIndex.get(1).manifest.id, "mashirobot-plugin-plan");
  assert.equal(registry.failures.some((failure) => failure.code === "DUPLICATE_MENU_INDEX"), true);
});

test("does not partially load a plugin whose exact command conflicts", async (t) => {
  const fixtureRoot = await createFixture(t);
  await writePlugin(fixtureRoot, {
    directoryName: "mashirobot-plugin-plan",
    manifest: { menuIndex: 1, priority: 100, exactCommands: ["/计划"] },
  });
  await writePlugin(fixtureRoot, {
    directoryName: "mashirobot-plugin-other",
    manifest: { menuIndex: 2, priority: 50, exactCommands: ["/计划", "/其他"] },
  });

  const registry = await loadPlugins({ pluginRoot: fixtureRoot, logger: () => {} });

  assert.deepEqual(registry.plugins.map((plugin) => plugin.manifest.id), ["mashirobot-plugin-plan"]);
  assert.equal(registry.byMenuIndex.has(2), false);
  assert.equal(registry.byExactCommand.has("/其他"), false);
  assert.equal(registry.failures.some((failure) => failure.code === "DUPLICATE_EXACT_COMMAND"), true);
});

for (const reservedCommand of ["help", "/help", "帮助"]) {
  test(`rejects reserved exact command ${reservedCommand}`, async (t) => {
    const fixtureRoot = await createFixture(t);
    await writePlugin(fixtureRoot, { manifest: { exactCommands: [reservedCommand] } });

    const registry = await loadPlugins({ pluginRoot: fixtureRoot, logger: () => {} });

    assert.equal(registry.plugins.length, 0);
    assert.equal(registry.failures.some((failure) => failure.code === "RESERVED_EXACT_COMMAND"), true);
  });
}

test("orders plugins by descending priority and then stable plugin ID", async (t) => {
  const fixtureRoot = await createFixture(t);
  await writePlugin(fixtureRoot, {
    directoryName: "mashirobot-plugin-zeta",
    manifest: { menuIndex: 3, priority: 100, exactCommands: ["/zeta"] },
  });
  await writePlugin(fixtureRoot, {
    directoryName: "mashirobot-plugin-alpha",
    manifest: { menuIndex: 1, priority: 100, exactCommands: ["/alpha"] },
  });
  await writePlugin(fixtureRoot, {
    directoryName: "mashirobot-plugin-beta",
    manifest: { menuIndex: 2, priority: 20, exactCommands: ["/beta"] },
  });

  const registry = await loadPlugins({ pluginRoot: fixtureRoot, logger: () => {} });

  assert.deepEqual(
    registry.plugins.map((plugin) => plugin.manifest.id),
    ["mashirobot-plugin-alpha", "mashirobot-plugin-zeta", "mashirobot-plugin-beta"],
  );
});

test("rejects malformed required manifest fields and missing plugin files", async (t) => {
  const cases = [
    ["schema", { schemaVersion: 2 }, "INVALID_MANIFEST"],
    ["name", { name: "" }, "INVALID_MANIFEST"],
    ["version", { version: null }, "INVALID_MANIFEST"],
    ["description", { description: 10 }, "INVALID_MANIFEST"],
    ["menu", { menuIndex: 0 }, "INVALID_MANIFEST"],
    ["priority", { priority: Number.NaN }, "INVALID_MANIFEST"],
    ["enabled", { enabled: "yes" }, "INVALID_MANIFEST"],
    ["entry", { entry: "" }, "INVALID_MANIFEST"],
    ["commands", { exactCommands: "/计划" }, "INVALID_MANIFEST"],
    ["trimmed-command", { exactCommands: [" /计划"] }, "INVALID_MANIFEST"],
  ];

  for (const [label, manifest, expectedCode] of cases) {
    await t.test(label, async (subtest) => {
      const fixtureRoot = await createFixture(subtest);
      await writePlugin(fixtureRoot, { manifest });
      const registry = await loadPlugins({ pluginRoot: fixtureRoot, logger: () => {} });
      assert.equal(registry.plugins.length, 0);
      assert.equal(registry.failures.some((failure) => failure.code === expectedCode), true);
    });
  }

  await t.test("missing README", async (subtest) => {
    const fixtureRoot = await createFixture(subtest);
    await writePlugin(fixtureRoot, { writeReadme: false });
    const registry = await loadPlugins({ pluginRoot: fixtureRoot, logger: () => {} });
    assert.equal(registry.failures.some((failure) => failure.code === "MISSING_PLUGIN_README"), true);
  });

  await t.test("missing entry", async (subtest) => {
    const fixtureRoot = await createFixture(subtest);
    await writePlugin(fixtureRoot, { writeEntry: false });
    const registry = await loadPlugins({ pluginRoot: fixtureRoot, logger: () => {} });
    assert.equal(registry.failures.some((failure) => failure.code === "PLUGIN_ENTRY_LOAD_ERROR"), true);
  });
});

test("accepts asynchronous plugin contract functions without weakening export validation", async (t) => {
  const fixtureRoot = await createFixture(t);
  await writePlugin(fixtureRoot, {
    moduleSource: `
      export async function match() { return false; }
      export async function handle() { return { handled: true }; }
      export async function healthCheck() { return { ok: true }; }
      export async function getHelp() { return {}; }
    `,
  });

  const registry = await loadPlugins({ pluginRoot: fixtureRoot, logger: () => {} });

  assert.equal(registry.plugins.length, 1);
  assert.deepEqual(registry.failures, []);
  assert.deepEqual(await registry.plugins[0].module.handle(), { handled: true });
});

test("still rejects a plugin missing a required callable export", async (t) => {
  const fixtureRoot = await createFixture(t);
  await writePlugin(fixtureRoot, {
    moduleSource: `
      export function match() { return false; }
      export const handle = 42;
      export function healthCheck() { return { ok: true }; }
      export function getHelp() { return {}; }
    `,
  });

  const registry = await loadPlugins({ pluginRoot: fixtureRoot, logger: () => {} });

  assert.equal(registry.plugins.length, 0);
  assert.equal(registry.failures.some((failure) => failure.code === "INVALID_PLUGIN_MODULE"), true);
});

test("normalizes a valid handled result and rejects unhandled values", () => {
  assert.deepEqual(
    normalizePluginResult(
      { handled: true, command: 42, reply: 7, mediaPaths: ["one.png", 2] },
      "mashirobot-plugin-plan",
    ),
    { handled: true, command: "42", reply: "7", mediaPaths: ["one.png", "2"] },
  );
  assert.deepEqual(normalizePluginResult({ handled: true }, "mashirobot-plugin-plan"), {
    handled: true,
    command: "mashirobot-plugin-plan",
    reply: "",
    mediaPaths: [],
  });
  assert.throws(
    () => normalizePluginResult({ handled: false }, "mashirobot-plugin-plan"),
    /Invalid result from mashirobot-plugin-plan/,
  );
});

test("appends one structured JSON log line under the OpenClaw log directory", async (t) => {
  const fakeProfile = await mkdtemp(path.join(os.tmpdir(), "mashirobot-profile-"));
  t.after(async () => rm(fakeProfile, { recursive: true, force: true }));
  const previousProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = fakeProfile;
  t.after(() => {
    if (previousProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousProfile;
  });

  appendMashiroLog({
    level: "info",
    pluginId: "mashirobot-plugin-plan",
    event: "fixture",
    message: "loaded",
  });
  await flushMashiroLogs();

  const logPath = path.join(fakeProfile, ".openclaw", "logs", "mashirobot.log");
  const lines = (await readFile(logPath, "utf8")).trim().split(/\r?\n/);
  assert.equal(lines.length, 1);
  const payload = JSON.parse(lines[0]);
  assert.equal(payload.level, "info");
  assert.equal(payload.pluginId, "mashirobot-plugin-plan");
  assert.equal(payload.event, "fixture");
  assert.equal(payload.message, "loaded");
  assert.match(payload.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(payload.requestId, "");
  assert.equal(payload.elapsedMs, 0);
  assert.equal(payload.externalElapsedMs, 0);
});

test("logging failures are contained and later writes still succeed", async (t) => {
  const fakeProfile = await mkdtemp(path.join(os.tmpdir(), "mashirobot-profile-"));
  t.after(async () => rm(fakeProfile, { recursive: true, force: true }));
  const previousProfile = process.env.USERPROFILE;
  process.env.USERPROFILE = path.join(fakeProfile, "profile-file");
  await writeFile(process.env.USERPROFILE, "not a directory", "utf8");
  t.after(() => {
    if (previousProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousProfile;
  });

  await assert.doesNotReject(async () => {
    appendMashiroLog({ event: "expected_write_failure" });
    await flushMashiroLogs();
  });

  process.env.USERPROFILE = fakeProfile;
  appendMashiroLog({ event: "recovered" });
  await flushMashiroLogs();
  const logPath = path.join(fakeProfile, ".openclaw", "logs", "mashirobot.log");
  assert.match(await readFile(logPath, "utf8"), /"event":"recovered"/);
});
