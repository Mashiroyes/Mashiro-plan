/**
 * Keep short-lived help-menu selections in process memory only.
 */
export function createMenuSessionStore({ ttlMs = 35_000, now = () => Date.now() } = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new TypeError("ttlMs must be a positive finite number");
  }
  if (typeof now !== "function") {
    throw new TypeError("now must be a function");
  }

  const sessions = new Map();

  function open(key) {
    const openedAt = Number(now());
    const session = Object.freeze({
      active: true,
      openedAt,
      expiresAt: openedAt + ttlMs,
    });
    sessions.set(String(key), session);
    return session;
  }

  function get(key) {
    const normalizedKey = String(key);
    const session = sessions.get(normalizedKey);
    if (!session) return null;
    if (Number(now()) >= session.expiresAt) {
      sessions.delete(normalizedKey);
      return null;
    }
    return session;
  }

  function clear(key) {
    return sessions.delete(String(key));
  }

  function select(key, menuIndex, registry) {
    const session = get(key);
    if (!session) return { status: "inactive" };

    const plugin = registry?.byMenuIndex?.get(Number(menuIndex));
    if (!plugin) {
      const validMenuIndexes = [...(registry?.byMenuIndex?.keys?.() ?? [])]
        .filter((value) => Number.isInteger(value) && value > 0)
        .sort((left, right) => left - right);
      return { status: "invalid", session, validMenuIndexes };
    }

    clear(key);
    return { status: "selected", plugin };
  }

  return Object.freeze({ open, get, clear, select });
}
