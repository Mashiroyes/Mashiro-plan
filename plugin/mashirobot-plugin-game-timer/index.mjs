import fs from "node:fs";
import path from "node:path";
import { resolvePlanSourcePath } from "../../core/runtime/source-paths.mjs";
import { parseGameTimerCommand } from "./core/parser.mjs";
import { addGameToConfig, findConfiguredGame, loadGameConfig, removeGamesFromConfig } from "./core/game-config.mjs";
import { buildTask } from "./core/timer-manager.mjs";
import { createGameTimerStore } from "./core/storage.mjs";
import { createGameVaultStore } from "./core/game-vault-storage.mjs";
import { createScheduler } from "./core/scheduler.mjs";
import {
  parseQqSessionCommand, evaluateQqSessionWindow, QQ_BEFORE_NOON_REPLY,
  QQ_OUTSIDE_DAILY_WINDOW_REPLY, QQ_SUNDAY_ONLY_REPLY, QQ_SUNDAY_ENDED_REPLY, QQ_SUNDAY_LIMIT_REPLY,
} from "./core/qq-session-parser.mjs";
import { buildQqRequest } from "./core/qq-session-model.mjs";
import { createQqSessionStore } from "./core/qq-session-storage.mjs";
import { createQqSessionScheduler } from "./core/qq-session-scheduler.mjs";
import { createAuditStore } from "./audit/core/audit-storage.mjs";
import { formatAuditSummary } from "./audit/core/audit-format.mjs";
import { buildAuditTargets, writeAuditTargetManifest } from "./audit/core/target-manifest.mjs";
import * as blockPlugin from "./block/index.mjs";
import { createPendingDeleteStore } from "./core/pending-delete-storage.mjs";
import { applyGameExecutableOverrides, readMachineConfig } from "../../core/config/machine-config.mjs";
import { registerGameTimerLifecycle } from "./lifecycle.mjs";

export const registerLifecycle = registerGameTimerLifecycle;

const pluginRoot = resolvePlanSourcePath("plugin", "mashirobot-plugin-game-timer");
const defaultConfigPath = path.join(pluginRoot, "core", "games.json");
const defaultSqlitePath = path.resolve(pluginRoot, "..", "..", "sqlite", "openclaw-planner.sqlite");
const defaultAuditTargetsPath = path.join(process.env.LOCALAPPDATA ?? pluginRoot, "MashiroBot", "usage-audit", "targets.json");
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

function chooseActiveTimer(store, shortId, now) {
  const active = store.listActive(now);
  if (shortId) {
    const target = active.find((task) => task.shortId?.toUpperCase() === shortId.toUpperCase());
    return target ? { target, active } : { error: `没有找到活动计时 ${shortId}。`, active };
  }
  if (active.length === 1) return { target: active[0], active };
  if (!active.length) return { error: "当前没有活动游戏计时。", active };
  return { error: `当前有 ${active.length} 个活动计时，请指定编号：${active.map((task) => task.shortId).join("、")}。`, active };
}

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
      context.undoManager?.record({ scope: `${context.accountId ?? "global"}:${context.conversationId ?? "global"}`, owner: "mashirobot-plugin-game-timer", actionKind: "game-config-delete", description: `删除游戏清单 ${removed.map((game) => game.displayName).join("、")}`, reversible: false, recoveryCommand: "重新发送“加入游戏”并粘贴原 exe 路径" });
      return reply(`已从游戏清单删除 ${removed.length} 项：${removed.map((game) => game.displayName).join("、") || "无"}。已启动的计时不会受影响。`, "删除游戏");
    }
    return reply("待删除操作无法识别，未执行。", "确认删除");
  }
  if (auditCommands.has(text)) return handleAuditQuery(text, context);
  const qqCommand = parseQqSessionCommand(text);
  if (qqCommand) {
    const now = context.now ?? new Date();
    const window = evaluateQqSessionWindow(now, qqCommand);
    if (!window.allowed) {
      const message = window.reason === "not-sunday" ? QQ_SUNDAY_ONLY_REPLY
        : window.reason === "sunday-ended" ? QQ_SUNDAY_ENDED_REPLY
        : window.reason === "before-noon" ? QQ_BEFORE_NOON_REPLY
          : QQ_OUTSIDE_DAILY_WINDOW_REPLY;
      return reply(message, "QQ限时");
    }
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
    const request = buildQqRequest({
      now, minutes: qqCommand.windowPolicy === "sunday-4h" ? window.playMinutes : qqCommand.minutes,
      windowPolicy: qqCommand.windowPolicy ?? "daily",
      specialLocalDate: qqCommand.windowPolicy === "sunday-4h" ? window.localDate : null,
    });
    const pending = store.createPreparing(request);
    if (!pending.created) {
      if (pending.reason === "sunday-limit") return reply(QQ_SUNDAY_LIMIT_REPLY, "QQ限时");
      return reply(formatExistingQqSession(pending.session), "QQ限时");
    }
    let scheduled;
    try {
      scheduled = await scheduler.begin(request);
      const confirmed = scheduled.session ?? store.get(request.id);
      if (!confirmed?.confirmedAt || confirmed.phase !== "playing" || scheduled.launch?.ok === false) throw new Error("QQ启动文件恢复后未能开始计时");
      if (request.windowPolicy === "sunday-4h" && !confirmed.specialConsumedAt) throw new Error("周日4小时QQ会话未完成当日次数登记");
    } catch (error) {
      store.fail(request.id, error.message);
      let recoveryError = null;
      try { await scheduler.recover(); } catch (recoveryFailure) { recoveryError = recoveryFailure; }
      return reply(`QQ限时没有启动：${error.message}${recoveryError ? `；回滚也失败：${recoveryError.message}` : "；已回滚本次授权"}`, "QQ限时");
    }
    const session = scheduled.session ?? store.get(request.id);
    const qqPaths = scheduled.launch?.executablePaths ?? preflight.status?.status?.qqExecutablePaths ?? scheduled.status?.qqExecutablePaths ?? [];
    let auditWarning = null;
    try { refreshAuditTargets(context, readGames(context), qqPaths); }
    catch (error) { auditWarning = `使用审计刷新失败：${error.message}`; }
    const cooldownMinutes = Math.round((new Date(session.cooldownEndsAt).getTime() - new Date(session.playEndsAt).getTime()) / 60_000);
    return reply(`QQ已允许使用 ${session.playMinutes} 分钟。\n${formatAt(session.playEndsAt)} 到期后关闭QQ，并把启动文件移入保护目录。\n之后进入${cooldownMinutes}分钟冷却，结束于 ${formatAt(session.cooldownEndsAt)}；冷却结束也不会自动恢复，下一次“玩QQ N分钟”才会恢复。QQ官网始终保持限制。${auditWarning ? `\n警告：${auditWarning}，不影响本次QQ启动和计时。` : ""}`, "QQ限时");
  }
  if (blockPlugin.match(text)) return await blockPlugin.handle(text, context);
  const command = parseGameTimerCommand(text);
  if (!command) throw new Error("无法解析游戏计时命令");

  const configs = readGames(context);
  const now = context.now ?? new Date();
  const databasePath = sqlitePath(context);
  const timerStore = context.gameTimerStore ?? createGameTimerStore(databasePath);
  const timerScheduler = context.gameTimerScheduler ?? createScheduler({ pluginRoot, sqlitePath: databasePath, runLocalProcess: context.runLocalProcess });
  if (command.kind === "timerList") {
    const active = timerStore.listActive(now);
    return reply(active.length ? active.map((task) => `${task.shortId} ${task.displayName}：提醒 ${formatAt(task.reminderAt)}，强退 ${formatAt(task.forceAt)}`).join("\n") : "当前没有活动游戏计时。", "查询游戏计时");
  }
  if (["timerCancel", "timerExtend", "timerEnd"].includes(command.kind)) {
    const selected = chooseActiveTimer(timerStore, command.shortId, now);
    if (!selected.target) return reply(selected.error, "游戏计时控制");
    const target = selected.target;
    if (command.kind === "timerCancel") {
      await timerScheduler.remove(target);
      timerStore.cancel(target.id, new Date(now).toISOString());
      return reply(`已取消 ${target.shortId} ${target.displayName} 的提醒和强退任务。`, "取消游戏计时");
    }
    if (command.kind === "timerExtend") {
      await timerScheduler.remove(target);
      const extended = timerStore.extend(target.id, command.minutes, new Date(now).toISOString());
      if (!extended) return reply("计时状态已经变化，未执行延长。", "延长游戏计时");
      try {
        const scheduled = await timerScheduler.schedule(extended);
        timerStore.activate(extended.id, scheduled, new Date(now).toISOString());
        return reply(`已将 ${extended.shortId} ${extended.displayName} 延长 ${command.minutes} 分钟。\n提醒：${formatAt(extended.reminderAt)}\n强退：${formatAt(extended.forceAt)}`, "延长游戏计时");
      } catch (error) {
        timerStore.fail(extended.id, error.message);
        return reply(`延长后的 Windows 任务创建失败，计时已停止：${error.message}`, "延长游戏计时");
      }
    }
    await timerScheduler.remove(target);
    try {
      await timerScheduler.forceNow(target);
      context.undoManager?.record({ scope: `${context.accountId ?? "global"}:${context.conversationId ?? "global"}`, owner: "mashirobot-plugin-game-timer", actionKind: "force-end", description: `立即结束 ${target.shortId} ${target.displayName}`, reversible: false, recoveryCommand: "发送“恢复所有游戏文件”" });
      return reply(`已立即结束 ${target.shortId} ${target.displayName} 的计时，并执行关闭流程。`, "立即结束游戏计时");
    } catch (error) {
      return reply(`立即结束执行失败：${error.message}`, "立即结束游戏计时");
    }
  }
  if (command.kind === "recoverAllGames") {
    const completed = await (context.runLocalProcess ?? (async (options) => (await import("../../core/execution/local-process.mjs")).runLocalProcess(options)))({
      executable: "schtasks.exe", args: ["/Run", "/TN", "MashiroBot-GameLocker-RecoverAll"], timeoutMs: 15_000, output: "text",
    });
    return reply(`已启动最高权限的游戏文件恢复检查。${completed?.stdout ? "" : "恢复在后台继续执行。"}`, "恢复所有游戏文件");
  }
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
  const protectedRecord = createGameVaultStore(sqlitePath(context)).hasProtectedGame(game.key);
  if (protectedRecord) {
    const due = protectedRecord.restoreDueAt ? `，预计恢复：${formatAt(protectedRecord.restoreDueAt)}` : "";
    return reply(`游戏启动文件仍在保护中，不能开始计时${due}。`, "游戏保护");
  }
  const task = buildTask({ game, minutes: command.minutes, forceAfter: command.forceAfter, now });
  const store = timerStore;
  const pending = store.createPending(task);
  if (!pending.created) {
    return reply(`真白，${pending.task.displayName}已有计时任务，当前任务不会被覆盖。\n提醒：${formatAt(pending.task.reminderAt)}\n强退：${formatAt(pending.task.forceAt)}\n解锁：${formatAt(pending.task.lockUntil)}`);
  }
  const scheduler = timerScheduler;
  try {
    const scheduled = await scheduler.schedule(task);
    store.activate(task.id, scheduled, new Date(now).toISOString());
    const saved = store.get(task.id);
    context.undoManager?.record({
      scope: `${context.accountId ?? "global"}:${context.conversationId ?? "global"}`,
      owner: "mashirobot-plugin-game-timer", actionKind: "game-timer",
      description: `${saved.shortId} ${game.displayName} 游戏计时`,
      inversePayload: { id: saved.id, reminderTaskName: saved.reminderTaskName, forceTaskName: saved.forceTaskName },
    });
    return reply(`已设置 ${saved.shortId} ${game.displayName}：\n${formatAt(task.reminderAt)} 微信提醒关闭\n${formatAt(task.forceAt)} 未关闭则强退\n${formatAt(task.lockUntil)} 后允许重新设置。\n可发送“取消 ${saved.shortId}”“延长 ${saved.shortId} 30分钟”或“立即结束 ${saved.shortId}”。`);
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
          "玩QQ1—60分钟（每天12:00—22:00可用）",
          "周末玩QQ4h（仅星期日、当天一次；20:00后截短到24:00）",
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
          "查询游戏计时；取消游戏计时/取消 G编号；延长 G编号 30分钟；立即结束 G编号",
          "恢复所有游戏文件：启动最高权限恢复任务，不受游戏禁止规则限制",
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
          "每天仅12:00—22:00可用",
          "客户端按指令临时放行1—60分钟；每次结束后固定冷却60分钟",
          "周末玩QQ4h仅星期日可成功启动一次；20:00前最多4小时，之后截短到24:00，结束后冷却60分钟",
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
