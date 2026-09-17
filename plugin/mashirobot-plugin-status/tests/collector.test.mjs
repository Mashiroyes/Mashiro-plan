import test from "node:test";
import assert from "node:assert/strict";
import { collectStatus, formatRuntime, normalizeStatus } from "../core/collector.mjs";

test("normalizes and sorts processes by memory without swap or adapter rows", () => {
  const result = normalizeStatus({
    uptimeSeconds: 93784,
    cpu: { usagePercent: 18, cores: 8, threads: 16, frequencyMHz: 5282 },
    memory: { totalBytes: 1000, freeBytes: 400 },
    disks: [{ name: "C: 系统", totalBytes: 1000, freeBytes: 200 }, { name: "", totalBytes: 0, freeBytes: 0 }],
    processes: [{ name: "small", memoryBytes: 10 }, { name: "Memory Compression", memoryBytes: 1000 }, { name: "Chrome", memoryBytes: 100, cpuPercent: 1 }, { name: "chrome", memoryBytes: 70, cpuPercent: 2 }, { name: "ChatGPT", memoryBytes: 80 }, { name: "chatgpt", memoryBytes: 20 }, { name: "explorer", memoryBytes: 50 }],
    networkProbes: [{ name: "百度", status: 200, latencyMs: 20 }],
    hardware: { networkAdapters: ["adapter"] },
    swap: { totalBytes: 1 },
    temperatures: { cpuCelsius: 55.1, gpuCelsius: 43.8, diskCelsius: 50, motherboardCelsius: 42 },
  });
  assert.deepEqual(result.processes.map((item) => item.name), ["Chrome", "ChatGPT", "Windows 资源管理器", "small"]);
  assert.equal(result.processes[0].memoryBytes, 170);
  assert.equal(result.processes[0].cpuPercent, 3);
  assert.equal(result.processMemoryKind, "private-working-set");
  assert.equal(result.cpu.frequencyMHz, 5282);
  assert.equal(result.disks.length, 1);
  assert.equal(result.disks[0].name, "C: 系统");
  assert.deepEqual(result.temperatures, { cpuCelsius: 55.1, gpuCelsius: 43.8, diskCelsius: 50, motherboardCelsius: 42 });
  assert.equal(result.swap, undefined);
  assert.deepEqual(result.networkProbes[0].name, "百度");
  assert.equal(result.hardware.networkAdapters[0], "adapter");
});

test("formats runtime in the requested Chinese form", () => {
  assert.equal(formatRuntime(93784), "1天2小时3分钟4秒");
});

test("keeps numeric probe status and HTTP status text for direct probe display", () => {
  const result = normalizeStatus({ networkProbes: [{ name: "Google", status: 200, statusText: "OK", latencyMs: 12.3 }] });
  assert.equal(result.networkProbes[0].status, 200);
  assert.equal(result.networkProbes[0].statusText, "OK");
});

test("collectStatus uses the async runner and preserves a failed individual probe", async () => {
  let received;
  const result = await collectStatus({
    kind: "status",
    runLocalProcess: async (options) => {
      received = options;
      return { value: { capturedAt: "2026-09-16T00:00:00.000Z", networkProbes: [{ name: "Google", error: "timeout" }] } };
    },
  });
  assert.equal(received.output, "json");
  assert.deepEqual(received.args.slice(-2), ["-Kind", "status"]);
  assert.equal(result.networkProbes[0].name, "Google");
  assert.equal(result.networkProbes[0].error, "timeout");
});

test("collectStatus translates process timeout", async () => {
  await assert.rejects(
    collectStatus({ timeoutMs: 1_500, runLocalProcess: async () => { const error = new Error("late"); error.code = "PROCESS_TIMEOUT"; throw error; } }),
    /状态采集超过 2 秒/,
  );
});
