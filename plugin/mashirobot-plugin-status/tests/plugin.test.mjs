import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { handle, match } from "../index.mjs";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const data = {
  capturedAt: "2026-09-16T00:00:00.000Z",
  hostname: "TEST-PC",
  uptimeSeconds: 93784,
  cpu: { usagePercent: 10, cores: 4, threads: 8, model: "Test CPU" },
  memory: { totalBytes: 1000, freeBytes: 400 },
  temperatures: { cpuCelsius: 55, gpuCelsius: 44, diskCelsius: 50, motherboardCelsius: 42 },
  disks: [{ name: "C:", totalBytes: 1000, freeBytes: 250 }],
  networkProbes: [{ name: "百度", status: 200, latencyMs: 12 }],
  processes: [{ name: "large", cpuPercent: 1, memoryBytes: 500 }],
  hardware: {
    processor: "Test CPU",
    motherboard: "Test Board",
    memory: "16GB",
    graphics: ["Test GPU"],
    monitors: ["Test Monitor"],
    physicalDisks: ["Test Disk"],
    audio: ["Test Audio"],
    networkAdapters: ["Test Adapter"],
  },
};

function fakeRunner(counter) {
  return async ({ args }) => {
    counter.starts += 1;
    const encoded = args[args.indexOf("--outputs-base64") + 1];
    const outputs = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    await Promise.all(Object.values(outputs).map((target) => writeFile(target, png)));
    return { exitCode: 0, stdout: "", stderr: "", elapsedMs: 1, value: "" };
  };
}

test("matches status and renders status plus temperature in one child process", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mashirobot-status-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const counter = { starts: 0 };
  assert.equal(match("状态"), true);
  assert.equal(match("硬件信息"), true);
  assert.equal(match("闲聊"), false);

  const status = await handle("状态", { statusData: data, tempRoot: root, runLocalProcess: fakeRunner(counter) });
  assert.equal(status.handled, true);
  assert.match(status.reply, /运行时间：1天2小时3分钟4秒/);
  assert.equal(status.mediaPaths.length, 2);
  assert.ok(status.mediaPaths.every(fs.existsSync));
  assert.equal(counter.starts, 1);
});

test("passes collection kind and a fresh cache skips collection", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mashirobot-status-kind-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const kinds = [];
  const counter = { starts: 0 };
  const context = {
    tempRoot: root,
    cacheNow: () => Date.parse(data.capturedAt),
    runLocalProcess: fakeRunner(counter),
    statusCollector: async ({ kind }) => { kinds.push(kind); return data; },
  };

  assert.equal((await handle("状态", context)).handled, true);
  assert.equal((await handle("状态", context)).handled, true);
  assert.equal((await handle("硬件信息", context)).handled, true);
  assert.deepEqual(kinds, ["status", "hardware"]);
  assert.equal(counter.starts, 2);
});

test("uses stale complete data with a visible capture time when collection fails", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mashirobot-status-stale-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = Date.parse("2026-09-16T00:00:00Z");
  const counter = { starts: 0 };
  const common = { tempRoot: root, cacheNow: () => now, runLocalProcess: fakeRunner(counter) };
  await handle("状态", { ...common, statusCollector: async () => data });
  now += 6_000;

  const stale = await handle("状态", { ...common, statusCollector: async () => { throw new Error("probe failed"); } });
  assert.equal(stale.handled, true);
  assert.match(stale.reply, /采集于 .*实时刷新失败/u);
  assert.equal(stale.mediaPaths.length, 2);
});
