import { findSoftware } from "./software-config.mjs";

const COMMAND_RE = /^禁止(下载|访问)\s*(.+?)\s*(永久|([1-9]\d*)\s*(天|日|小时|时))$/u;
const RELEASE_EXPLICIT_RE = /^解除\s*(.+?)\s*([1-9]\d*)\s*分钟$/u;
const RELEASE_DEFAULT_RE = /^解除\s*([1-9]\d*)\s*分钟$/u;
const RESTORE_RE = /^立即恢复\s*(.+)$/u;
const DELETE_RE = /^删除禁止规则\s*([1-9]\d*(?:\s*[，,]\s*[1-9]\d*)*)$/u;
const MAX_DAYS = 3650;
const MAX_RELEASE_MINUTES = 24 * 60;

function cleanTarget(value) {
  return String(value).trim().replace(/^<|>$/g, "").replace(/[，。！？、]+$/u, "");
}

function parseDuration(raw) {
  if (raw === "永久") return { permanent: true, expiresAt: null, durationText: "永久" };
  const match = raw.match(/^([1-9]\d*)\s*(天|日|小时|时)$/u);
  if (!match) throw new Error("时长必须是正整数天/小时或“永久”。");
  const amount = Number(match[1]);
  const hours = /小时|时/u.test(match[2]) ? amount : amount * 24;
  if (hours > MAX_DAYS * 24) throw new Error(`限制时长不能超过${MAX_DAYS}天。`);
  return { permanent: false, hours, durationText: `${amount}${match[2]}` };
}

function normalizeDomain(raw) {
  const target = cleanTarget(raw).replace(/^https?:\/\//iu, "https://");
  const url = new URL(target.includes("://") ? target : `https://${target}`);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("网站只支持 http 或 https 地址。");
  if (url.username || url.password || !url.hostname || url.hostname.includes("..")) throw new Error("网站地址不合法。");
  const hostname = url.hostname.toLocaleLowerCase("en-US").replace(/^www\./u, "").replace(/\.$/u, "");
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(hostname)) {
    throw new Error("网站必须是合法域名，例如 baidu.com。");
  }
  return hostname;
}

export function normalizeReleaseTarget(raw) {
  const target = cleanTarget(raw);
  if (/^(?:bilibili|哔哩哔哩)$/iu.test(target)) return "bilibili.com";
  return normalizeDomain(target);
}

function releaseDuration(raw) {
  const minutes = Number(raw);
  if (!Number.isInteger(minutes) || minutes < 1) throw new Error("解除时长必须是正整数分钟。");
  if (minutes > MAX_RELEASE_MINUTES) throw new Error("单次解除不能超过24小时。");
  return minutes;
}

export function parseBlockCommand(message, now = new Date()) {
  const text = String(message ?? "").trim();
  if (text === "查询禁止名单") return { kind: "list" };
  const remove = text.match(DELETE_RE);
  if (remove) return { kind: "deletePreview", indices: [...new Set(remove[1].split(/[，,]/u).map((item) => Number(item.trim())))] };
  if (text === "/禁止名单" || text === "/禁止名单详细") return { kind: "help", detailed: text.endsWith("详细") };
  const restore = text.match(RESTORE_RE);
  if (restore) {
    const targetKey = normalizeReleaseTarget(restore[1]);
    return { kind: "restore", targetKey, displayName: targetKey };
  }
  const releaseDefault = text.match(RELEASE_DEFAULT_RE);
  if (releaseDefault) return { kind: "release", targetKey: null, displayName: null, minutes: releaseDuration(releaseDefault[1]), explicit: false };
  const releaseExplicit = text.match(RELEASE_EXPLICIT_RE);
  if (releaseExplicit) {
    const targetKey = normalizeReleaseTarget(releaseExplicit[1]);
    return { kind: "release", targetKey, displayName: targetKey, minutes: releaseDuration(releaseExplicit[2]), explicit: true };
  }
  const match = text.match(COMMAND_RE);
  if (!match) return null;
  const action = match[1] === "下载" ? "download" : "website";
  const target = cleanTarget(match[2]);
  const duration = parseDuration(match[3]);
  const date = new Date(now);
  if (Number.isNaN(date.getTime())) throw new TypeError("now 必须是有效时间。");
  if (action === "download") {
    const software = findSoftware(target);
    if (software) return { kind: "upsert", ruleKind: "software", targetKey: software.key, displayName: software.displayName, software, ...duration };
    try {
      const domain = normalizeDomain(target);
      return { kind: "upsert", ruleKind: "website", targetKey: domain, displayName: domain, downloadOnly: true, ...duration };
    } catch {
      throw new Error(`未配置软件“${target}”。当前支持：QQ、Bilibili；也可以填写合法网站域名。`);
    }
  }
  return { kind: "upsert", ruleKind: "website", targetKey: normalizeDomain(target), displayName: normalizeDomain(target), ...duration };
}

export function getExpiry(command, now = new Date()) {
  if (command.permanent) return null;
  return new Date(new Date(now).getTime() + command.hours * 3600_000).toISOString();
}

export function getReleaseExpiry(command, now = new Date()) {
  if (command.kind !== "release") throw new TypeError("command 必须是解除命令。");
  return new Date(new Date(now).getTime() + command.minutes * 60_000).toISOString();
}
