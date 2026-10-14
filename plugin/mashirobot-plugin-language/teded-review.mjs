const REVIEW_INTERVAL_DAYS = Object.freeze([2, 7, 21, 60]);
export const TEDED_REVIEW_STATE_KEY = "teded-listening:v1";

export function parseTedEdListening(rawText) {
  const text = String(rawText ?? "").trim();
  if (/\r?\n/u.test(text)) return null;
  const match = /^今日英语听力\s*[:：]\s*(\d{1,5})\s+(.+)$/u.exec(text);
  if (!match) return null;
  const number = Number(match[1]);
  const title = match[2].trim().replace(/\s+/gu, " ");
  if (!Number.isInteger(number) || number < 1 || number > 99999 || !title) return null;
  return { number, title };
}

function shiftDate(value, days) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function shanghaiDate(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now).filter((part) => ["year", "month", "day"].includes(part.type)).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function reviewDates(studiedOn) {
  return REVIEW_INTERVAL_DAYS.map((days) => shiftDate(studiedOn, days));
}

function normalizeCatalog(value) {
  if (value === null || value === undefined) return { version: 1, videos: [] };
  if (value?.version !== 1 || !Array.isArray(value.videos)) throw new Error("TED-Ed 听力记录格式无效");
  const videos = value.videos.map((video) => {
    const number = Number(video?.number);
    const title = String(video?.title ?? "").trim();
    const studiedOn = String(video?.studiedOn ?? "");
    if (!Number.isInteger(number) || number < 1 || number > 99999 || !title || !/^\d{4}-\d{2}-\d{2}$/u.test(studiedOn)) {
      throw new Error("TED-Ed 听力记录包含无效项目");
    }
    const dates = Array.isArray(video.reviewDates) && video.reviewDates.length === REVIEW_INTERVAL_DAYS.length
      ? video.reviewDates.map(String)
      : reviewDates(studiedOn);
    if (dates.some((date) => !/^\d{4}-\d{2}-\d{2}$/u.test(date))) throw new Error("TED-Ed 复习日期格式无效");
    return { number, title, studiedOn, reviewDates: dates };
  });
  return { version: 1, videos };
}

export function upsertTedEdVideo(value, command, studiedOn) {
  const catalog = normalizeCatalog(value);
  const existing = catalog.videos.find((video) => video.number === command.number);
  if (existing) {
    existing.title = command.title;
    return { catalog, created: false, video: existing };
  }
  const video = { ...command, studiedOn, reviewDates: reviewDates(studiedOn) };
  catalog.videos.push(video);
  catalog.videos.sort((left, right) => left.number - right.number);
  return { catalog, created: true, video };
}

export function formatReviewDates(dates) {
  return dates.map((date) => {
    const [, month, day] = date.split("-").map(Number);
    return `${month}月${day}日`;
  }).join("、");
}
