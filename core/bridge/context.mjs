import os from "node:os";
import path from "node:path";

import { runLocalProcess as defaultRunLocalProcess } from "../execution/local-process.mjs";

function resolveNow(value) {
  const candidate = typeof value === "function" ? value() : value;
  const date = candidate == null ? new Date() : new Date(candidate);
  if (Number.isNaN(date.getTime())) throw new TypeError("context.now must be a valid date");
  return date;
}

function shanghaiDate(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

/**
 * Normalize the data exposed to trusted local plugins.
 */
export function createMashiroBotContext(rawContext = {}, services = {}) {
  const planRootValue = rawContext.planRoot ?? services.planRoot;
  if (!planRootValue) throw new TypeError("context.planRoot is required");

  const now = resolveNow(rawContext.now);
  const planRoot = path.resolve(String(planRootValue));
  const sqlitePath = path.resolve(
    String(rawContext.sqlitePath ?? path.join(planRoot, "sqlite", "openclaw-planner.sqlite")),
  );
  const tempRoot = path.resolve(
    String(rawContext.tempRoot ?? path.join(os.tmpdir(), "MashiroBot")),
  );
  const accountId = String(rawContext.accountId ?? "");
  const conversationId = String(rawContext.conversationId ?? "");
  const registry = services.registry;
  const renderer = services.renderPluginHelp ?? rawContext.renderPluginHelp;
  const metrics = services.metrics ?? { externalElapsedMs: 0 };
  const localProcessRunner =
    services.runLocalProcess ?? rawContext.runLocalProcess ?? defaultRunLocalProcess;

  const context = {
    ...rawContext,
    accountId,
    conversationId,
    now,
    timeZone: "Asia/Shanghai",
    localDate: shanghaiDate(now),
    planRoot,
    sqlitePath,
    tempRoot,
    requestId: String(services.requestId ?? rawContext.requestId ?? ""),
  };

  context.runLocalProcess = async (options) => {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      return localProcessRunner(options);
    }
    const callerOnComplete = options.onComplete;
    return localProcessRunner({
      ...options,
      onComplete: (completion) => {
        const elapsedMs = Number(completion?.elapsedMs);
        if (Number.isFinite(elapsedMs) && elapsedMs >= 0) {
          metrics.externalElapsedMs += elapsedMs;
        }
        if (typeof callerOnComplete === "function") {
          try {
            Promise.resolve(callerOnComplete(completion)).catch(() => {});
          } catch {
            // A caller completion hook must not change the child-process result.
          }
        }
      },
    });
  };

  context.renderPluginHelp = (pluginId, { detailed = false } = {}) => {
    if (typeof renderer !== "function") {
      throw new Error("plugin help renderer is unavailable");
    }
    const plugin = registry?.plugins?.find((item) => item.manifest.id === String(pluginId));
    if (!plugin) throw new Error(`unknown plugin: ${pluginId}`);
    return renderer(plugin, { detailed: Boolean(detailed), context });
  };

  return context;
}
