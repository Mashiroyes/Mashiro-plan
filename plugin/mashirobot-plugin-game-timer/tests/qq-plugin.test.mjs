import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handle, match } from "../index.mjs";
import { createQqSessionStore } from "../core/qq-session-storage.mjs";

function fixture(now) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qq-plugin-"));
  const plannerPath = path.join(root, "planner.sqlite");
  const configPath = path.join(root, "games.json");
  fs.writeFileSync(configPath, '{"games":[]}\n', "utf8");
  const calls = { preflight: 0, begin: 0, recover: 0 };
  const scheduler = {
    async preflight() { calls.preflight += 1; return { ok: true, errors: [], status: { status: { vaultReady: true } } }; },
    async begin(request) {
      calls.begin += 1;
      const confirmed = new Date(new Date(now).getTime() + 60_000);
      const store = createQqSessionStore(plannerPath);
      let session = store.activateAfterInstall(request.id, confirmed);
      if (request.windowPolicy === "sunday-4h") session = store.consumeSundayAllowance(request.id, confirmed);
      return { session, status: { qqExecutablePaths: ["C:\\QQ\\QQ.exe"] } };
    },
    async recover() { calls.recover += 1; return { ok: true }; },
    async status() { return { status: { phase: "ready", qqExecutablePaths: ["C:\\QQ\\QQ.exe"] } }; },
  };
  return {
    root, calls,
    context: {
      now: new Date(now),
      sqlitePath: plannerPath,
      gameTimerConfigPath: configPath,
      auditTargetsPath: path.join(root, "targets.json"),
      qqSessionScheduler: scheduler,
      renderPluginHelp: () => ({ handled: true, reply: "help", mediaPaths: [] }),
    },
  };
}

test("QQ special command uses requested duration and cooldown starts after play", async () => {
  const f = fixture("2026-09-20T04:00:00Z");
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
  const f = fixture("2026-09-20T03:59:59Z");
  try {
    const response = await handle("玩QQ10分钟", f.context);
    assert.equal(response.reply, "每天12点之前不能同意玩QQ的请求，请12点之后再打开。");
    assert.equal(f.calls.preflight, 0);
    assert.equal(f.calls.begin, 0);
    assert.equal(fs.existsSync(f.context.sqlitePath), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("QQ request on Saturday inside the daily window is accepted", async () => {
  const f = fixture("2026-09-19T04:00:00Z");
  try {
    const response = await handle("玩QQ10分钟", f.context);
    assert.match(response.reply, /QQ已允许使用 10 分钟/u);
    assert.equal(f.calls.preflight, 1);
    assert.equal(f.calls.begin, 1);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("Sunday four-hour command truncates at midnight and consumes the date once", async () => {
  const f = fixture("2026-10-11T13:00:00Z");
  try {
    const first = await handle("周末玩QQ4h", f.context);
    assert.match(first.reply, /179 分钟/u);
    assert.match(first.reply, /00:00:00|00:00/u);
    assert.equal(f.calls.preflight, 1);
    assert.equal(f.calls.begin, 1);

    const store = createQqSessionStore(f.context.sqlitePath);
    const stored = store.getBlockingSession(new Date("2026-10-11T13:02:00Z"));
    if (!stored.specialConsumedAt) store.consumeSundayAllowance(stored.id, "2026-10-11T13:01:00Z");
    store.setPhase(stored.id, "cooldown", null, "2026-10-11T16:01:00Z");
    store.setPhase(stored.id, "ready", null, "2026-10-11T17:01:00Z");
    f.context.now = new Date("2026-10-11T13:02:00Z");
    const second = await handle("周末玩QQ4h", f.context);
    assert.match(second.reply, /本周日.*已经使用|当天.*一次/u);
    assert.equal(f.calls.begin, 1);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("Sunday four-hour command rejects Saturday and Monday without side effects", async () => {
  const saturday = fixture("2026-10-10T13:00:00Z");
  const monday = fixture("2026-10-11T16:00:00Z");
  try {
    assert.match((await handle("周末玩QQ4h", saturday.context)).reply, /星期日/u);
    assert.match((await handle("周末玩QQ4h", monday.context)).reply, /星期日/u);
    assert.equal(saturday.calls.preflight, 0);
    assert.equal(monday.calls.begin, 0);
    assert.equal(fs.existsSync(saturday.context.sqlitePath), false);
    assert.equal(fs.existsSync(monday.context.sqlitePath), false);
  } finally {
    fs.rmSync(saturday.root, { recursive: true, force: true });
    fs.rmSync(monday.root, { recursive: true, force: true });
  }
});

test("QQ requests at or beyond the evening boundary have no side effects", async () => {
  const atClose = fixture("2026-09-20T14:00:00Z");
  const crossing = fixture("2026-09-20T13:50:00Z");
  try {
    assert.match((await handle("玩QQ1分钟", atClose.context)).reply, /22:00/);
    assert.match((await handle("玩QQ20分钟", crossing.context)).reply, /22:00/);
    assert.equal(atClose.calls.preflight, 0);
    assert.equal(crossing.calls.begin, 0);
    assert.equal(fs.existsSync(atClose.context.sqlitePath), false);
    assert.equal(fs.existsSync(crossing.context.sqlitePath), false);
  } finally {
    fs.rmSync(atClose.root, { recursive: true, force: true });
    fs.rmSync(crossing.root, { recursive: true, force: true });
  }
});

test("QQ preflight failure does not create a session", async () => {
  const f = fixture("2026-09-20T04:00:00Z");
  try {
    f.context.qqSessionScheduler.preflight = async () => { f.calls.preflight += 1; return { ok: false, errors: ["未安装QQ"] }; };
    const response = await handle("玩QQ10分钟", f.context);
    assert.match(response.reply, /未安装QQ/);
    assert.equal(f.calls.begin, 0);
    assert.equal(fs.existsSync(f.context.sqlitePath), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("repeated QQ command reports the existing session without starting another timer", async () => {
  const f = fixture("2026-09-20T04:00:00Z");
  try {
    await handle("玩QQ10分钟", f.context);
    f.context.now = new Date("2026-09-20T04:02:00Z");
    const response = await handle("玩QQ20分钟", f.context);
    assert.match(response.reply, /正在限时使用中|正在准备中/);
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
  const f = fixture("2026-09-20T04:00:00Z");
  try {
    f.context.qqSessionScheduler.begin = async () => { f.calls.begin += 1; throw new Error("launch failed"); };
    const response = await handle("玩QQ10分钟", f.context);
    assert.match(response.reply, /没有启动：launch failed/u);
    assert.equal(f.calls.recover, 1);
    const store = createQqSessionStore(f.context.sqlitePath);
    assert.equal(store.getBlockingSession(new Date("2026-09-20T04:01:00Z")), null);
    const second = await handle("玩QQ10分钟", f.context);
    assert.doesNotMatch(second.reply, /正在准备|正在冷却/u);
    assert.equal(f.calls.begin, 2);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("confirmed QQ launch stays successful when audit refresh fails", async () => {
  const f = fixture("2026-09-20T04:00:00Z");
  try {
    f.context.auditStore = {
      listTargets: () => [],
      replaceTargets: () => { throw new Error("targets unavailable"); },
    };
    const response = await handle("玩QQ10分钟", f.context);
    assert.match(response.reply, /QQ已允许使用 10 分钟/u);
    assert.match(response.reply, /使用审计刷新失败：targets unavailable/u);
    assert.equal(f.calls.recover, 0);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
