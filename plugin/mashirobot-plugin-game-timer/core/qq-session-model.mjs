import { randomUUID } from "node:crypto";

export const QQ_FIRST_COOLDOWN_MINUTES = 60;
export const QQ_COOLDOWN_STEP_MINUTES = 10;

export function cooldownMinutesForDailySession(sessionNumber) {
  if (!Number.isSafeInteger(sessionNumber) || sessionNumber < 1) throw new RangeError("sessionNumber must be a positive integer");
  return QQ_FIRST_COOLDOWN_MINUTES + (sessionNumber - 1) * QQ_COOLDOWN_STEP_MINUTES;
}

function validDate(value, label) {
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) throw new TypeError(`${label} must be a valid date`);
  return result;
}

export function buildQqRequest({ now = new Date(), id = randomUUID(), minutes } = {}) {
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 60) throw new RangeError("minutes must be an integer from 1 through 60");
  return Object.freeze({
    id: String(id),
    requestedAt: validDate(now, "now").toISOString(),
    playMinutes: minutes,
    confirmedAt: null,
    playEndsAt: null,
    cooldownEndsAt: null,
    phase: "preparing",
  });
}

export function activateQqRequest(request, confirmedAt = new Date(), dailySessionNumber = 1) {
  const confirmed = validDate(confirmedAt, "confirmedAt");
  const playEndsAt = new Date(confirmed.getTime() + request.playMinutes * 60_000);
  const cooldownMinutes = cooldownMinutesForDailySession(dailySessionNumber);
  return Object.freeze({
    ...request,
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
