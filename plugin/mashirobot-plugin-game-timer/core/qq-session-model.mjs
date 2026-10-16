import { randomUUID } from "node:crypto";

export const QQ_COOLDOWN_MINUTES = 60;
export const QQ_SPECIAL_COOLDOWN_MINUTES = QQ_COOLDOWN_MINUTES;
export const QQ_WINDOW_POLICIES = Object.freeze({
  DAILY: "daily",
  SUNDAY_FOUR_HOURS: "sunday-4h",
});

export function cooldownMinutesForDailySession(sessionNumber) {
  if (!Number.isSafeInteger(sessionNumber) || sessionNumber < 1) throw new RangeError("sessionNumber must be a positive integer");
  return QQ_COOLDOWN_MINUTES;
}

function validDate(value, label) {
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) throw new TypeError(`${label} must be a valid date`);
  return result;
}

export function buildQqRequest({
  now = new Date(), id = randomUUID(), minutes,
  windowPolicy = QQ_WINDOW_POLICIES.DAILY, specialLocalDate = null,
} = {}) {
  const special = windowPolicy === QQ_WINDOW_POLICIES.SUNDAY_FOUR_HOURS;
  const daily = windowPolicy === QQ_WINDOW_POLICIES.DAILY;
  const validDaily = daily && Number.isSafeInteger(minutes) && minutes >= 1 && minutes <= 60 && specialLocalDate === null;
  const validSunday = special && Number.isSafeInteger(minutes) && minutes >= 1 && minutes <= 240
    && /^\d{4}-\d{2}-\d{2}$/.test(String(specialLocalDate ?? ""));
  if (!validDaily && !validSunday) throw new RangeError("minutes do not match the QQ window policy");
  return Object.freeze({
    id: String(id),
    requestedAt: validDate(now, "now").toISOString(),
    playMinutes: minutes,
    windowPolicy,
    specialLocalDate: validSunday ? String(specialLocalDate) : null,
    specialConsumedAt: null,
    confirmedAt: null,
    playEndsAt: null,
    cooldownEndsAt: null,
    phase: "preparing",
  });
}

export function activateQqRequest(request, confirmedAt = new Date(), dailySessionNumber = 1) {
  const confirmed = validDate(confirmedAt, "confirmedAt");
  const requestedPlayEnd = new Date(confirmed.getTime() + request.playMinutes * 60_000);
  const sundayMidnight = request.windowPolicy === QQ_WINDOW_POLICIES.SUNDAY_FOUR_HOURS
    ? new Date(`${request.specialLocalDate}T16:00:00.000Z`)
    : null;
  const playEndsAt = sundayMidnight && sundayMidnight < requestedPlayEnd ? sundayMidnight : requestedPlayEnd;
  const playMinutes = request.windowPolicy === QQ_WINDOW_POLICIES.SUNDAY_FOUR_HOURS
    ? Math.max(1, Math.ceil((playEndsAt.getTime() - confirmed.getTime()) / 60_000))
    : request.playMinutes;
  const cooldownMinutes = request.windowPolicy === QQ_WINDOW_POLICIES.SUNDAY_FOUR_HOURS
    ? QQ_SPECIAL_COOLDOWN_MINUTES
    : cooldownMinutesForDailySession(dailySessionNumber);
  return Object.freeze({
    ...request,
    playMinutes,
    confirmedAt: confirmed.toISOString(),
    playEndsAt: playEndsAt.toISOString(),
    cooldownEndsAt: new Date(playEndsAt.getTime() + cooldownMinutes * 60_000).toISOString(),
    cooldownMinutes,
    phase: "playing",
  });
}

export function phaseAt(session, now = new Date()) {
  if (session.phase === "preparing" || !session.playEndsAt || !session.cooldownEndsAt) return "preparing";
  const current = validDate(now, "now").getTime();
  const playEnd = validDate(session.playEndsAt, "playEndsAt").getTime();
  const cooldownEnd = validDate(session.cooldownEndsAt, "cooldownEndsAt").getTime();
  if (current < playEnd) return "playing";
  if (current < cooldownEnd) return "cooldown";
  return "ready";
}
