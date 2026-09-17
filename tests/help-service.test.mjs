import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createPictureHelpService,
  prepareOutboundCopies,
  renderMainMenu,
  renderPluginHelp,
} from "../core/menu/help-service.mjs";

const pythonExecutable = path.join(
  (process.env.LOCALAPPDATA ?? os.tmpdir()),
  "Python",
  "pythoncore-3.14-64",
  "python.exe",
);

function planPlugin(overrides = {}) {
  return {
    manifest: {
      id: "mashirobot-plugin-plan",
      name: "计划",
      version: "1.0.0",
      description: "计划、记录、作息与提醒",
      menuIndex: 1,
      priority: 100,
      enabled: true,
      exactCommands: ["/计划", "/计划详细"],
      ...overrides.manifest,
    },
    module: {
      getHelp: () => ({
        groups: [
          { title: "制定与查询计划", items: ["今日计划", "查询今日计划"] },
          { title: "每日记录", items: ["今日记录", "查询本周记录"] },
          { title: "作息与打卡", items: ["已睡觉", "已打卡"] },
          { title: "提醒", items: ["提醒我 12 点吃饭", "收到"] },
        ],
        detailedGroups: Array.from({ length: 12 }, (_, index) => ({
          title: `详细功能 ${index + 1}`,
          items: Array.from({ length: 7 }, (_, item) => `详细指令 ${index + 1}-${item + 1}`),
        })),
        fallbackText: "计划插件文字帮助",
      }),
    },
  };
}

function registryFor(plugin, failures = []) {
  return { plugins: [plugin], failures };
}

function secondPlugin() {
  return planPlugin({ manifest: {
    id: "mashirobot-plugin-game-timer",
    name: "游戏计时",
    menuIndex: 2,
    priority: 200,
    description: "游戏限时提醒与超时强制退出",
  } });
}

test("reuses one hash-addressed main-menu original and changes hash with the manifest", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mashirobot-help-test-"));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
  const plugin = planPlugin();

  const first = await renderMainMenu(registryFor(plugin), { tempRoot, pythonExecutable });
  const second = await renderMainMenu(registryFor(plugin), { tempRoot, pythonExecutable });
  const changed = await renderMainMenu(
    registryFor(planPlugin({ manifest: { description: "changed description" } })),
    { tempRoot, pythonExecutable },
  );

  assert.equal(first, second);
  assert.notEqual(first, changed);
  assert.match(path.basename(first), /^[a-f0-9]{64}-1\.png$/);
  assert.match(path.basename(path.dirname(first)), /^[a-f0-9]{64}$/);
  assert.ok(existsSync(first));
  assert.ok(existsSync(changed));
  assert.equal(existsSync(path.join(tempRoot, "cache")), false);
});

test("renders detailed plugin help as bounded cached pages", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mashirobot-help-test-"));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));

  const paths = await renderPluginHelp(planPlugin(), {
    detailed: true,
    tempRoot,
    pythonExecutable,
  });

  assert.ok(paths.length >= 2);
  assert.ok(paths.every((item) => existsSync(item)));
  assert.ok(paths.every((item, index) => item.endsWith(`-${index + 1}.png`)));
});

test("creates a unique outbound copy without risking the cached original", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mashirobot-help-test-"));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
  const cached = await renderMainMenu(registryFor(planPlugin()), { tempRoot, pythonExecutable });

  const [first] = prepareOutboundCopies([cached], { tempRoot });
  const [second] = prepareOutboundCopies([cached], { tempRoot });

  assert.notEqual(first, second);
  assert.ok(existsSync(first));
  assert.ok(existsSync(second));
  assert.ok(existsSync(cached));
  rmSync(first);
  assert.ok(existsSync(cached));
});

test("router-facing service returns outbound media and local text fallback", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mashirobot-help-test-"));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
  const plugin = planPlugin();
  const service = createPictureHelpService({ tempRoot, pythonExecutable });

  const menu = await service.renderMainMenu(registryFor(plugin));
  const detail = await service.renderPluginHelp(plugin, { detailed: false });

  assert.equal(menu.handled, true);
  assert.equal(menu.command, "帮助菜单");
  assert.equal(menu.mediaPaths.length, 1);
  assert.match(menu.mediaPaths[0], /[\\/]outbound[\\/]/);
  assert.equal(detail.command, "插件帮助");
  assert.equal(detail.mediaPaths.length, 1);

  const brokenTempRoot = path.join(tempRoot, "broken-renderer");
  const broken = createPictureHelpService({
    tempRoot: brokenTempRoot,
    pythonExecutable: path.join(tempRoot, "missing-python.exe"),
  });
  assert.equal(
    (await broken.renderMainMenu(registryFor(plugin))).reply,
    "1. 计划 — 计划、记录、作息与提醒",
  );
  assert.deepEqual((await broken.renderMainMenu(registryFor(plugin))).mediaPaths, []);
  assert.equal((await broken.renderPluginHelp(plugin, { detailed: true })).reply, "计划插件文字帮助");
});

test("awaits asynchronous plugin help for rendered groups and text fallback", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mashirobot-help-test-"));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
  const plugin = planPlugin();
  plugin.module.getHelp = async () => {
    await Promise.resolve();
    return {
      groups: [{ title: "异步帮助", items: ["异步指令"] }],
      fallbackText: "异步文字帮助",
    };
  };

  const rendered = await renderPluginHelp(plugin, { tempRoot, pythonExecutable });
  assert.equal(rendered.length, 1);
  assert.ok(existsSync(rendered[0]));

  const broken = createPictureHelpService({
    tempRoot: path.join(tempRoot, "broken-async-renderer"),
    pythonExecutable: path.join(tempRoot, "missing-python.exe"),
  });
  const fallback = await broken.renderPluginHelp(plugin);
  assert.equal(fallback.reply, "异步文字帮助");
  assert.deepEqual(fallback.mediaPaths, []);
});

test("falls back to the manifest description when a second getHelp call fails", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mashirobot-help-test-"));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
  const plugin = planPlugin();
  let calls = 0;
  plugin.module.getHelp = async () => {
    calls += 1;
    if (calls > 1) throw new Error("fallback unavailable");
    return { groups: [{ title: "功能", items: ["命令"] }] };
  };
  const broken = createPictureHelpService({
    tempRoot,
    pythonExecutable: path.join(tempRoot, "missing-python.exe"),
  });

  const result = await broken.renderPluginHelp(plugin);
  assert.equal(result.reply, plugin.manifest.description);
  assert.deepEqual(result.mediaPaths, []);
});

test("main help always renders ascending menu indexes", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mashirobot-help-test-"));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
  const ordered = await renderMainMenu(
    { plugins: [secondPlugin(), planPlugin()], failures: [] },
    { tempRoot, pythonExecutable },
  );
  const reversed = await renderMainMenu(
    { plugins: [planPlugin(), secondPlugin()], failures: [] },
    { tempRoot, pythonExecutable },
  );
  assert.equal(ordered, reversed);
});

test("concurrent identical help requests render once and return unique outbound copies", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mashirobot-help-test-"));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
  let starts = 0;
  const runLocalProcess = async ({ args }) => {
    starts += 1;
    const output = args[args.indexOf("--output") + 1];
    const { writeFile } = await import("node:fs/promises");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(output, "fake png bytes");
    return { operationId: "fixture", exitCode: 0, stdout: "", stderr: "", elapsedMs: 20, value: "" };
  };
  const service = createPictureHelpService({ tempRoot, runLocalProcess });

  const [left, right] = await Promise.all([
    service.renderMainMenu(registryFor(planPlugin())),
    service.renderMainMenu(registryFor(planPlugin())),
  ]);
  assert.equal(starts, 1);
  assert.notEqual(left.mediaPaths[0], right.mediaPaths[0]);
  assert.ok(existsSync(left.mediaPaths[0]));
  assert.ok(existsSync(right.mediaPaths[0]));

  const hit = await service.renderMainMenu(registryFor(planPlugin()));
  assert.equal(starts, 1, "a cache hit must not start Python again");
  assert.notEqual(hit.mediaPaths[0], left.mediaPaths[0]);
});

