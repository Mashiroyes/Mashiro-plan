import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseBlockCommand, getExpiry, getReleaseExpiry } from "./core/parser.mjs";
import { createBlockStore } from "./core/storage.mjs";
import { createBlockSyncer } from "./core/syncer.mjs";
import { createPendingDeleteStore } from "../core/pending-delete-storage.mjs";

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

export function match(message) { return parseBlockCommand(message) !== null; }

export async function handle(message, context = {}) {
  const command = parseBlockCommand(message, context.now ?? new Date());
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
  const now = context.now ?? new Date();
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
      await syncer.apply({ sqlitePath: store.sqlitePath, release });
      return result(`已临时解除 ${displayName}，至 ${formatAt(release.expiresAt)}。到期后会自动恢复禁止。\n额度：${formatQuotaRemaining(releaseResult.quota.periods)}。\n今天“解除N分钟”的默认网站：${store.getDailyReleaseDefault(now)?.displayName ?? "bilibili.com"}`, "临时解除网站");
    } catch (error) {
      return result(`已保存 ${displayName} 的临时解除时段，但系统同步失败：${error.message}`, "临时解除网站");
    }
  }
  if (command.kind === "restore") {
    const removed = store.restoreRelease(command.targetKey, now);
    if (!removed) return result(`${command.displayName} 当前没有临时解除。`, "恢复网站禁止");
    try {
      await syncer.apply({ sqlitePath: store.sqlitePath });
      return result(`已提前结束 ${command.displayName} 的临时解除，并恢复禁止。`, "恢复网站禁止");
    } catch (error) {
      return result(`已结束 ${command.displayName} 的临时解除，但系统同步失败：${error.message}`, "恢复网站禁止");
    }
  }
  const row = store.upsert({ kind: command.ruleKind, targetKey: command.targetKey, displayName: command.displayName, expiresAt: getExpiry(command, now) }, now);
  let syncResult;
  try {
    syncResult = await syncer.apply({ sqlitePath: store.sqlitePath, row });
  } catch (error) {
    return result(`已保存禁止规则：${row.displayName}（${formatExpiry(row)}），但系统同步失败：${error.message}\n请先安装禁止名单 worker。`, "设置禁止名单");
  }
  if (syncResult?.scheduled) return result(`已保存禁止规则：${row.displayName}（${formatExpiry(row)}）。系统任务会在 1 分钟内同步；Clash 开启或关闭时都会继续阻止。`, "设置禁止名单");
  return result(`已生效：${row.displayName}（${formatExpiry(row)}）。Clash 开启或关闭时都会继续阻止。`, "设置禁止名单");
}

export async function confirmDeleteRules(payload, context = {}) {
  const now = context.now ?? new Date();
  const store = createBlockStore(context.sqlitePath);
  const deletion = store.deactivateMany(payload.items ?? [], now);
  const syncer = context.blockSyncer ?? createBlockSyncer({ taskName: context.blockTaskName ?? TASK_NAME, runLocalProcess: context.runLocalProcess });
  const names = (payload.items ?? []).map((item) => item.displayName).join("、");
  try {
    await syncer.apply({ sqlitePath: store.sqlitePath });
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
