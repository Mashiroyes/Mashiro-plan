import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBlockStore } from "../core/storage.mjs";

test("persists, extends, lists, and expires rules", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mashirobot-block-"));
  try {
    const db = path.join(root, "planner.sqlite");
    const store = createBlockStore(db);
    const now = new Date("2026-08-07T00:00:00.000Z");
    store.upsert({ kind: "software", targetKey: "qq", displayName: "QQ", expiresAt: "2026-08-14T00:00:00.000Z" }, now);
    store.upsert({ kind: "software", targetKey: "qq", displayName: "QQ", expiresAt: "2026-08-21T00:00:00.000Z" }, now);
    assert.equal(createBlockStore(db).listEffective(new Date("2026-08-15T00:00:00.000Z"))[0].expiresAt, "2026-08-21T00:00:00.000Z");
    assert.equal(store.listEffective(new Date("2026-08-22T00:00:00.000Z")).length, 0);
    store.expire(new Date("2026-08-22T00:00:00.000Z"));
    assert.equal(store.listAll()[0].active, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("temporary release preserves the permanent base rule and daily default is date scoped", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mashirobot-block-release-"));
  try {
    const store = createBlockStore(path.join(root, "planner.sqlite"));
    const now = new Date("2026-08-07T00:00:00.000Z");
    store.upsert({ kind: "website", targetKey: "bilibili.com", displayName: "bilibili.com", expiresAt: null }, now);
    store.upsert({ kind: "website", targetKey: "zhihu.com", displayName: "zhihu.com", expiresAt: null }, now);
    store.release({ targetKey: "bilibili.com", displayName: "bilibili.com", expiresAt: "2026-08-07T00:10:00.000Z" }, now);
    assert.equal(store.listEffective(now).length, 2);
    assert.deepEqual(store.listEnforced(now).map((row) => row.targetKey), ["zhihu.com"]);
    store.setDailyReleaseDefault("bilibili.com", "bilibili.com", now);
    store.setDailyReleaseDefault("zhihu.com", "zhihu.com", new Date("2026-08-07T00:01:00.000Z"));
    assert.equal(store.getDailyReleaseDefault(now).targetKey, "zhihu.com");
    assert.equal(store.getDailyReleaseDefault(new Date("2026-08-08T00:00:00.000Z")), null);
    store.expire(new Date("2026-08-07T00:11:00.000Z"));
    assert.equal(store.listEnforced(new Date("2026-08-07T00:11:00.000Z")).length, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("batch deactivation is atomic and clears release/default state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mashirobot-block-delete-"));
  try {
    const store = createBlockStore(path.join(root, "planner.sqlite"));
    const now = new Date("2026-08-07T00:00:00.000Z");
    store.upsert({ kind: "website", targetKey: "bilibili.com", displayName: "bilibili.com", expiresAt: null }, now);
    store.release({ targetKey: "bilibili.com", displayName: "bilibili.com", expiresAt: "2026-08-07T00:10:00.000Z" }, now);
    store.setDailyReleaseDefault("bilibili.com", "bilibili.com", now);
    assert.equal(store.deactivateMany([{ kind: "website", targetKey: "bilibili.com" }], now).changes, 1);
    assert.equal(store.listEffective(now).length, 0);
    assert.equal(store.listReleases(now).length, 0);
    assert.equal(store.getDailyReleaseDefault(now), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
