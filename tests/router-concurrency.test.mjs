import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createMashiroBotContext } from "../core/bridge/context.mjs";
import { createPluginRouter } from "../core/router/plugin-router.mjs";

const fixtureContext = {
  accountId: "account",
  conversationId: "conversation",
  now: new Date("2026-09-16T12:00:00+08:00"),
  planRoot: path.join(os.tmpdir(), "mashirobot-router-concurrency"),
};

function fakePlugin({
  id = "mashirobot-plugin-fixture",
  menuIndex = 1,
  exactCommands = [],
  match = () => false,
  handle = () => ({ handled: true, command: id, reply: id }),
} = {}) {
  return {
    manifest: {
      id,
      name: id,
      description: id,
      menuIndex,
      priority: 100,
      exactCommands,
    },
    module: {
      match,
      handle,
      healthCheck: async () => ({ ok: true }),
      getHelp: async () => ({ groups: [], fallbackText: `${id} help` }),
    },
  };
}

function registryFor(plugins) {
  return {
    plugins,
    byMenuIndex: new Map(plugins.map((item) => [item.manifest.menuIndex, item])),
    byExactCommand: new Map(
      plugins.flatMap((item) => item.manifest.exactCommands.map((command) => [command, item])),
    ),
    failures: [],
  };
}

test("awaits an asynchronous plugin and keeps failures local", async () => {
  const plugin = fakePlugin({
    match: async () => true,
    handle: async () => {
      await Promise.resolve();
      throw new Error("async boom");
    },
  });
  const route = createPluginRouter({ registry: registryFor([plugin]) });

  const result = await route("command", fixtureContext);

  assert.equal(result.command, "插件错误");
  assert.match(result.reply, /async boom/);
});

test("one slow route does not block a second message", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const plugin = fakePlugin({
    match: (message) => message === "slow" || message === "fast",
    handle: async (message) => {
      if (message === "slow") await gate;
      return { handled: true, command: message, reply: message };
    },
  });
  const route = createPluginRouter({ registry: registryFor([plugin]) });

  const slow = route("slow", fixtureContext);
  const fast = await Promise.race([
    route("fast", { ...fixtureContext, conversationId: "other" }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("blocked")), 100)),
  ]);

  assert.equal(fast.reply, "fast");
  release();
  assert.equal((await slow).reply, "slow");
});

test("adds child-process elapsed time to one request completion record", async () => {
  const logs = [];
  let receivedOnComplete;
  const runProcess = async (options) => {
    receivedOnComplete = options.onComplete;
    await options.onComplete({ operationId: "child-1", elapsedMs: 37, code: "OK", exitCode: 0 });
    return { operationId: "child-1", elapsedMs: 37, value: "done" };
  };
  const plugin = fakePlugin({
    exactCommands: ["/run"],
    handle: async (_message, context) => {
      const child = await context.runLocalProcess({ executable: "fixture.exe" });
      return { handled: true, command: "run", reply: child.value };
    },
  });
  const route = createPluginRouter({
    registry: registryFor([plugin]),
    logger: (record) => logs.push(record),
    runLocalProcess: runProcess,
  });

  const result = await route("/run", { ...fixtureContext, requestId: "request-fixture" });

  assert.equal(result.reply, "done");
  assert.equal(typeof receivedOnComplete, "function");
  assert.equal(logs.length, 1);
  assert.equal(logs[0].requestId, "request-fixture");
  assert.equal(logs[0].pluginId, plugin.manifest.id);
  assert.equal(logs[0].event, "route_completed");
  assert.equal(logs[0].externalElapsedMs, 37);
  assert.equal(typeof logs[0].elapsedMs, "number");
  assert.equal(logs[0].errorCode, "");
});

test("composes a caller onComplete hook without allowing it to corrupt metrics", async () => {
  let callerCompletions = 0;
  const logs = [];
  const plugin = fakePlugin({
    exactCommands: ["/run"],
    handle: async (_message, context) => {
      await context.runLocalProcess({
        executable: "fixture.exe",
        onComplete: async () => {
          callerCompletions += 1;
          throw new Error("metrics hook failure");
        },
      });
      return { handled: true, command: "run", reply: "ok" };
    },
  });
  const route = createPluginRouter({
    registry: registryFor([plugin]),
    logger: (record) => logs.push(record),
    runLocalProcess: async (options) => {
      await options.onComplete({ elapsedMs: 12, code: "OK", exitCode: 0 });
      return { elapsedMs: 12, value: "ok" };
    },
  });

  const result = await route("/run", fixtureContext);

  assert.equal(result.reply, "ok");
  assert.equal(callerCompletions, 1);
  assert.equal(logs[0].externalElapsedMs, 12);
});

test("caller onComplete hooks never delay or reject the local-process result", async () => {
  for (const callerOnComplete of [
    () => { throw new Error("synchronous hook failure"); },
    async () => { throw new Error("asynchronous hook failure"); },
    () => new Promise(() => {}),
  ]) {
    const context = createMashiroBotContext(fixtureContext, {
      metrics: { externalElapsedMs: 0 },
      runLocalProcess: async (options) => {
        await options.onComplete({ elapsedMs: 7, code: "OK", exitCode: 0 });
        return { value: "done" };
      },
    });

    const result = await Promise.race([
      context.runLocalProcess({ executable: "fixture.exe", onComplete: callerOnComplete }),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("caller hook blocked the process result")), 100);
      }),
    ]);

    assert.equal(result.value, "done");
  }
});
