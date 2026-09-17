import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createContentCache } from "../../core/cache/content-cache.mjs";
import { collectStatus, formatRuntime, normalizeStatus } from "./core/collector.mjs";
import { createStatusCache } from "./core/status-cache.mjs";

const pluginRoot = path.dirname(fileURLToPath(import.meta.url));
const rendererPath = path.join(pluginRoot, "render", "status-card.py");
const STATUS_COMMANDS = new Set(["状态", "status", "/状态"]);
const HARDWARE_COMMANDS = new Set(["硬件信息", "hardware", "/硬件信息"]);
const RENDER_VERSION = "status-card-v2";

function reply(text, command = "状态") { return { handled: true, command, reply: text, mediaPaths: [] }; }
function pythonPath(context) { return context.pythonExecutable ?? (process.platform === "win32" ? "python" : "python3"); }

export function match(message) {
  const text = String(message ?? "").trim();
  return STATUS_COMMANDS.has(text) || HARDWARE_COMMANDS.has(text) || text === "/状态详细";
}

function processRunner(context) {
  if (typeof context.runLocalProcess !== "function") throw new Error("本地异步执行器不可用");
  return context.runLocalProcess;
}

function imageCache(context, tempRoot) {
  return context.statusImageCache ?? createContentCache({
    root: path.join(tempRoot, "cache"),
    namespace: "status-images",
    maxEntries: 32,
    maxBytes: 128 * 1024 * 1024,
  });
}

async function renderAll(data, kind, context, tempRoot) {
  const cache = imageCache(context, tempRoot);
  const outputKinds = kind === "status" ? ["status", "temperature"] : ["hardware"];
  const cached = await cache.getOrCreate({
    keyPayload: { kind, data },
    version: RENDER_VERSION,
    extension: ".png",
    create: async ({ outputPaths, stagingRoot, hash }) => {
      const targets = Object.fromEntries(outputKinds.map((outputKind, index) => [
        outputKind,
        index === 0 ? outputPaths[0] : path.join(stagingRoot, `${hash}-${index + 1}.png`),
      ]));
      const encodedPayload = Buffer.from(JSON.stringify(data), "utf8").toString("base64");
      const encodedOutputs = Buffer.from(JSON.stringify(targets), "utf8").toString("base64");
      await processRunner(context)({
        executable: pythonPath(context),
        args: [rendererPath, "--payload-base64", encodedPayload, "--outputs-base64", encodedOutputs],
        timeoutMs: 30_000,
        output: "text",
        maxStdoutBytes: 64 * 1024,
        maxStderrBytes: 64 * 1024,
      });
      return Object.values(targets);
    },
  });
  return cache.copyForUse(cached, { targetRoot: path.join(tempRoot, "outbound") });
}

function staleNotice(capturedAt) {
  const parsed = new Date(capturedAt);
  const shown = Number.isNaN(parsed.getTime()) ? String(capturedAt || "未知时间") : parsed.toLocaleString("zh-CN", { hour12: false });
  return `采集于 ${shown}，实时刷新失败`;
}

async function loadData(kind, context, cache) {
  if (context.statusData) return { data: normalizeStatus(context.statusData), stale: false };
  const cached = await cache.read(kind);
  if (cached?.fresh) return { data: normalizeStatus(cached.data), stale: false };
  try {
    const collector = context.statusCollector ?? collectStatus;
    const data = normalizeStatus(await collector({ ...context, runLocalProcess: processRunner(context), kind }));
    await cache.write(kind, data);
    return { data, stale: false };
  } catch (error) {
    if (cached?.data) return { data: normalizeStatus(cached.data), stale: true, capturedAt: cached.capturedAt, collectionError: error };
    throw error;
  }
}

export async function handle(message, context = {}) {
  const command = String(message ?? "").trim();
  if (!match(command)) throw new Error("无法识别状态指令。");
  try {
    const kind = HARDWARE_COMMANDS.has(command) ? "hardware" : "status";
    const tempRoot = path.resolve(context.tempRoot ?? path.join(os.tmpdir(), "MashiroBot"), "status");
    const cache = context.statusCache ?? createStatusCache({ root: path.join(tempRoot, "data-cache"), now: context.cacheNow ?? Date.now });
    const loaded = await loadData(kind, context, cache);
    const mediaPaths = await renderAll(loaded.data, kind, context, tempRoot);
    const parts = [];
    if (kind === "status") parts.push(`运行时间：${formatRuntime(loaded.data.uptimeSeconds)}`);
    if (loaded.stale) parts.push(staleNotice(loaded.capturedAt));
    return { handled: true, command: kind === "hardware" ? "硬件信息" : "状态", reply: parts.join("\n"), mediaPaths };
  } catch (error) {
    return reply(`状态图片生成失败：${error.message}`, command);
  }
}

export function healthCheck() {
  return { ok: fs.existsSync(rendererPath) && fs.existsSync(path.join(pluginRoot, "powershell", "status-collector.ps1")), name: "mashirobot-plugin-status", renderer: rendererPath };
}

export function getHelp() {
  return {
    groups: [{ title: "状态", items: ["状态：发送系统状态图片，并附带文字运行时间", "硬件信息：发送处理器、主板、内存、显卡、显示器、磁盘、声卡和网卡配置图"] }],
    detailedGroups: [{ title: "状态图片", items: ["不显示 SWAP", "不显示网卡上传/下载明细", "应用进程按内存占用从高到低排列", "网络区域只显示百度和 Google 状态/延迟"] }, { title: "硬件配置图", items: ["硬件信息显示网卡设备名称", "Windows 未检测到的设备显示未检测到"] }],
    fallbackText: "状态：查看 Windows 系统状态图片，并返回文字运行时间。\n硬件信息：查看硬件配置图。",
  };
}
