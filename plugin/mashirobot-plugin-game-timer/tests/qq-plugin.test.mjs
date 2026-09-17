import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handle, match } from "../index.mjs";
import { createQqSessionStore } from "../core/qq-session-storage.mjs";

function fixture(now) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qq-plugin-"));
  const configPath = path.join(root, "games.json");
  fs.writeFileSync(configPath, '{"games":[]}\n', "utf8");
  const calls = { preflight: 0, begin: 0, recover: 0 };
  const scheduler = {
    async preflight() { calls.preflight += 1; return { ok: true, errors: [], status: { status: { vaultReady: true } } }; },
    async begin(request) { calls.begin += 1; return { session: { ...request, confirmedAt: "2026-09-15T04:01:00.000Z", playEndsAt: "2026-09-15T04:21:00.000Z", cooldownEndsAt: "2026-09-15T05:21:00.000Z", phase: "playing" }, status: { qqExecutablePaths: ["C:\\QQ\\QQ.exe"] } }; },
    async recover() { calls.recover += 1; return { ok: true }; },
    async status() { return { status: { phase: "ready", qqExecutablePaths: ["C:\\QQ\\QQ.exe"] } }; },
  };
  return {
    root, calls,
    context: {
      now: new Date(now),
      sqlitePath: path.join(root, "planner.sqlite"),
      gameTimerConfigPath: configPath,
      auditTargetsPath: path.join(root, "targets.json"),
      qqNoonReleasePath: path.join(root, "before-noon-release.json"),
      qqSessionScheduler: scheduler,
      renderPluginHelp: () => ({ handled: true, reply: "help", mediaPaths: [] }),
    },
  };
}

test("QQ special command uses requested duration and cooldown starts after play", async () => {
  const f = fixture("2026-09-15T04:00:00Z");
  try {
    assert.equal(match("玩QQ20分钟"), true);
    const response = await handle("玩QQ20分钟", f.context);
    assert.equal(response.command, "QQ限时");
    assert.match(response.reply, /20 分钟/);
    assert.match(response.reply, /60分钟/);
    assert.match(response.reply, /13:21:00/);
    assert.equal(f.calls.preflight, 1);
    assert.equal(f.calls.begin, 1);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("QQ request before Shanghai noon has no side effects", async () => {
  const f = fixture("2026-09-15T03:59:59Z");
  try {
    const response = await handle("玩QQ10分钟", f.context);
    assert.equal(response.reply, "每天12点之前不能同意玩QQ的请求，请12点之后再打开。");
    assert.equal(f.calls.preflight, 0);
    assert.equal(f.calls.begin, 0);
    assert.equal(fs.existsSync(f.context.sqlitePath), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("valid temporary release bypasses only the before-noon gate", async () => {
  const f = fixture("2026-09-15T03:59:59Z");
  try {
    fs.writeFileSync(f.context.qqNoonReleasePath, JSON.stringify({ purpose: "qq-before-noon-test", expiresAt: "2026-09-15T04:19:59Z" }));
    const response = await handle("玩QQ6分钟", f.context);
    assert.match(response.reply, /6 分钟/);
    assert.equal(f.calls.preflight, 1);
    assert.equal(f.calls.begin, 1);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("expired or malformed temporary release fails closed", async () => {
  const f = fixture("2026-09-15T03:59:59Z");
  try {
    fs.writeFileSync(f.context.qqNoonReleasePath, JSON.stringify({ purpose: "qq-before-noon-test", expiresAt: "2026-09-15T03:59:58Z" }));
    assert.equal((await handle("玩QQ6分钟", f.context)).reply, "每天12点之前不能同意玩QQ的请求，请12点之后再打开。");
    fs.writeFileSync(f.context.qqNoonReleasePath, "broken");
    assert.equal((await handle("玩QQ6分钟", f.context)).reply, "每天12点之前不能同意玩QQ的请求，请12点之后再打开。");
    assert.equal(f.calls.preflight, 0);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("QQ preflight failure does not create a session", async () => {
  const f = fixture("2026-09-15T04:00:00Z");
  try {
    f.context.qqSessionScheduler.preflight = async () => { f.calls.preflight += 1; return { ok: false, errors: ["未安装QQ"] }; };
    const response = await handle("玩QQ10分钟", f.context);
    assert.match(response.reply, /未安装QQ/);
    assert.equal(f.calls.begin, 0);
    assert.equal(fs.existsSync(f.context.sqlitePath), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("repeated QQ command reports the existing session without starting another timer", async () => {
  const f = fixture("2026-09-15T04:00:00Z");
  try {
    await handle("玩QQ10分钟", f.context);
    f.context.now = new Date("2026-09-15T04:02:00Z");
    const response = await handle("玩QQ20分钟", f.context);
    assert.match(response.reply, /正在准备中/);
    assert.equal(f.calls.preflight, 1);
    assert.equal(f.calls.begin, 1);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("audit query uses injected store and reports QQ foreground time", async () => {
  const f = fixture("2026-09-15T05:00:00Z");
  try {
    f.context.auditStore = {
      summary: () => ({ totals: { qq: 125 }, health: { fresh: true, heartbeatAt: "2026-09-15T05:00:00Z" } }),
      listTargets: () => [{ key: "qq", displayName: "QQ" }],
    };
    const response = await handle("查询今日使用审计", f.context);
    assert.equal(response.command, "使用审计");
    assert.match(response.reply, /QQ：2分钟5秒/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("failed QQ launch clears preparing state, does not count cooldown, and attempts recovery once", async () => {
  const f = fixture("2026-09-15T04:00:00Z");
  try {
    f.context.qqSessionScheduler.begin = async () => { f.calls.begin += 1; throw new Error("launch failed"); };
    const response = await handle("玩QQ10分钟", f.context);
    assert.match(response.reply, /没有启动：launch failed/u);
    assert.equal(f.calls.recover, 1);
    const store = createQqSessionStore(f.context.sqlitePath);
    assert.equal(store.getBlockingSession(new Date("2026-09-15T04:01:00Z")), null);
    const second = await handle("玩QQ10分钟", f.context);
    assert.doesNotMatch(second.reply, /正在准备|正在冷却/u);
    assert.equal(f.calls.begin, 2);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
