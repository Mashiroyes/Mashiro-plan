import test from "node:test";
import assert from "node:assert/strict";
import { parseBlockCommand, getExpiry, getReleaseExpiry } from "../core/parser.mjs";

const now = new Date("2026-08-07T00:00:00.000Z");
test("parses software and permanent website rules", () => {
  const software = parseBlockCommand("禁止下载QQ7天", now);
  assert.equal(software.ruleKind, "software");
  assert.equal(software.targetKey, "qq");
  assert.equal(getExpiry(software, now), "2026-08-14T00:00:00.000Z");
  const site = parseBlockCommand("禁止访问https://www.baidu.com永久", now);
  assert.equal(site.ruleKind, "website");
  assert.equal(site.targetKey, "baidu.com");
  assert.equal(site.expiresAt, null);
  const downloadSite = parseBlockCommand("禁止下载example.com7天", now);
  assert.equal(downloadSite.ruleKind, "website");
  assert.equal(downloadSite.downloadOnly, true);
  assert.equal(downloadSite.targetKey, "example.com");
});

test("parses list and rejects unsafe targets", () => {
  assert.deepEqual(parseBlockCommand("查询禁止名单"), { kind: "list" });
  assert.throws(() => parseBlockCommand("禁止下载Unknown7天"), /未配置软件/);
  assert.throws(() => parseBlockCommand("禁止访问https://user:pass@baidu.com7天"), /不合法/);
  assert.throws(() => parseBlockCommand("禁止访问localhost7天"), /合法域名/);
});

test("parses explicit/default releases and immediate restore", () => {
  const explicit = parseBlockCommand("解除哔哩哔哩10分钟", now);
  assert.deepEqual({ kind: explicit.kind, targetKey: explicit.targetKey, displayName: explicit.displayName, minutes: explicit.minutes, explicit: explicit.explicit },
    { kind: "release", targetKey: "bilibili.com", displayName: "bilibili.com", minutes: 10, explicit: true });
  assert.equal(getReleaseExpiry(explicit, now), "2026-08-07T00:10:00.000Z");
  assert.deepEqual(parseBlockCommand("解除20分钟", now), { kind: "release", targetKey: null, displayName: null, minutes: 20, explicit: false });
  assert.deepEqual(parseBlockCommand("立即恢复bilibili", now), { kind: "restore", targetKey: "bilibili.com", displayName: "bilibili.com" });
  assert.throws(() => parseBlockCommand("解除bilibili1500分钟", now), /不能超过24小时/u);
});

test("parses batch block-rule deletion", () => {
  assert.deepEqual(parseBlockCommand("删除禁止规则2，4, 6", now), { kind: "deletePreview", indices: [2, 4, 6] });
  assert.equal(parseBlockCommand("删除禁止规则0，2", now), null);
});
