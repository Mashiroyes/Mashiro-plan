import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createMashiroBotContext } from "../core/bridge/context.mjs";
import { createMenuSessionStore } from "../core/menu/menu-session.mjs";
import { createPluginRouter } from "../core/router/plugin-router.mjs";

function plugin({
  id,
  menuIndex,
  priority = 100,
  exactCommands = [],
  match = () => false,
  handle = () => ({ handled: true, command: id, reply: id }),
  getHelp = () => ({ groups: [], fallbackText: `${id} help` }),
}) {
  return {
    manifest: {
      id,
      name: id,
      description: `${id} description`,
      menuIndex,
      priority,
      exactCommands,
    },
    module: {
      match,
      handle,
      getHelp,
      healthCheck: () => ({ ok: true }),
    },
  };
}

function registryFor(plugins) {
  return {
    plugins,
    byMenuIndex: new Map(plugins.map((item) => [item.manifest.menuIndex, item])),
    byExactCommand: new Map(
      plugins.flatMap((item) =>
        item.manifest.exactCommands.map((command) => [command, item]),
      ),
    ),
    failures: [],
  };
}

test("routes shared system commands before plugins", async () => {
  let pluginMatched = false;
  const localPlugin = plugin({ id: "local", menuIndex: 1, match: () => { pluginMatched = true; return true; } });
  const route = createPluginRouter({
    registry: registryFor([localPlugin]),
    planRoot: path.resolve(import.meta.dirname, ".."),
    systemRouter: async (text) => text === "数据库自检" ? { handled: true, command: "数据库自检", reply: "正常", mediaPaths: [] } : null,
  });
  const result = await route("数据库自检", { accountId: "a", conversationId: "c" });
  assert.equal(result.command, "数据库自检");
  assert.equal(pluginMatched, false);
});

test("routes a system command before global and scoped help", async () => {
  const localPlugin = plugin({ id: "mashirobot-plugin-plan", menuIndex: 1 });
  const route = createPluginRouter({
    registry: registryFor([localPlugin]),
    planRoot: path.resolve(import.meta.dirname, ".."),
    systemRouter: async (text) => ["帮助", "提醒帮助"].includes(text)
      ? { handled: true, command: "系统优先", reply: text, mediaPaths: [] }
      : null,
  });

  assert.equal((await route("帮助", { accountId: "a", conversationId: "c" })).command, "系统优先");
  assert.equal((await route("提醒帮助", { accountId: "a", conversationId: "c" })).command, "系统优先");
});

test("routes scoped help aliases without opening the numbered menu", async () => {
  const plugins = [
    plugin({ id: "mashirobot-plugin-plan", menuIndex: 1 }),
    plugin({ id: "mashirobot-plugin-game-timer", menuIndex: 2 }),
    plugin({ id: "mashirobot-plugin-language", menuIndex: 5 }),
  ];
  const route = createPluginRouter({
    registry: registryFor(plugins), planRoot: path.resolve(import.meta.dirname, ".."),
    helpService: { renderPluginHelp: (selected) => ({ handled: true, command: "插件帮助", reply: selected.manifest.id, mediaPaths: [] }), renderMainMenu: () => ({ handled: true, command: "帮助菜单", reply: "menu", mediaPaths: [] }) },
  });
  assert.equal((await route("提醒帮助")).reply, "mashirobot-plugin-plan");
  assert.equal((await route("游戏帮助")).reply, "mashirobot-plugin-game-timer");
  assert.equal((await route("禁止帮助")).reply, "mashirobot-plugin-game-timer");
  assert.equal((await route("英语帮助")).reply, "mashirobot-plugin-language");
});

function createFixture(overrides = {}) {
  let clock = 1_000_000;
  const planPlugin = plugin({
    id: "mashirobot-plugin-plan",
    menuIndex: 1,
    exactCommands: ["/计划", "/计划详细"],
    match: (message) => message === "今天计划",
    handle: (message, context) => ({
      handled: true,
      command: message,
      reply: `${context.accountId}:${message}`,
    }),
  });
  const registry = registryFor([planPlugin]);
  const sessions = createMenuSessionStore({ now: () => clock });
  const helpService = {
    renderMainMenu: (currentRegistry) => ({
      handled: true,
      command: "帮助菜单",
      reply: currentRegistry.plugins.map((item) => item.manifest.name).join(","),
      mediaPaths: [],
    }),
    renderPluginHelp: (selectedPlugin, { detailed }) => ({
      handled: true,
      command: detailed ? "插件详细帮助" : "插件帮助",
      reply: `${selectedPlugin.manifest.id}:${detailed}`,
      mediaPaths: [],
    }),
  };
  const route = createPluginRouter({ registry, menuSessions: sessions, helpService });
  const context = {
    accountId: "account-a",
    conversationId: "peer-a",
    now: new Date("2026-08-03T12:00:00+08:00"),
    planRoot: path.join(os.tmpdir(), "mashirobot-plan"),
    ...overrides.context,
  };
  return {
    context,
    helpService,
    planPlugin,
    registry,
    route,
    sessions,
    advance(milliseconds) {
      clock += milliseconds;
    },
  };
}

for (const alias of ["help", "/help", "帮助"]) {
  test(`opens the global menu for the exact help alias ${alias}`, async () => {
    const fixture = createFixture();

    const result = await fixture.route(`  ${alias}  `, fixture.context);

    assert.equal(result.handled, true);
    assert.equal(result.command, "帮助菜单");
    assert.equal(fixture.sessions.get("account-a\0peer-a").active, true);
  });
}

test("keeps a menu active at 34,999 ms and expires it at 35,000 ms", () => {
  const fixture = createFixture();
  fixture.sessions.open("account-a\0peer-a");

  fixture.advance(34_999);
  assert.equal(fixture.sessions.get("account-a\0peer-a").active, true);

  fixture.advance(1);
  assert.equal(fixture.sessions.get("account-a\0peer-a"), null);
});

test("handles an invalid positive menu number locally without extending the TTL", async () => {
  const fixture = createFixture();
  await fixture.route("help", fixture.context);
  fixture.advance(20_000);

  const invalid = await fixture.route("9", fixture.context);

  assert.equal(invalid.handled, true);
  assert.equal(invalid.command, "帮助菜单");
  assert.match(invalid.reply, /可用编号：1/);
  fixture.advance(15_000);
  assert.equal(fixture.sessions.get("account-a\0peer-a"), null);
});

test("successful numeric selection renders plugin help and clears the session", async () => {
  const fixture = createFixture();
  await fixture.route("help", fixture.context);

  const result = await fixture.route("1", fixture.context);

  assert.equal(result.handled, true);
  assert.equal(result.command, "插件帮助");
  assert.equal(result.reply, "mashirobot-plugin-plan:false");
  assert.equal(fixture.sessions.get("account-a\0peer-a"), null);
});

test("does not share menu state between conversations", async () => {
  const fixture = createFixture();
  await fixture.route("help", fixture.context);

  assert.equal(
    await fixture.route("1", { ...fixture.context, conversationId: "peer-b" }),
    null,
  );
  assert.equal(fixture.sessions.get("account-a\0peer-a").active, true);
});

test("only a positive integer is treated as a menu selection", async () => {
  const fixture = createFixture();
  await fixture.route("help", fixture.context);

  for (const value of ["0", "01", "+1", "1.0", "１", "1 "]) {
    const raw = value === "1 " ? "1 x" : value;
    assert.equal(await fixture.route(raw, fixture.context), null, raw);
  }
  assert.equal(fixture.sessions.get("account-a\0peer-a").active, true);
});

test("routes an exact plugin command before any natural-language match", async () => {
  const calls = [];
  const exactPlugin = plugin({
    id: "mashirobot-plugin-exact",
    menuIndex: 1,
    priority: 1,
    exactCommands: ["/same"],
    handle: () => {
      calls.push("exact");
      return { handled: true, command: "exact", reply: "exact" };
    },
  });
  const naturalPlugin = plugin({
    id: "mashirobot-plugin-natural",
    menuIndex: 2,
    priority: 100,
    match: () => {
      calls.push("natural-match");
      return true;
    },
  });
  const registry = registryFor([naturalPlugin, exactPlugin]);
  const route = createPluginRouter({ registry });

  const result = await route("/same", createFixture().context);

  assert.equal(result.command, "exact");
  assert.deepEqual(calls, ["exact"]);
});

test("keeps a matched plugin execution error local", async () => {
  const failingPlugin = plugin({
    id: "mashirobot-plugin-failing",
    menuIndex: 1,
    exactCommands: ["/失败"],
    handle: () => {
      throw new Error("fixture failure\nwith details");
    },
  });
  const route = createPluginRouter({ registry: registryFor([failingPlugin]) });

  const result = await route("/失败", createFixture().context);

  assert.deepEqual(result, {
    handled: true,
    command: "插件错误",
    reply: "本地插件执行失败（mashirobot-plugin-failing）：fixture failure with details",
    mediaPaths: [],
  });
});

test("does not send a naturally matched handler failure to GPT", async () => {
  const failingPlugin = plugin({
    id: "mashirobot-plugin-natural-failure",
    menuIndex: 1,
    match: (message) => message === "触发失败",
    handle: () => {
      throw new Error("natural handler failed");
    },
  });
  const route = createPluginRouter({ registry: registryFor([failingPlugin]) });

  const result = await route("触发失败", createFixture().context);

  assert.equal(result.handled, true);
  assert.equal(result.command, "插件错误");
  assert.match(result.reply, /natural handler failed/);
});

test("returns null for unmatched text and for an expired standalone number", async () => {
  const fixture = createFixture();
  assert.equal(await fixture.route("普通聊天", fixture.context), null);

  await fixture.route("help", fixture.context);
  fixture.advance(35_000);
  assert.equal(await fixture.route("1", fixture.context), null);
});

test("awaits asynchronous main and plugin help rendering", async () => {
  const fixture = createFixture();
  const helpService = {
    async renderMainMenu() {
      await Promise.resolve();
      return { handled: true, command: "帮助菜单", reply: "async menu", mediaPaths: [] };
    },
    async renderPluginHelp(selectedPlugin) {
      await Promise.resolve();
      return {
        handled: true,
        command: "插件帮助",
        reply: `${selectedPlugin.manifest.id}:async help`,
        mediaPaths: [],
      };
    },
  };
  const route = createPluginRouter({
    registry: fixture.registry,
    menuSessions: fixture.sessions,
    helpService,
  });

  assert.equal((await route("help", fixture.context)).reply, "async menu");
  assert.equal((await route("1", fixture.context)).reply, "mashirobot-plugin-plan:async help");
});

test("normalizes the bridge context and exposes plugin help rendering", () => {
  const fixture = createFixture();
  const raw = {
    accountId: 123,
    conversationId: 456,
    now: "2026-08-03T04:00:00.000Z",
    planRoot: fixture.context.planRoot,
  };

  const context = createMashiroBotContext(raw, {
    registry: fixture.registry,
    renderPluginHelp: fixture.helpService.renderPluginHelp,
  });

  assert.equal(context.accountId, "123");
  assert.equal(context.conversationId, "456");
  assert.equal(context.localDate, "2026-08-03");
  assert.equal(context.sqlitePath, path.join(fixture.context.planRoot, "sqlite", "openclaw-planner.sqlite"));
  assert.equal(context.tempRoot, path.join(os.tmpdir(), "MashiroBot"));
  assert.equal(context.renderPluginHelp("mashirobot-plugin-plan", { detailed: true }).command, "插件详细帮助");
});

test("core sqlite configuration cannot be overridden by a message context", () => {
  const fixture = createFixture();
  const canonicalRoot = path.join(os.tmpdir(), "mashirobot-canonical-root");
  const canonical = path.join(os.tmpdir(), "mashirobot-canonical.sqlite");
  const context = createMashiroBotContext({
    ...fixture.context,
    sqlitePath: path.join(os.tmpdir(), "untrusted-message.sqlite"),
  }, {
    registry: fixture.registry,
    planRoot: canonicalRoot,
    sqlitePath: canonical,
  });

  assert.equal(context.planRoot, canonicalRoot);
  assert.equal(context.sqlitePath, canonical);
});

test("treats a Promise-returning match as a local contract failure", async () => {
  let handled = false;
  const invalid = plugin({
    id: "async-match",
    menuIndex: 1,
    match: async () => true,
    handle: () => { handled = true; return { handled: true, command: "bad", reply: "bad" }; },
  });
  const route = createPluginRouter({ registry: registryFor([invalid]), planRoot: path.resolve(import.meta.dirname, "..") });
  const result = await route("anything", createFixture().context);
  assert.equal(result.handled, true);
  assert.equal(result.command, "插件错误");
  assert.match(result.reply, /match\(\) must be synchronous/);
  assert.equal(handled, false);
});

test("keeps a matched handler timeout local", async () => {
  const hanging = plugin({
    id: "hanging",
    menuIndex: 1,
    match: () => true,
    handle: () => new Promise(() => {}),
  });
  const route = createPluginRouter({ registry: registryFor([hanging]), planRoot: path.resolve(import.meta.dirname, ".."), pluginHandleTimeoutMs: 10 });
  const result = await route("anything", createFixture().context);
  assert.equal(result.handled, true);
  assert.equal(result.command, "插件错误");
  assert.match(result.reply, /timed out/);
});
