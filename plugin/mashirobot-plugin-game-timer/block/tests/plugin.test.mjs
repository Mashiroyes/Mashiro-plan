import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as plugin from "../index.mjs";

test("handles list and rule creation with an injected syncer", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mashirobot-block-plugin-"));
  try {
    const calls = [];
    const context = { sqlitePath: path.join(root, "planner.sqlite"), now: new Date("2026-08-07T00:00:00Z"), blockSyncer: { apply(args) { calls.push(args); } } };
    const created = await plugin.handle("禁止下载QQ7天", context);
    assert.match(created.reply, /已生效/);
    assert.equal(calls.length, 1);
    assert.match((await plugin.handle("查询禁止名单", context)).reply, /QQ/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("reports deferred synchronization without claiming an installation failure", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mashirobot-block-plugin-"));
  try {
    const context = { sqlitePath: path.join(root, "planner.sqlite"), now: new Date("2026-08-07T00:00:00Z"), blockSyncer: { apply() { return { ok: true, scheduled: true }; } } };
    const created = await plugin.handle("禁止访问bilibili.com 7天", context);
    assert.match(created.reply, /1 分钟内同步/);
    assert.doesNotMatch(created.reply, /未安装|同步失败/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("explicit release updates today's default and plain release uses the latest explicit website", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mashirobot-block-release-plugin-"));
  try {
    const calls = [];
    const context = {
      sqlitePath: path.join(root, "planner.sqlite"),
      now: new Date("2026-08-07T00:00:00Z"),
      blockSyncer: { async apply(args) { calls.push(args); return { ok: true }; } },
    };
    await plugin.handle("禁止访问bilibili.com永久", context);
    await plugin.handle("禁止访问zhihu.com永久", context);
    assert.match((await plugin.handle("解除bilibili10分钟", context)).reply, /默认网站：bilibili\.com/u);
    context.now = new Date("2026-08-07T00:01:00Z");
    assert.match((await plugin.handle("解除zhihu.com20分钟", context)).reply, /默认网站：zhihu\.com/u);
    context.now = new Date("2026-08-07T00:02:00Z");
    const plain = await plugin.handle("解除10分钟", context);
    assert.match(plain.reply, /已临时解除 zhihu\.com/u);
    assert.match((await plugin.handle("查询禁止名单", context)).reply, /临时解除：[\s\S]*bilibili\.com[\s\S]*zhihu\.com/u);
    assert.ok(calls.length >= 5);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("plain release defaults to bilibili on a new Shanghai day", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mashirobot-block-default-plugin-"));
  try {
    const context = {
      sqlitePath: path.join(root, "planner.sqlite"),
      now: new Date("2026-08-07T00:00:00Z"),
      blockSyncer: { async apply() { return { ok: true }; } },
    };
    await plugin.handle("禁止访问bilibili.com永久", context);
    await plugin.handle("禁止访问zhihu.com永久", context);
    await plugin.handle("解除zhihu.com10分钟", context);
    context.now = new Date("2026-08-08T00:00:00Z");
    assert.match((await plugin.handle("解除10分钟", context)).reply, /已临时解除 bilibili\.com/u);
    assert.match((await plugin.handle("立即恢复bilibili", context)).reply, /恢复禁止/u);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("block-rule deletion uses unified numbering and requires confirmation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mashirobot-block-delete-plugin-"));
  try {
    const context = {
      sqlitePath: path.join(root, "planner.sqlite"), now: new Date("2026-08-07T00:00:00Z"),
      blockSyncer: { async apply() { return { ok: true }; } },
    };
    await plugin.handle("禁止下载QQ7天", context);
    await plugin.handle("禁止访问bilibili.com永久", context);
    const list = await plugin.handle("查询禁止名单", context);
    assert.match(list.reply, /1\. \[软件\] QQ[\s\S]*2\. \[网站\] bilibili\.com/u);
    assert.match((await plugin.handle("删除禁止规则3", context)).reply, /未删除任何规则/u);
    assert.match((await plugin.handle("删除禁止规则1，2", context)).reply, /准备删除[\s\S]*QQ[\s\S]*bilibili/u);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
