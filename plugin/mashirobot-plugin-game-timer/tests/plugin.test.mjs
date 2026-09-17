import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handle, match } from "../index.mjs";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "game-plugin-"));
  const folder = path.join(root, "Eden-v0.0.4-win");
  fs.mkdirSync(folder, { recursive: true });
  const executablePath = path.join(folder, "eden.exe");
  fs.copyFileSync(path.join(process.env.SystemRoot, "System32", "cmd.exe"), executablePath);
  const configPath = path.join(root, "games.json");
  fs.writeFileSync(configPath, '{"games":[]}\n', "utf8");
  return {
    root, executablePath, configPath,
    context: {
      gameTimerConfigPath: configPath,
      sqlitePath: path.join(root, "planner.sqlite"),
      now: new Date("2026-08-05T01:00:00.000Z"),
      gameTimerScheduler: {
        schedule: () => ({ reminderTaskName: "reminder", forceTaskName: "force" }),
        remove: () => ({ ok: true }),
      },
      renderPluginHelp: () => ({ handled: true, reply: "help", mediaPaths: [] }),
      auditTargetsPath: path.join(root, "audit-targets.json"),
      auditStore: { listTargets: () => [], replaceTargets: () => {} },
    },
  };
}

test("add game reports inferred name and duplicate remains single", async () => {
  const f = fixture();
  try {
    const command = `加入游戏\n${f.executablePath}`;
    assert.match((await handle(command, f.context)).reply, /已加入游戏：Eden/);
    assert.match((await handle(command, f.context)).reply, /游戏已在清单中：Eden/);
    const raw = JSON.parse(fs.readFileSync(f.configPath, "utf8"));
    assert.equal(raw.games.length, 1);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("list games and create timer entirely locally", async () => {
  const f = fixture();
  try {
    await handle(`加入游戏\n${f.executablePath}`, f.context);
    assert.match((await handle("查看游戏", f.context)).reply, /1\. Eden（eden\.exe）/);
    const created = await handle("玩Eden 15分钟，提醒后5分钟强退", f.context);
    assert.match(created.reply, /微信提醒关闭/);
    assert.match(created.reply, /允许重新设置/);
    const duplicate = await handle("玩Eden 1分钟", f.context);
    assert.match(duplicate.reply, /不会被覆盖/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("legacy mark commands are ignored and the list has no priority marker", async () => {
  const f = fixture();
  try {
    await handle(`加入游戏\n${f.executablePath}`, f.context);
    assert.equal(match("标记1"), false);
    assert.equal(match("取消标记1"), false);
    assert.doesNotMatch((await handle("查看游戏", f.context)).reply, /重点|【/u);
    assert.equal("priority" in JSON.parse(fs.readFileSync(f.configPath, "utf8")).games[0], false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("batch game deletion requires confirmation and then updates the list", async () => {
  const f = fixture();
  try {
    await handle(`加入游戏\n${f.executablePath}`, f.context);
    assert.match((await handle("删除游戏1", f.context)).reply, /准备删除[\s\S]*Eden[\s\S]*确认删除/u);
    assert.match((await handle("确认删除", f.context)).reply, /已从游戏清单删除 1 项/u);
    assert.match((await handle("查看游戏", f.context)).reply, /游戏清单为空/u);
    assert.match((await handle("确认删除", f.context)).reply, /没有待确认/u);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("invalid game deletion index changes nothing", async () => {
  const f = fixture();
  try {
    await handle(`加入游戏\n${f.executablePath}`, f.context);
    assert.match((await handle("删除游戏2", f.context)).reply, /未删除任何游戏/u);
    assert.match((await handle("查看游戏", f.context)).reply, /Eden/u);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("menu 2 routes block commands through the merged module", async () => {
  const f = fixture();
  try {
    let renderedPluginId = null;
    const context = {
      ...f.context,
      blockSyncer: { apply: () => ({ ok: true }) },
      renderPluginHelp: (pluginId) => {
        renderedPluginId = pluginId;
        return { handled: true, reply: "help", mediaPaths: [] };
      },
    };
    assert.equal(match("禁止下载QQ7天"), true);
    assert.match((await handle("禁止下载QQ7天", context)).reply, /已生效：QQ/);
    assert.match((await handle("查询禁止名单", context)).reply, /QQ/);
    await handle("/禁止名单", context);
    assert.equal(renderedPluginId, "mashirobot-plugin-game-timer");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("confirmed block-rule deletion synchronizes and removes the selected rows", async () => {
  const f = fixture();
  try {
    const context = { ...f.context, blockSyncer: { async apply() { return { ok: true }; } } };
    await handle("禁止下载QQ7天", context);
    await handle("禁止访问bilibili.com永久", context);
    assert.match((await handle("删除禁止规则1，2", context)).reply, /准备删除/u);
    assert.match((await handle("确认删除", context)).reply, /已删除 2 条禁止规则/u);
    assert.match((await handle("查询禁止名单", context)).reply, /当前没有生效/u);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("adding a game never queries QQ status and preserves persisted QQ audit targets", async () => {
  const f = fixture();
  try {
    let qqCalls = 0;
    let written = [];
    f.context.qqSessionScheduler = { async status() { qqCalls += 1; throw new Error("must not run"); } };
    f.context.auditStore = {
      listTargets: () => [{ key: "qq", displayName: "QQ", kind: "software", executablePath: "C:\\QQ\\QQ.exe" }],
      replaceTargets(targets) { written = targets; },
    };
    const result = await handle(`加入游戏\n${f.executablePath}`, f.context);
    assert.match(result.reply, /已加入游戏/u);
    assert.equal(qqCalls, 0);
    assert.ok(written.some((target) => target.key === "qq" && target.executablePath.toLowerCase().endsWith("qq.exe")));
    assert.ok(written.some((target) => target.key !== "qq" && target.executablePath.toLowerCase().endsWith("eden.exe")));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
