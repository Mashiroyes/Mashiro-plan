export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  if (hours) return `${hours}小时${minutes ? `${minutes}分钟` : ""}`;
  if (minutes) return `${minutes}分钟${remainder ? `${remainder}秒` : ""}`;
  return `${remainder}秒`;
}

export function formatAuditSummary(summary, label, displayNames = {}) {
  const entries = Object.entries(summary?.totals ?? {}).sort(([left], [right]) => left.localeCompare(right));
  const used = entries.filter(([, seconds]) => Number(seconds) > 0);
  const lines = [label];
  if (used.length) {
    for (const [key, seconds] of used) lines.push(`${displayNames[key] ?? key}：${formatDuration(seconds)}`);
  } else {
    lines.push(summary?.health?.fresh ? "没有记录到前台使用。" : "审计当前没有可确认的使用记录。");
  }
  if (!summary?.health?.fresh) {
    lines.push(summary?.health?.heartbeatAt
      ? `审计暂停，最后记录于${new Date(summary.health.heartbeatAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}。`
      : "审计尚未启动。");
  }
  return lines.join("\n");
}
