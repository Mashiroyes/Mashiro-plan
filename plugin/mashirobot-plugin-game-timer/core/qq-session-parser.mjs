export const QQ_BEFORE_NOON_REPLY = "每天12点之前不能同意玩QQ的请求，请12点之后再打开。";

export function parseQqSessionCommand(text) {
  const match = String(text ?? "").trim().match(/^玩\s*QQ\s*(\d+)\s*分钟$/i);
  if (!match) return null;
  const minutes = Number(match[1]);
  return Number.isSafeInteger(minutes) && minutes >= 1 && minutes <= 60
    ? { kind: "qq-session", minutes }
    : null;
}

export function canStartQqSession(now = new Date(), timeZone = "Asia/Shanghai") {
  const value = new Date(now);
  if (Number.isNaN(value.getTime())) throw new TypeError("now must be a valid date");
  const hourPart = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value).find((part) => part.type === "hour");
  if (!hourPart) throw new Error(`Unable to resolve hour for ${timeZone}`);
  return Number(hourPart.value) >= 12;
}
