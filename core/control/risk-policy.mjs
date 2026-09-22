export const RISK_LEVELS = Object.freeze({ LOW: "direct", MEDIUM: "undoable", HIGH: "confirm" });

export function classifyRisk({ destructive = false, permanent = false, broad = false, externalSideEffect = false, reversible = false } = {}) {
  if (destructive || permanent || broad || (externalSideEffect && !reversible)) return RISK_LEVELS.HIGH;
  if (reversible) return RISK_LEVELS.MEDIUM;
  return RISK_LEVELS.LOW;
}
