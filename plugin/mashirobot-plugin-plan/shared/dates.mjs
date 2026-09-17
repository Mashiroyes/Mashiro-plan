export function shanghaiParts(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) throw new TypeError("now must be a valid date");
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

export function shanghaiDate(now = new Date()) {
  const parts = shanghaiParts(now);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function shanghaiIso(now = new Date()) {
  const parts = shanghaiParts(now);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+08:00`;
}

export function shiftDate(date, days) {
  const [year, month, day] = String(date).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + Number(days))).toISOString().slice(0, 10);
}

export function dateFromParts(year, month, day) {
  if (year < 2000 || year > 2100 || month < 1 || month > 12) return null;
  const maximumDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (day < 1 || day > maximumDay) return null;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function currentRoutineDate(now = new Date()) {
  const parts = shanghaiParts(now);
  const current = `${parts.year}-${parts.month}-${parts.day}`;
  return Number(parts.hour) < 6 ? shiftDate(current, -1) : current;
}

export function formatClock(totalMinutes) {
  const wrapped = ((Math.round(Number(totalMinutes)) % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`;
}

export function resolveMessageDate(rawText, now = new Date(), { planHeader = false } = {}) {
  const text = String(rawText).trim();
  const currentDate = shanghaiDate(now);
  if (planHeader && !/昨天|明天|明日|20\d{2}[-年]|\d{1,2}月\s*\d{1,2}日/.test(text)) {
    return currentDate;
  }
  let match = /(20\d{2})-(\d{1,2})-(\d{1,2})/.exec(text);
  if (match) return dateFromParts(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /(20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日/.exec(text);
  if (match) return dateFromParts(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /(\d{1,2})月\s*(\d{1,2})日/.exec(text);
  if (match) {
    const parts = shanghaiParts(now);
    return dateFromParts(Number(parts.year), Number(match[1]), Number(match[2]));
  }
  if (/昨天|昨日/.test(text)) return shiftDate(currentDate, -1);
  if (/明天|明日/.test(text)) return shiftDate(currentDate, 1);
  if (/今天|今日/.test(text)) return currentDate;
  return null;
}
