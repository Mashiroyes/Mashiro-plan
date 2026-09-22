export const ROUTE_STATES = Object.freeze({
  NOT_MATCHED: "NOT_MATCHED",
  MATCHED_SUCCESS: "MATCHED_SUCCESS",
  MATCHED_FAILED: "MATCHED_FAILED",
});

export function notMatched() {
  return Object.freeze({ state: ROUTE_STATES.NOT_MATCHED, matched: false, ok: false, result: null });
}

export function matchedSuccess(result) {
  return Object.freeze({ state: ROUTE_STATES.MATCHED_SUCCESS, matched: true, ok: true, result });
}

export function matchedFailure(result, errorCode = "PLUGIN_ERROR") {
  return Object.freeze({ state: ROUTE_STATES.MATCHED_FAILED, matched: true, ok: false, errorCode, result });
}

/**
 * Convert a plugin return value into the only result shape accepted by the
 * MashiroBot core. A matched plugin must never return an unhandled value.
 */
export function normalizePluginResult(value, pluginId) {
  if (!value || value.handled !== true) {
    throw new Error(`Invalid result from ${pluginId}`);
  }

  return {
    handled: true,
    command: String(value.command || pluginId),
    reply: value.reply == null ? "" : String(value.reply),
    mediaPaths: Array.isArray(value.mediaPaths) ? value.mediaPaths.map(String) : [],
  };
}
