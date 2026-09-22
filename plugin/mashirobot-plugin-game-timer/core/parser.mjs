export function parseGameTimerCommand(text) {
  const value = String(text ?? "").trim();
  const add = value.match(/^加入游戏\s*\r?\n\s*(.+)$/);
  if (add) return { kind: "add", executablePath: add[1].trim() };
  if (value === "查看游戏") return { kind: "list" };
  if (value === "查询游戏计时") return { kind: "timerList" };
  let control = value.match(/^取消游戏计时(?:\s+(G\d{3}))?$/iu) ?? value.match(/^取消\s+(G\d{3})$/iu);
  if (control) return { kind: "timerCancel", shortId: control[1]?.toUpperCase() ?? null };
  control = value.match(/^延长游戏计时\s*(\d+)\s*分钟$/u) ?? value.match(/^延长\s*(?:(G\d{3})\s*)?(\d+)\s*分钟$/iu);
  if (control) {
    const shortId = control.length === 3 ? control[1]?.toUpperCase() ?? null : null;
    const minutes = Number(control.length === 3 ? control[2] : control[1]);
    return minutes >= 1 && minutes <= 1440 ? { kind: "timerExtend", shortId, minutes } : null;
  }
  control = value.match(/^立即结束游戏计时(?:\s+(G\d{3}))?$/iu) ?? value.match(/^立即结束\s+(G\d{3})$/iu);
  if (control) return { kind: "timerEnd", shortId: control[1]?.toUpperCase() ?? null };
  if (value === "恢复所有游戏文件") return { kind: "recoverAllGames" };
  const remove = value.match(/^删除游戏\s*([1-9]\d*(?:\s*[，,]\s*[1-9]\d*)*)$/u);
  if (remove) return { kind: "deletePreview", indices: [...new Set(remove[1].split(/[，,]/u).map((item) => Number(item.trim())))] };

  const match = value.match(
    /^玩\s*(.+?)\s*(\d+)\s*(分钟|小时)(?:\s*[，,]?\s*提醒后\s*(\d+)\s*(分钟|小时)\s*强退)?$/,
  );
  if (!match) return null;
  const minutes = Number(match[2]) * (match[3] === "小时" ? 60 : 1);
  const forceAfter = match[4]
    ? Number(match[4]) * (match[5] === "小时" ? 60 : 1)
    : 10;
  if (minutes < 1 || minutes > 1440 || forceAfter < 0 || forceAfter > 1440) return null;
  return { kind: "create", game: match[1].trim(), minutes, forceAfter };
}

export function isGameTimerCommand(text) {
  return parseGameTimerCommand(text) !== null;
}
