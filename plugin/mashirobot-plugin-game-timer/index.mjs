import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseGameTimerCommand } from "./core/parser.mjs";
import { addGameToConfig, findConfiguredGame, loadGameConfig, removeGamesFromConfig } from "./core/game-config.mjs";
import { buildTask } from "./core/timer-manager.mjs";
import { createGameTimerStore } from "./core/storage.mjs";
import { createGameVaultStore } from "./core/game-vault-storage.mjs";
import { createScheduler } from "./core/scheduler.mjs";
import { parseQqSessionCommand, canStartQqSession, QQ_BEFORE_NOON_REPLY } from "./core/qq-session-parser.mjs";
import { buildQqRequest } from "./core/qq-session-model.mjs";
import { createQqSessionStore } from "./core/qq-session-storage.mjs";
import { createQqSessionScheduler } from "./core/qq-session-scheduler.mjs";
import { createAuditStore } from "./audit/core/audit-storage.mjs";
import { formatAuditSummary } from "./audit/core/audit-format.mjs";
import { buildAuditTargets, writeAuditTargetManifest } from "./audit/core/target-manifest.mjs";
import * as blockPlugin from "./block/index.mjs";
import { createPendingDeleteStore } from "./core/pending-delete-storage.mjs";
import { applyGameExecutableOverrides, readMachineConfig } from "../../core/config/machine-config.mjs";

const pluginRoot = path.dirname(fileURLToPath(import.meta.url));
const defaultConfigPath = path.join(pluginRoot, "core", "games.json");
const defaultSqlitePath = path.resolve(pluginRoot, "..", "..", "sqlite", "openclaw-planner.sqlite");
const defaultAuditTargetsPath = path.join(process.env.LOCALAPPDATA ?? pluginRoot, "MashiroBot", "usage-audit", "targets.json");
const defaultQqNoonReleasePath = path.join(process.env.ProgramData ?? "C:\\ProgramData", "MashiroBot", "mashirobot-plugin-game-timer", "qq", "before-noon-release.json");
const auditCommands = new Set(["查询今日使用审计", "查询本周使用审计", "查询QQ使用"]);

function configPath(context) { return context.gameTimerConfigPath ?? defaultConfigPath; }
function sqlitePath(context) { return context.sqlitePath ?? defaultSqlitePath; }
function readGames(context) {
  const raw = JSON.parse(fs.readFileSync(configPath(context), "utf8"));
  const machine = context.machineConfig ?? (() => { try { return readMachineConfig(); } catch { return null; } })();
  return loadGameConfig({ ...raw, games: applyGameExecutableOverrides(raw.games ?? [], machine) });
}
function reply(text, command = "游戏计时") { return { handled: true, command, reply: text, mediaPaths: [] }; }
function formatAt(value) { return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "medium" }).format(new Date(value)); }

function formatExistingQqSession(session) {
  if (session.phase === "preparing" || !session.playEndsAt) return "QQ正在准备中，请不要重复发送指令。";
  const label = session.phase === "playing" ? "QQ正在限时使用中" : "QQ正在冷却中";
  return `${label}，不能重新计时。\n游玩结束：${formatAt(session.playEndsAt)}\n冷却结束：${formatAt(session.cooldownEndsAt)}`;
}

function shanghaiDateKey(value) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(value));
}

function shanghaiWeekStart(value) {
  const key = shanghaiDateKey(value);
  const midnight = new Date(`${key}T00:00:00Z`);
  const daysFromMonday = (midnight.getUTCDay() + 6) % 7;
  midnight.setUTCDate(midnight.getUTCDate() - daysFromMonday);
  return midnight.toISOString().slice(0, 10);
}

function qqScheduler(context) {
  return context.qqSessionScheduler ?? createQqSessionScheduler({ pluginRoot, sqlitePath: sqlitePath(context), runLocalProcess: context.runLocalProcess });
}

function hasTemporaryQqNoonRelease(context, now) {
  const releasePath = context.qqNoonReleasePath ?? defaultQqNoonReleasePath;
  try {
    const state = JSON.parse(fs.readFileSync(releasePath, "utf8"));
    const expiresAt = new Date(state.expiresAt);
    return state.purpose === "qq-before-noon-test" && !Number.isNaN(expiresAt.getTime()) && new Date(now) < expiresAt;
  } catch { return false; }
}

function persistedQqPaths(context, store, targetPath) {
  const fromStore = typeof store.listTargets === "function"
    ? store.listTargets().filter((target) => target.key === "qq").map((target) => target.executablePath).filter(Boolean)
    : [];
  if (fromStore.length) return fromStore;
  try {
    const manifest = JSON.parse(fs.readFileSync(targetPath, "utf8"));
    return (manifest.targets ?? []).filter((target) => target.key === "qq").map((target) => target.executablePath).filter(Boolean);
  } catch {
    return [];
  }
}

function refreshAuditTargets(context, games, qqExecutablePaths = null) {
  const targetPath = context.auditTargetsPath ?? defaultAuditTargetsPath;
  const store = context.auditStore ?? createAuditStore(sqlitePath(context));
  const qqPaths = qqExecutablePaths === null ? persistedQqPaths(context, store, targetPath) : qqExecutablePaths;
  const targets = buildAuditTargets(games, qqPaths);
  writeAuditTargetManifest(targetPath, targets);
  if (typeof store.replaceTargets === "function") store.replaceTargets(targets);
  return targets;
}

function handleAuditQuery(text, context) {
  const now = context.now ?? new Date();
  const today = shanghaiDateKey(now);
  const store = context.auditStore ?? createAuditStore(sqlitePath(context));
  const targets = typeof store.listTargets === "function" ? store.listTargets() : [];
  const names = Object.fromEntries(targets.map((target) => [target.key, target.displayName]));
  names.qq = "QQ";
  if (text === "查询今日使用审计") {
    return reply(formatAuditSummary(store.summary({ from: today, to: today }), "今日应用前台使用", names), "使用审计");
  }
  if (text === "查询本周使用审计") {
    return reply(formatAuditSummary(store.summary({ from: shanghaiWeekStart(now), to: today }), "本周应用前台使用", names), "使用审计");
  }
  const summary = store.summary({ from: today, to: today, targetKey: "qq" });
  const sessionStore = createQqSessionStore(sqlitePath(context));
  const active = sessionStore.getActive(now);
  let body = formatAuditSummary(summary, "今日QQ前台使用", names);
  if (active) body += `\n当前状态：${active.phase}；游玩结束 ${formatAt(active.playEndsAt)}；冷却结束 ${formatAt(active.cooldownEndsAt)}。`;
  const recent = active ? sessionStore.listRecentEvents(active.id, 5).filter((event) => event.result === "failed") : [];
  if (recent.length) body += `\n最近执行失败：${recent[0].error ?? recent[0].action}`;
  return reply(body, "使用审计");
}

export function match(message) {
  const text = String(message ?? "").trim();
  return text === "/游戏计时" || text === "/游戏计时详细" || auditCommands.has(text) ||
    text === "确认删除" ||
    parseQqSessionCommand(text) !== null || blockPlugin.match(text) || parseGameTimerCommand(text) !== null;
}

export async function handle(message, context = {}) {
  const text = String(message ?? "").trim();
  if (text === "/游戏计时") return await context.renderPluginHelp("mashirobot-plugin-game-timer", { detailed: false });
  if (text === "/游戏计时详细") return await context.renderPluginHelp("mashirobot-plugin-game-timer", { detailed: true });
  if (text === "确认删除") {
    const pending = (context.pendingDeleteStore ?? createPendingDeleteStore(sqlitePath(context))).consume(context.now ?? new Date());
    if (!pending) return reply("当前没有待确认的删除操作，或者确认已超过10分钟。", "确认删除");
    if (pending.actionKind === "blockRules") return await blockPlugin.confirmDeleteRules(pending.payload, context);
    if (pending.actionKind === "games") {
      const removed = removeGamesFromConfig(configPath(context), pending.payload.keys ?? []);
      refreshAuditTargets(context, readGames(context));
      return reply(`已从游戏清单删除 ${removed.length} 项：${removed.map((game) => game.displayName).join("、") || "无"}。已启动的计时不会受影响。`, "删除游戏");
    }
    return reply("待删除操作无法识别，未执行。", "确认删除");
  }
  if (auditCommands.has(text)) return handleAuditQuery(text, context);
  const qqCommand = parseQqSessionCommand(text);
  if (qqCommand) {
    const now = context.now ?? new Date();
    if (!canStartQqSession(now) && !hasTemporaryQqNoonRelease(context, now)) return reply(QQ_BEFORE_NOON_REPLY, "QQ限时");
    const databasePath = sqlitePath(context);
    let store = null;
    if (fs.existsSync(databasePath)) {
      store = createQqSessionStore(databasePath);
      const existing = store.getBlockingSession(now);
      if (existing) return reply(formatExistingQqSession(existing), "QQ限时");
    }
    const scheduler = qqScheduler(context);
    const preflight = context.qqPreflight ? await context.qqPreflight({ now, scheduler }) : await scheduler.preflight();
    if (!preflight?.ok) return reply(`暂时不能开始QQ限时：${(preflight?.errors ?? ["执行环境未通过检查"]).join("；")}。`, "QQ限时");
    store ??= createQqSessionStore(databasePath);
    const request = buildQqRequest({ now, minutes: qqCommand.minutes });
    const pending = store.createPreparing(request);
    if (!pending.created) {
      return reply(formatExistingQqSession(pending.session), "QQ限时");
    }
    try {
      const scheduled = await scheduler.begin(request);
      const session = scheduled.session ?? store.get(request.id);
      if (!session?.confirmedAt || session.phase !== "playing") throw new Error("QQ启动文件恢复后未能开始计时");
      const qqPaths = preflight.status?.status?.qqExecutablePaths ?? scheduled.status?.qqExecutablePaths ?? [];
      refreshAuditTargets(context, readGames(context), qqPaths);
      const cooldownMinutes = Math.round((new Date(session.cooldownEndsAt).getTime() - new Date(session.playEndsAt).getTime()) / 60_000);
      return reply(`QQ已允许使用 ${session.playMinutes} 分钟。\n${formatAt(session.playEndsAt)} 到期后关闭QQ，并把启动文件移入保护目录。\n之后进入${cooldownMinutes}分钟冷却，结束于 ${formatAt(session.cooldownEndsAt)}；冷却结束也不会自动恢复，下一次“玩QQ N分钟”才会恢复。QQ官网始终保持限制。`, "QQ限时");
    } catch (error) {
      store.fail(request.id, error.message);
      let recoveryError = null;
      try { await scheduler.recover(); } catch (recoveryFailure) { recoveryError = recoveryFailure; }
      return reply(`QQ限时没有启动：${error.message}${recoveryError ? `；恢复也失败：${recoveryError.message}` : ""}`, "QQ限时");
    }
  }
  if (blockPlugin.match(text)) return await blockPlugin.handle(text, context);
  const command = parseGameTimerCommand(text);
  if (!command) throw new Error("无法解析游戏计时命令");

  const configs = readGames(context);
  if (command.kind === "add") {
    const result = addGameToConfig(configPath(context), command.executablePath);
    refreshAuditTargets(context, readGames(context));
    return reply(result.created ? `已加入游戏：${result.game.displayName}（${result.game.processName}）` : `游戏已在清单中：${result.game.displayName}`, "加入游戏");
  }
  if (command.kind === "list") {
    return reply(configs.map((game, index) => `${index + 1}. ${game.displayName}（${game.processName}）`).join("\n") || "游戏清单为空。", "查看游戏");
  }
  if (command.kind === "deletePreview") {
    const invalid = command.indices.filter((index) => index > configs.length);
    if (invalid.length) return reply(`序号不存在：${invalid.join("、")}。未删除任何游戏。`, "删除游戏");
    const games = command.indices.map((index) => configs[index - 1]);
    const pending = context.pendingDeleteStore ?? createPendingDeleteStore(sqlitePath(context));
    pending.save("games", { keys: games.map((game) => game.key) }, context.now ?? new Date());
    return reply(`准备删除以下游戏：\n${games.map((game) => `- ${game.displayName}`).join("\n")}\n请在10分钟内发送“确认删除”。`, "删除游戏");
  }
  const game = findConfiguredGame(command.game, configs);
  if (!game) throw new Error(`游戏未加入清单：${command.game}。请先发送“加入游戏”并提供 exe 路径。`);
  const now = context.now ?? new Date();
  const protectedRecord = createGameVaultStore(sqlitePath(context)).hasProtectedGame(game.key);
  if (protectedRecord) {
    const due = protectedRecord.restoreDueAt ? `，预计恢复：${formatAt(protectedRecord.restoreDueAt)}` : "";
    return reply(`游戏启动文件仍在保护中，不能开始计时${due}。`, "游戏保护");
  }
  const task = buildTask({ game, minutes: command.minutes, forceAfter: command.forceAfter, now });
  const store = createGameTimerStore(sqlitePath(context));
  const pending = store.createPending(task);
  if (!pending.created) {
    return reply(`真白，${pending.task.displayName}已有计时任务，当前任务不会被覆盖。\n提醒：${formatAt(pending.task.reminderAt)}\n强退：${formatAt(pending.task.forceAt)}\n解锁：${formatAt(pending.task.lockUntil)}`);
  }
  const scheduler = context.gameTimerScheduler ?? createScheduler({ pluginRoot, sqlitePath: sqlitePath(context), runLocalProcess: context.runLocalProcess });
  try {
    const scheduled = await scheduler.schedule(task);
    store.activate(task.id, scheduled, new Date(now).toISOString());
    return reply(`已设置 ${game.displayName}：\n${formatAt(task.reminderAt)} 微信提醒关闭\n${formatAt(task.forceAt)} 未关闭则强退\n${formatAt(task.lockUntil)} 后允许重新设置。`);
  } catch (error) {
    let recoveryError = null;
    try { await scheduler.remove({ reminderTaskName: null, forceTaskName: null }); } catch (failure) { recoveryError = failure; }
    store.fail(task.id, error.message);
    return reply(`游戏计时没有启动：${error.message}${recoveryError ? `；清理也失败：${recoveryError.message}` : ""}`, "游戏计时");
  }
}

export function healthCheck() {
  const games = readGames({});
  const block = blockPlugin.healthCheck();
  return { ok: games.length > 0 && block.ok, name: "mashirobot-plugin-game-timer", gameCount: games.length, block };
}

export function getHelp() {
  const gameHelp = {
    groups: [
      {
        title: "开始游戏计时",
        items: [
          "玩饥荒联机版15分钟",
          "玩饥荒联机版15分钟，提醒后5分钟强退",
          "计时从消息发出时立即开始，不等待游戏启动",
        ],
      },
      {
        title: "游戏管理",
        items: [
          "查看游戏",
          "加入游戏（下一行填写完整 exe 路径）",
          "删除游戏2，4，6，然后确认删除",
        ],
      },
      {
        title: "QQ限时与使用审计",
        items: [
          "玩QQ1—60分钟（每天12:00后可用）",
          "查询今日使用审计 / 查询本周使用审计 / 查询QQ使用",
          "QQ到期只保护启动文件，保留登录、聊天记录、缓存和安装目录",
        ],
      },
      {
        title: "限制规则",
        items: [
          "同一游戏在锁定期内不能覆盖或重新设置",
          "所有被插件实际强退的游戏都会把 EXE 随机改名并保护2小时",
          "只关闭进程名和完整路径都匹配的游戏，不关闭 Steam",
          "微信端不提供取消计时指令",
        ],
      },
    ],
    detailedGroups: [
      {
        title: "计时指令",
        items: [
          "玩游戏名15分钟",
          "玩游戏名1小时",
          "玩游戏名15分钟，提醒后5分钟强退",
          "未填写宽限时间时默认10分钟",
        ],
      },
      {
        title: "添加与查询",
        items: [
          "加入游戏后换行填写本机 exe 的完整绝对路径",
          "查看游戏：列出所有已加入游戏",
        ],
      },
      {
        title: "QQ特殊规则",
        items: [
          "12:00前拒绝QQ请求且不改变任何限制",
          "客户端按指令临时放行1—60分钟；当天第1次冷却60分钟，之后每次增加10分钟",
          "QQ官网始终受限；冷却结束不恢复启动文件，QQ安装包会被自动删除",
          "QQ和清单中所有游戏只累计真实前台时间",
        ],
      },
      {
        title: "锁定与安全",
        items: [
          "锁定期=游戏时长+宽限时间+10分钟",
          "游戏提前退出也不会提前解除锁",
          "仅在插件实际强制结束进程后保护；提前自行退出或正常关闭时不保护",
          "保护期从 EXE 成功移走时开始计算2小时",
          "强退同时校验进程名和完整路径",
          "同名但路径不同的程序不会被关闭",
        ],
      },
    ],
    fallbackText: "游戏计时：玩饥荒联机版15分钟，提醒后5分钟强退。\n加入游戏：发送“加入游戏”并换行粘贴 exe 路径。\n查看游戏：查看已加入的游戏。",
  };
  const blockHelp = blockPlugin.getHelp();
  return {
    groups: [...gameHelp.groups, ...blockHelp.groups],
    detailedGroups: [...gameHelp.detailedGroups, ...blockHelp.detailedGroups],
    fallbackText: `${gameHelp.fallbackText}\n\n${blockHelp.fallbackText}`,
  };
}
