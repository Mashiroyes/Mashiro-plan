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
