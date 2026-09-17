const SHANGHAI = "Asia/Shanghai";

const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: SHANGHAI,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function localParts(now) {
  const values = Object.fromEntries(formatter.formatToParts(now).map(({ type, value }) => [type, value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    minutes: Number(values.hour) * 60 + Number(values.minute),
  };
}

function dateNumber(date) {
  const [year, month, day] = date.split("-").map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function fromDateNumber(number) {
  return new Date(number * 86_400_000).toISOString().slice(0, 10);
}

function weekday(date) {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

function isPausedOn(state, date) {
  if (state.paused && state.currentPauseStart && date >= state.currentPauseStart) return true;
  return (state.pauseIntervals ?? []).some(({ startDate, endDate }) =>
    date >= startDate && (endDate == null || date <= endDate));
}

function slot(eligible, lessonNumber, localDate, scheduledTime, reason) {
  return { eligible, lessonNumber, localDate, scheduledTime, reason };
}

function validateState(state) {
  if (!state || !/^\d{4}-\d{2}-\d{2}$/.test(state.installedDate ?? "")) {
    throw new TypeError("state.installedDate 必须是 YYYY-MM-DD");
  }
}

export function getFinancialReportSlot(state, now = new Date()) {
  validateState(state);
  const { date, minutes } = localParts(now);
  const scheduledTime = "12:20";
  const first = dateNumber(state.installedDate) + 1;
  const today = dateNumber(date);
  if (today < first) return slot(false, null, date, scheduledTime, "not_started");
  if (isPausedOn(state, date)) return slot(false, null, date, scheduledTime, "paused");

  let lessonNumber = 0;
  for (let cursor = first; cursor <= today; cursor += 1) {
    const candidate = fromDateNumber(cursor);
    if (!isPausedOn(state, candidate)) lessonNumber += 1;
  }
  if (lessonNumber > 30) return slot(false, null, date, scheduledTime, "complete");
  if (minutes < 12 * 60 + 20) return slot(false, lessonNumber, date, scheduledTime, "not_due");
  return slot(true, lessonNumber, date, scheduledTime, "due");
}

export function getProspectusSlot(state, now = new Date()) {
  validateState(state);
  const { date, minutes } = localParts(now);
  const scheduledTime = "18:10";
  const installed = dateNumber(state.installedDate);
  const today = dateNumber(date);
  if (today <= installed) return slot(false, null, date, scheduledTime, "not_started");
  if (![2, 5].includes(weekday(date))) return slot(false, null, date, scheduledTime, "wrong_day");
  if (isPausedOn(state, date)) return slot(false, null, date, scheduledTime, "paused");

  let lessonNumber = 0;
  for (let cursor = installed + 1; cursor <= today; cursor += 1) {
    const candidate = fromDateNumber(cursor);
    if ([2, 5].includes(weekday(candidate)) && !isPausedOn(state, candidate)) lessonNumber += 1;
  }
  if (lessonNumber > 8) return slot(false, null, date, scheduledTime, "complete");
  if (minutes < 18 * 60 + 10) return slot(false, lessonNumber, date, scheduledTime, "not_due");
  return slot(true, lessonNumber, date, scheduledTime, "due");
}

export const CALENDAR_TIME_ZONE = SHANGHAI;
