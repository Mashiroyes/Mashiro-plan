export const QQ_BEFORE_NOON_REPLY = "每天12点之前不能同意玩QQ的请求，请12点之后再打开。";
export const QQ_OUTSIDE_DAILY_WINDOW_REPLY = "QQ只允许在每天12:00到22:00之间使用；请确保本次时长在22:00前结束。";
export const QQ_SUNDAY_ONLY_REPLY = "“周末玩QQ4h”只允许在上海时间星期日使用；20:00以后会截短到当天24:00。";
export const QQ_SUNDAY_ENDED_REPLY = "本周日已经不足1分钟，不能再启动QQ；请等下一个星期日。";
export const QQ_SUNDAY_LIMIT_REPLY = "本周日的4小时QQ机会已经使用，当天只能成功启动一次。";

export function parseQqSessionCommand(text) {
  if (/^周末玩\s*QQ\s*4\s*h$/iu.test(String(text ?? "").trim())) {
    return { kind: "qq-session", minutes: 240, windowPolicy: "sunday-4h" };
  }
  const match = String(text ?? "").trim().match(/^玩\s*QQ\s*(\d+)\s*分钟$/i);
  if (!match) return null;
  const minutes = Number(match[1]);
  return Number.isSafeInteger(minutes) && minutes >= 1 && minutes <= 60
    ? { kind: "qq-session", minutes }
    : null;
}

function localWindowParts(value, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(value);
  const raw = Object.fromEntries(parts.filter(({ type }) => type !== "literal").map(({ type, value: part }) => [type, part]));
  return {
    year: Number(raw.year), month: Number(raw.month), day: Number(raw.day), weekday: raw.weekday,
    hour: Number(raw.hour), minute: Number(raw.minute), second: Number(raw.second),
  };
}

function localParts(value, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(value);
  return Object.fromEntries(parts.filter(({ type }) => type !== "literal").map(({ type, value: part }) => [type, Number(part)]));
}

export function evaluateQqSessionWindow(now = new Date(), command = {}, timeZone = "Asia/Shanghai") {
  const value = new Date(now);
  if (Number.isNaN(value.getTime())) throw new TypeError("now must be a valid date");
  const start = localWindowParts(value, timeZone);
  const localDate = `${String(start.year).padStart(4, "0")}-${String(start.month).padStart(2, "0")}-${String(start.day).padStart(2, "0")}`;
  if (command.windowPolicy === "sunday-4h") {
    if (start.weekday !== "Sun") return { allowed: false, reason: "not-sunday", localDate };
    const elapsedSeconds = start.hour * 3600 + start.minute * 60 + start.second;
    const remainingMinutes = Math.floor((24 * 3600 - elapsedSeconds) / 60);
    if (remainingMinutes < 1) return { allowed: false, reason: "sunday-ended", localDate };
    return { allowed: true, reason: null, localDate, playMinutes: Math.min(240, remainingMinutes) };
  }
  const minutes = Number(command.minutes ?? 0);
  if (!Number.isSafeInteger(minutes) || minutes < 0) throw new RangeError("minutes must be a non-negative integer");
  if (start.hour < 12) return { allowed: false, reason: "before-noon", localDate };
  if (start.hour >= 22) return { allowed: false, reason: "outside-daily-window", localDate };
  const end = localWindowParts(new Date(value.getTime() + minutes * 60_000), timeZone);
  const sameDay = end.year === start.year && end.month === start.month && end.day === start.day;
  const endsByClose = end.hour < 22 || (end.hour === 22 && end.minute === 0 && end.second === 0);
  return sameDay && endsByClose
    ? { allowed: true, reason: null, localDate }
    : { allowed: false, reason: "outside-daily-window", localDate };
}

export function canStartQqSession(now = new Date(), minutes = 0, timeZone = "Asia/Shanghai") {
  if (typeof minutes === "string") { timeZone = minutes; minutes = 0; }
  return evaluateQqSessionWindow(now, { minutes, windowPolicy: "daily" }, timeZone).allowed;
}
