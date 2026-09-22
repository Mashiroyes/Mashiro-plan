import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseBlockCommand, getExpiry, getReleaseExpiry } from "./core/parser.mjs";
import { createBlockStore } from "./core/storage.mjs";
import { createBlockSyncer } from "./core/syncer.mjs";
import { createPendingDeleteStore } from "../core/pending-delete-storage.mjs";
import { randomUUID } from "node:crypto";
import { applyControlMigrations, openControlDatabase } from "../../../core/control/database.mjs";
import { classifyBlockRisk } from "./core/protected-targets.mjs";
import { createOperationJournal } from "../../../core/control/operation-journal.mjs";

const pluginRoot = path.dirname(fileURLToPath(import.meta.url));
const TASK_NAME = "MashiroBot-mashirobot-plugin-block-Reapply";
function result(reply, command = "禁止名单") { return { handled: true, command, reply, mediaPaths: [] }; }
function formatExpiry(row) { return row.expiresAt ? `至 ${new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "short" }).format(new Date(row.expiresAt))}` : "永久"; }
function formatRules(rows, releases = [], dailyDefault = null) {
  if (!rows.length && !releases.length) return "当前没有生效的禁止名单。";
  const sections = [];
  if (rows.length) sections.push(`禁止规则：\n${rows.map((row, i) => `${i + 1}. ${row.kind === "software" ? "[软件]" : "[网站]"} ${row.displayName}（${formatExpiry(row)}）`).join("\n")}`);
  if (releases.length) sections.push(`临时解除：\n${releases.map((row) => `- ${row.displayName}（至 ${formatAt(row.expiresAt)}）`).join("\n")}`);
  sections.push(`今天“解除N分钟”的默认网站：${dailyDefault?.displayName ?? "bilibili.com"}`);
  return sections.join("\n\n");
}

function formatAt(value) {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "medium" }).format(new Date(value));
}

function wholeRemaining(value) { return Math.max(0, Math.floor(Number(value) + 1e-9)); }
function formatQuotaRemaining(periods) {
  return periods.map((period) => `${period.label}剩余 ${wholeRemaining(period.remainingMinutes)} 分钟`).join("，");
}

const CONFIRM_BLOCK = /^确认禁止\s+(B[0-9A-F]{3})$/iu;
export function match(message) { return CONFIRM_BLOCK.test(String(message ?? "").trim()) || parseBlockCommand(message) !== null; }

function savePendingHighRisk(sqlitePath, command, impact, now) {
  const db = openControlDatabase(sqlitePath);
  try {
    applyControlMigrations(db);
    let actionId;
    do { actionId = `B${randomUUID().replaceAll("-", "").slice(0, 3).toUpperCase()}`; }
    while (db.prepare("SELECT 1 FROM pending_high_risk_actions WHERE action_id=?").get(actionId));
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(new Date(now).getTime() + 10 * 60_000).toISOString();
    db.prepare("INSERT INTO pending_high_risk_actions(action_id,owner,action_kind,payload_json,impact_summary,expires_at,created_at) VALUES(?, 'mashirobot-plugin-game-timer', 'block-rule', ?, ?, ?, ?)")
      .run(actionId, JSON.stringify(command), impact, expiresAt, createdAt);
    return { actionId, expiresAt };
  } finally { db.close(); }
}

function consumePendingHighRisk(sqlitePath, actionId, now) {
  const db = openControlDatabase(sqlitePath);
  try {
    applyControlMigrations(db);
    db.prepare("DELETE FROM pending_high_risk_actions WHERE expires_at<=?").run(new Date(now).toISOString());
    const row = db.prepare("SELECT * FROM pending_high_risk_actions WHERE action_id=? AND owner='mashirobot-plugin-game-timer' AND action_kind='block-rule'").get(actionId);
    if (!row) return null;
    db.prepare("DELETE FROM pending_high_risk_actions WHERE action_id=?").run(actionId);
    return { command: JSON.parse(row.payload_json), impact: row.impact_summary };
  } finally { db.close(); }
}

async function applyWithJournal(syncer, sqlitePath, { targetKey, kind, payload }, now) {
  const journal = createOperationJournal(sqlitePath, { now: () => new Date(now) });
  const operation = journal.prepare({ owner: "mashirobot-plugin-game-timer", kind, targetKey, ruleId: targetKey });
  journal.transition(operation.operationId, "applying");
  try {
    const resultValue = await syncer.apply(payload);
    journal.transition(operation.operationId, "applied");
    return resultValue;
  } catch (error) {
    journal.transition(operation.operationId, "failed", { error: error.message });
    throw error;
  }
}

async function applyBlockRule(command, context, now) {
  const store = createBlockStore(context.sqlitePath);
  const syncer = context.blockSyncer ?? createBlockSyncer({ taskName: context.blockTaskName ?? TASK_NAME, runLocalProcess: context.runLocalProcess });
  const row = store.upsert({ kind: command.ruleKind, targetKey: command.targetKey, displayName: command.displayName, expiresAt: getExpiry(command, now) }, now);
  let syncResult;
  try { syncResult = await applyWithJournal(syncer, store.sqlitePath, { targetKey: row.targetKey, kind: "block-sync", payload: { sqlitePath: store.sqlitePath, row } }, now); }
  catch (error) { return result(`已保存禁止规则：${row.displayName}（${formatExpiry(row)}），但系统同步失败：${error.message}\n请先安装禁止名单 worker。`, "设置禁止名单"); }
  if (syncResult?.scheduled) return result(`已保存禁止规则：${row.displayName}（${formatExpiry(row)}）。系统任务会在 1 分钟内同步；Clash 开启或关闭时都会继续阻止。`, "设置禁止名单");
  return result(`已生效：${row.displayName}（${formatExpiry(row)}）。Clash 开启或关闭时都会继续阻止。`, "设置禁止名单");
}

export async function handle(message, context = {}) {
  const now = context.now ?? new Date();
  const confirm = CONFIRM_BLOCK.exec(String(message ?? "").trim());
  if (confirm) {
    const pending = consumePendingHighRisk(context.sqlitePath, confirm[1].toUpperCase(), now);
    if (!pending) return result("没有找到该待确认规则，或者确认已超过10分钟。", "确认禁止");
    return applyBlockRule(pending.command, context, now);
  }
  const command = parseBlockCommand(message, now);
  if (!command) throw new Error("无法解析禁止名单指令。");
  if (command.kind === "help") return await context.renderPluginHelp?.("mashirobot-plugin-game-timer", { detailed: command.detailed }) ?? result("禁止名单：禁止下载QQ7天；禁止访问baidu.com永久；查询禁止名单。", "禁止名单帮助");
  const store = createBlockStore(context.sqlitePath);
  if (command.kind === "list") {
    const now = context.now ?? new Date();
    return result(formatRules(store.listEffective(now), store.listReleases(now), store.getDailyReleaseDefault(now)), "查询禁止名单");
  }
  if (command.kind === "deletePreview") {
    const now = context.now ?? new Date();
    const rows = store.listEffective(now);
    const invalid = command.indices.filter((index) => index > rows.length);
    if (invalid.length) return result(`序号不存在：${invalid.join("、")}。未删除任何规则。`, "删除禁止规则");
    const items = command.indices.map((index) => rows[index - 1]);
    const pending = context.pendingDeleteStore ?? createPendingDeleteStore(store.sqlitePath);
    pending.save("blockRules", { items: items.map(({ kind, targetKey, displayName }) => ({ kind, targetKey, displayName })) }, now);
    return result(`准备删除以下禁止规则：\n${items.map((row) => `- ${row.displayName}`).join("\n")}\n请在10分钟内发送“确认删除”。`, "删除禁止规则");
  }
  const syncer = context.blockSyncer ?? createBlockSyncer({ taskName: context.blockTaskName ?? TASK_NAME, runLocalProcess: context.runLocalProcess });
  if (command.kind === "release") {
    let targetKey = command.targetKey;
    let displayName = command.displayName;
    if (!command.explicit) {
      const daily = store.getDailyReleaseDefault(now);
      targetKey = daily?.targetKey ?? "bilibili.com";
      displayName = daily?.displayName ?? "bilibili.com";
    }
    if (!store.getEffectiveWebsite(targetKey, now)) return result(`当前没有 ${displayName} 的生效网站禁止规则，未执行解除。`, "临时解除网站");
    const releaseResult = store.tryRelease({ targetKey, displayName, expiresAt: getReleaseExpiry(command, now) }, now);
    if (!releaseResult.allowed) {
      const insufficient = releaseResult.quota.periods.filter((period) => period.remainingMinutes < 0);
      const available = insufficient.map((period) => ({ ...period, remainingMinutes: period.limitMinutes - period.usedMinutes }));
      return result(`${displayName} 本次无法解除：${formatQuotaRemaining(available)}。请将解除时长改为不超过剩余额度。`, "临时解除网站");
    }
    if (command.explicit) store.setDailyReleaseDefault(targetKey, displayName, now);
    const release = releaseResult.release;
    try {
      await applyWithJournal(syncer, store.sqlitePath, { targetKey, kind: "block-release-sync", payload: { sqlitePath: store.sqlitePath, release } }, now);
      return result(`已临时解除 ${displayName}，至 ${formatAt(release.expiresAt)}。到期后会自动恢复禁止。\n额度：${formatQuotaRemaining(releaseResult.quota.periods)}。\n今天“解除N分钟”的默认网站：${store.getDailyReleaseDefault(now)?.displayName ?? "bilibili.com"}`, "临时解除网站");
    } catch (error) {
      return result(`已保存 ${displayName} 的临时解除时段，但系统同步失败：${error.message}`, "临时解除网站");
    }
  }
  if (command.kind === "restore") {
    const removed = store.restoreRelease(command.targetKey, now);
    if (!removed) return result(`${command.displayName} 当前没有临时解除。`, "恢复网站禁止");
    try {
      await applyWithJournal(syncer, store.sqlitePath, { targetKey: command.targetKey, kind: "block-restore-sync", payload: { sqlitePath: store.sqlitePath } }, now);
      return result(`已提前结束 ${command.displayName} 的临时解除，并恢复禁止。`, "恢复网站禁止");
    } catch (error) {
      return result(`已结束 ${command.displayName} 的临时解除，但系统同步失败：${error.message}`, "恢复网站禁止");
    }
  }
  const risk = classifyBlockRisk(command);
  if (risk.decision === "reject") return result(`未执行：${risk.impact}`, "设置禁止名单");
  if (risk.decision === "confirm") {
    const pending = savePendingHighRisk(store.sqlitePath, command, risk.impact, now);
    return result(`${risk.impact}\n如确认执行，请在10分钟内发送“确认禁止 ${pending.actionId}”。`, "确认高风险禁止");
  }
  return applyBlockRule(command, context, now);
}

export async function confirmDeleteRules(payload, context = {}) {
  const now = context.now ?? new Date();
  const store = createBlockStore(context.sqlitePath);
  const deletion = store.deactivateMany(payload.items ?? [], now);
  const syncer = context.blockSyncer ?? createBlockSyncer({ taskName: context.blockTaskName ?? TASK_NAME, runLocalProcess: context.runLocalProcess });
  const names = (payload.items ?? []).map((item) => item.displayName).join("、");
  try {
    await applyWithJournal(syncer, store.sqlitePath, { targetKey: "deleted-rules", kind: "block-delete-sync", payload: { sqlitePath: store.sqlitePath } }, now);
    context.undoManager?.record({ scope: `${context.accountId ?? "global"}:${context.conversationId ?? "global"}`, owner: "mashirobot-plugin-game-timer", actionKind: "block-delete", description: `删除禁止规则 ${names}`, reversible: false, recoveryCommand: "按原命令重新添加对应禁止规则" });
    return result(`已删除 ${deletion.changes} 条禁止规则：${names || "无"}。系统限制已同步移除。`, "删除禁止规则");
  } catch (error) {
    return result(`已从禁止名单删除 ${deletion.changes} 条规则，但系统同步失败：${error.message}`, "删除禁止规则");
  }
}

export function healthCheck() {
  const worker = path.join(pluginRoot, "powershell", "BlockWorker.ps1");
  return { ok: fs.existsSync(worker), name: "game-timer-block-module", worker };
}

export function getHelp() {
  return {
    groups: [{ title: "设置禁止规则", items: ["禁止下载QQ7天", "禁止访问bilibili.com永久", "支持天、小时和永久"] }, { title: "临时解除", items: ["解除bilibili10分钟", "解除10分钟：使用今天最近一次明确指定的网站，未指定时默认 bilibili.com", "每个网站独立限额：上午20分钟、下午30分钟、晚上30分钟", "立即恢复bilibili"] }, { title: "查询与删除", items: ["查询禁止名单", "删除禁止规则2，4，6，然后确认删除"] }],
    detailedGroups: [{ title: "软件", items: ["支持 QQ、Bilibili 预配置规则", "软件规则同时阻止启动、安装包和官方下载域名"] }, { title: "网站", items: ["可填写 http/https URL 或域名", "永久规则同时写入 Hosts、Chrome/Edge 与 Clash", "临时解除不会删除永久规则，到期后自动恢复", "额度不足时整次请求会被拒绝，不会自动缩短"] }],
    fallbackText: "禁止下载QQ7天\n禁止访问bilibili.com永久\n解除bilibili10分钟\n解除10分钟\n立即恢复bilibili\n查询禁止名单\n删除禁止规则2，4，6\n确认删除",
  };
}
