import path from "node:path";
import { fileURLToPath } from "node:url";
import { runLocalProcess as defaultRunLocalProcess } from "../../../core/execution/local-process.mjs";

const pluginRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const collectorPath = path.join(pluginRoot, "powershell", "status-collector.ps1");

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function text(value, fallback = "") {
  const result = String(value ?? "").trim();
  return result || fallback;
}

function array(value) { return Array.isArray(value) ? value : []; }

function normalizeProbe(probe) {
  return {
    name: text(probe?.name, "未知"),
    status: typeof probe?.status === "number" ? probe.status : (probe?.status == null ? "失败" : text(probe.status, "失败")),
    statusText: text(probe?.statusText),
    latencyMs: probe?.latencyMs == null ? null : Math.max(0, finite(probe.latencyMs)),
    error: probe?.error ? text(probe.error) : "",
  };
}

function normalizeHardware(raw) {
  const list = (value) => array(value).map((item) => text(item)).filter(Boolean);
  return {
    processor: text(raw?.processor, "未知处理器"),
    motherboard: text(raw?.motherboard, "未知主板"),
    memory: text(raw?.memory, "未知内存"),
    graphics: list(raw?.graphics),
    monitors: list(raw?.monitors),
    physicalDisks: list(raw?.physicalDisks),
    audio: list(raw?.audio),
    networkAdapters: list(raw?.networkAdapters),
    system: text(raw?.system, "Windows"),
    cpuDetail: text(raw?.cpuDetail, "未检测到"),
    motherboardDetail: text(raw?.motherboardDetail, "未检测到"),
    gpuDetail: text(raw?.gpuDetail, "未检测到"),
    memoryDetail: text(raw?.memoryDetail, "未检测到"),
    displayDetail: list(raw?.displayDetail),
  };
}

function normalizeTemperature(value) {
  if (value == null || !Number.isFinite(Number(value))) return null;
  return Math.round(Number(value) * 10) / 10;
}

export function normalizeStatus(raw) {
  const processTotals = new Map();
  for (const item of array(raw?.processes)
    .map((item) => ({
      name: text(item?.name, "未知进程"),
      cpuPercent: Math.max(0, finite(item?.cpuPercent)),
      memoryBytes: Math.max(0, finite(item?.memoryBytes)),
    }))
    .filter((item) => item.memoryBytes > 0 && item.name.toLowerCase() !== "memory compression")) {
    const key = item.name.toLocaleLowerCase("en");
    const current = processTotals.get(key) ?? { name: item.name, cpuPercent: 0, memoryBytes: 0 };
    current.cpuPercent += item.cpuPercent;
    current.memoryBytes += item.memoryBytes;
    processTotals.set(key, current);
  }
  const processes = [...processTotals.values()]
    .map((item) => ({ ...item, name: item.name.toLowerCase() === "explorer" ? "Windows 资源管理器" : item.name }))
    .sort((left, right) => right.memoryBytes - left.memoryBytes || left.name.localeCompare(right.name, "en"))
    .slice(0, 8);
  const disks = array(raw?.disks)
    .map((item) => ({
      name: text(item?.name),
      totalBytes: Math.max(0, finite(item?.totalBytes)),
      freeBytes: Math.max(0, finite(item?.freeBytes)),
    }))
    .filter((item) => item.name && item.totalBytes > 0)
    .map((item) => ({ ...item, freeBytes: Math.min(item.freeBytes, item.totalBytes) }));
  const totalBytes = Math.max(0, finite(raw?.memory?.totalBytes));
  const freeBytes = Math.min(totalBytes, Math.max(0, finite(raw?.memory?.freeBytes)));
  return {
    capturedAt: text(raw?.capturedAt, new Date().toISOString()),
    hostname: text(raw?.hostname, "Windows"),
    os: text(raw?.os, "Windows"),
    uptimeSeconds: Math.max(0, finite(raw?.uptimeSeconds)),
    cpu: { usagePercent: Math.min(100, Math.max(0, finite(raw?.cpu?.usagePercent))), cores: Math.max(0, finite(raw?.cpu?.cores)), threads: Math.max(0, finite(raw?.cpu?.threads)), frequencyMHz: Math.max(0, finite(raw?.cpu?.frequencyMHz)), model: text(raw?.cpu?.model, "未知处理器") },
    memory: { usedBytes: totalBytes - freeBytes, freeBytes, totalBytes, usagePercent: totalBytes ? (totalBytes - freeBytes) / totalBytes * 100 : 0 },
    disks,
    temperatures: {
      cpuCelsius: normalizeTemperature(raw?.temperatures?.cpuCelsius),
      gpuCelsius: normalizeTemperature(raw?.temperatures?.gpuCelsius),
      diskCelsius: normalizeTemperature(raw?.temperatures?.diskCelsius),
      motherboardCelsius: normalizeTemperature(raw?.temperatures?.motherboardCelsius),
    },
    networkProbes: array(raw?.networkProbes).map(normalizeProbe),
    probeErrors: Object.fromEntries(Object.entries(raw?.probeErrors ?? {}).map(([key, value]) => [key, text(value)])),
    processMemoryKind: text(raw?.processMemoryKind, "private-working-set"),
    processes,
    hardware: normalizeHardware(raw?.hardware),
  };
}

export async function collectStatus({ pwshPath = "pwsh.exe", timeoutMs, collector = collectorPath, kind = "status", runLocalProcess = defaultRunLocalProcess } = {}) {
  if (kind !== "status" && kind !== "hardware") throw new Error("未知状态采集模式");
  const effectiveTimeoutMs = timeoutMs ?? (kind === "hardware" ? 45_000 : 30_000);
  try {
    const completed = await runLocalProcess({
      executable: pwshPath,
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", collector, "-Kind", kind],
      timeoutMs: effectiveTimeoutMs,
      output: "json",
      jsonMode: "document",
      maxStdoutBytes: 2 * 1024 * 1024,
      maxStderrBytes: 64 * 1024,
    });
    return normalizeStatus(completed.value);
  } catch (error) {
    if (error?.code === "PROCESS_TIMEOUT") throw new Error(`状态采集超过 ${Math.round(effectiveTimeoutMs / 1000)} 秒`, { cause: error });
    if (error?.code === "PROCESS_INVALID_OUTPUT") throw new Error(`状态采集结果不是有效 JSON：${error.message}`, { cause: error });
    throw error;
  }
}

export function formatRuntime(seconds) {
  let remaining = Math.max(0, Math.floor(finite(seconds)));
  const days = Math.floor(remaining / 86400); remaining %= 86400;
  const hours = Math.floor(remaining / 3600); remaining %= 3600;
  const minutes = Math.floor(remaining / 60); const secs = remaining % 60;
  return `${days}天${hours}小时${minutes}分钟${secs}秒`;
}
