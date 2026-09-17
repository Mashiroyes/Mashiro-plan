import path from "node:path";
import { randomUUID } from "node:crypto";

export function normalizeExecutableKey(executablePath) {
  return path.win32.normalize(String(executablePath)).toLowerCase();
}

export function buildTask({ game, minutes, forceAfter, now = new Date(), id = randomUUID() }) {
  const started = new Date(now);
  if (Number.isNaN(started.getTime())) throw new TypeError("now must be a valid date");
  const lockMinutes = minutes + forceAfter + 10;
  return {
    id,
    gameKey: game.key,
    displayName: game.displayName,
    processName: game.processName,
    executablePath: game.executablePath,
    executableKey: normalizeExecutableKey(game.executablePath),
    minutes,
    forceAfter,
    startedAt: started.toISOString(),
    reminderAt: new Date(started.getTime() + minutes * 60000).toISOString(),
    forceAt: new Date(started.getTime() + (minutes + forceAfter) * 60000).toISOString(),
    lockUntil: new Date(started.getTime() + lockMinutes * 60000).toISOString(),
  };
}
