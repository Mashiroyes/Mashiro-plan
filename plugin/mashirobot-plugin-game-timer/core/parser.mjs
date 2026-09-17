export function parseGameTimerCommand(text) {
  const value = String(text ?? "").trim();
  const add = value.match(/^加入游戏\s*\r?\n\s*(.+)$/);
  if (add) return { kind: "add", executablePath: add[1].trim() };
  if (value === "查看游戏") return { kind: "list" };
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
