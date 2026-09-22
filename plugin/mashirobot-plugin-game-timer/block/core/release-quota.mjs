const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const MINUTE_MS = 60_000;

const BANDS = Object.freeze([
  { startHour: 0, endHour: 12, limitMinutes: 20, label: "上午" },
  { startHour: 12, endHour: 18, limitMinutes: 30, label: "下午" },
  { startHour: 18, endHour: 24, limitMinutes: null, label: "晚上" },
]);

function instant(value, name) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${name} 必须是有效时间。`);
  return date.getTime();
}

function periodAt(epochMs) {
  const local = new Date(epochMs + SHANGHAI_OFFSET_MS);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth();
  const day = local.getUTCDate();
  const hour = local.getUTCHours();
  const band = BANDS.find((item) => hour >= item.startHour && hour < item.endHour);
  const localMidnightAsUtc = Date.UTC(year, month, day);
  const startMs = localMidnightAsUtc + band.startHour * 60 * MINUTE_MS - SHANGHAI_OFFSET_MS;
  const endMs = localMidnightAsUtc + band.endHour * 60 * MINUTE_MS - SHANGHAI_OFFSET_MS;
  const dateKey = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return { key: `${dateKey}:${band.startHour}`, dateKey, label: band.label, limitMinutes: band.limitMinutes, startMs, endMs };
}

export function quotaPeriodsTouched(start, end) {
  const startMs = instant(start, "start");
  const endMs = instant(end, "end");
  if (endMs <= startMs) throw new RangeError("解除结束时间必须晚于开始时间。");
  const periods = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const period = periodAt(cursor);
    periods.push(period);
    cursor = Math.min(period.endMs, endMs);
  }
  return periods;
}

function unionMilliseconds(intervals, rangeStart, rangeEnd) {
  const clipped = intervals
    .map(({ startAt, endAt }) => [Math.max(instant(startAt, "startAt"), rangeStart), Math.min(instant(endAt, "endAt"), rangeEnd)])
    .filter(([start, end]) => end > start)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let total = 0;
  let currentStart = null;
  let currentEnd = null;
  for (const [start, end] of clipped) {
    if (currentStart === null) { currentStart = start; currentEnd = end; continue; }
    if (start <= currentEnd) { currentEnd = Math.max(currentEnd, end); continue; }
    total += currentEnd - currentStart;
    currentStart = start;
    currentEnd = end;
  }
  if (currentStart !== null) total += currentEnd - currentStart;
  return total;
}

function minutes(milliseconds) {
  return Math.round((milliseconds / MINUTE_MS) * 1_000_000) / 1_000_000;
}

export function evaluateReleaseQuota({ intervals = [], proposedStart, proposedEnd }) {
  const proposed = { startAt: proposedStart, endAt: proposedEnd };
  const periods = quotaPeriodsTouched(proposedStart, proposedEnd).map((period) => {
    const usedMs = unionMilliseconds(intervals, period.startMs, period.endMs);
    const totalMs = unionMilliseconds([...intervals, proposed], period.startMs, period.endMs);
    return {
      key: period.key,
      dateKey: period.dateKey,
      label: period.label,
      limitMinutes: period.limitMinutes,
      usedMinutes: minutes(usedMs),
      addedMinutes: minutes(totalMs - usedMs),
      remainingMinutes: Number.isFinite(period.limitMinutes) ? minutes(period.limitMinutes * MINUTE_MS - totalMs) : null,
    };
  });
  return { allowed: periods.every((period) => period.remainingMinutes === null || period.remainingMinutes >= 0), periods };
}
