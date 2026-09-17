import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import { normalizePluginResult } from "../contracts/plugin-result.mjs";
import { createMashiroBotContext } from "../bridge/context.mjs";
import { createMenuSessionStore } from "../menu/menu-session.mjs";

const HELP_ALIASES = new Set(["help", "/help", "帮助"]);
const POSITIVE_INTEGER = /^[1-9]\d*$/;

function shortError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 160) || "未知错误";
}

function pluginError(pluginId, error) {
  return {
    handled: true,
    command: "插件错误",
    reply: `本地插件执行失败（${pluginId}）：${shortError(error)}`,
    mediaPaths: [],
  };
}

function normalizeHelpResult(value, command, fallbackReply) {
  if (typeof value === "string") {
    return { handled: true, command, reply: "", mediaPaths: [value] };
  }
  if (Array.isArray(value)) {
    return { handled: true, command, reply: "", mediaPaths: value.map(String) };
  }
  if (value && typeof value === "object") {
    return normalizePluginResult({ handled: true, command, ...value }, command);
  }
  return { handled: true, command, reply: fallbackReply, mediaPaths: [] };
}

export function createTextHelpService() {
  return Object.freeze({
    renderMainMenu(registry) {
      const lines = registry.plugins.map(
        (plugin) =>
          `${plugin.manifest.menuIndex}. ${plugin.manifest.name} — ${plugin.manifest.description}`,
      );
      if (registry.failures?.length) lines.push(`另有 ${registry.failures.length} 个插件不可用`);
      return {
        handled: true,
        command: "帮助菜单",
        reply: lines.length ? lines.join("\n") : "当前没有可用插件。",
        mediaPaths: [],
      };
    },

    async renderPluginHelp(plugin, { detailed }) {
      const help = await plugin.module.getHelp();
      return {
        handled: true,
        command: detailed ? "插件详细帮助" : "插件帮助",
        reply:
          help?.fallbackText ||
          `${plugin.manifest.name}：${plugin.manifest.description}`,
        mediaPaths: [],
      };
    },
  });
}

async function invokePlugin(plugin, text, context, metrics) {
  const startedAt = performance.now();
  metrics.pluginId = plugin.manifest.id;
  try {
    return normalizePluginResult(
      await plugin.module.handle(text, context),
      plugin.manifest.id,
    );
  } catch (error) {
    metrics.errorCode = String(error?.code || "PLUGIN_ERROR");
    metrics.errorMessage = shortError(error);
    return pluginError(plugin.manifest.id, error);
  } finally {
    metrics.handleElapsedMs += Math.max(0, performance.now() - startedAt);
  }
}

function emitLog(logger, record) {
  if (!logger) return;
  try {
    let pending;
    if (typeof logger === "function") {
      pending = logger(record);
    } else {
      const method = logger[record.level] ?? logger.log;
      if (typeof method === "function") pending = method.call(logger, record);
    }
    Promise.resolve(pending).catch(() => {});
  } catch {
    // Logging must never alter routing behavior.
  }
}

function requestIdFrom(rawContext) {
  const supplied = String(rawContext?.requestId ?? "").trim();
  return supplied || randomUUID();
}

/**
 * Build one synchronous GPT-before-local router around a startup-time registry.
 */
export function createPluginRouter({
  registry,
  menuSessions = createMenuSessionStore(),
  helpService = createTextHelpService(),
  planRoot,
  logger,
  runLocalProcess,
} = {}) {
  if (!registry?.plugins || !registry?.byMenuIndex || !registry?.byExactCommand) {
    throw new TypeError("a loaded plugin registry is required");
  }

  async function renderPluginHelp(plugin, options) {
    const command = options.detailed ? "插件详细帮助" : "插件帮助";
    const fallback = `${plugin.manifest.name}：${plugin.manifest.description}`;
    return normalizeHelpResult(
      await helpService.renderPluginHelp(plugin, options),
      command,
      fallback,
    );
  }

  return async function handleMashiroBotMessage(rawText, rawContext = {}) {
    const startedAt = performance.now();
    const requestId = requestIdFrom(rawContext);
    const metrics = {
      requestId,
      pluginId: "mashirobot-core",
      externalElapsedMs: 0,
      matchElapsedMs: 0,
      handleElapsedMs: 0,
      errorCode: "",
      errorMessage: "",
    };
    let routedResult = null;
    let unexpectedError = null;
    const remember = (result) => {
      routedResult = result;
      return result;
    };

    try {
      const text = String(rawText ?? "").trim();
      const context = createMashiroBotContext(
        {
          ...rawContext,
          requestId,
          planRoot: rawContext.planRoot ?? planRoot,
        },
        {
          registry,
          renderPluginHelp,
          metrics,
          requestId,
          runLocalProcess,
        },
      );
      const key = `${context.accountId}\0${context.conversationId}`;

      if (HELP_ALIASES.has(text)) {
        menuSessions.open(key);
        const helpStartedAt = performance.now();
        try {
          return remember(normalizeHelpResult(
            await helpService.renderMainMenu(registry, { context }),
            "帮助菜单",
            "当前没有可用插件。",
          ));
        } catch (error) {
          metrics.errorCode = String(error?.code || "HELP_RENDER_ERROR");
          metrics.errorMessage = shortError(error);
          return remember(pluginError("mashirobot-core", error));
        } finally {
          metrics.handleElapsedMs += Math.max(0, performance.now() - helpStartedAt);
        }
      }

      if (POSITIVE_INTEGER.test(text) && menuSessions.get(key)) {
        const selection = menuSessions.select(key, Number(text), registry);
        if (selection.status === "invalid") {
          const valid = selection.validMenuIndexes.length
            ? selection.validMenuIndexes.join("、")
            : "无";
          return remember({
            handled: true,
            command: "帮助菜单",
            reply: `没有编号 ${text} 的插件。可用编号：${valid}`,
            mediaPaths: [],
          });
        }
        if (selection.status === "selected") {
          metrics.pluginId = selection.plugin.manifest.id;
          const helpStartedAt = performance.now();
          try {
            return remember(await renderPluginHelp(selection.plugin, {
              detailed: false,
              context,
            }));
          } catch (error) {
            metrics.errorCode = String(error?.code || "HELP_RENDER_ERROR");
            metrics.errorMessage = shortError(error);
            return remember(pluginError(selection.plugin.manifest.id, error));
          } finally {
            metrics.handleElapsedMs += Math.max(0, performance.now() - helpStartedAt);
          }
        }
      }

      const exactPlugin = registry.byExactCommand.get(text);
      if (exactPlugin) {
        return remember(await invokePlugin(exactPlugin, text, context, metrics));
      }

      for (const plugin of registry.plugins) {
        let matched;
        const matchStartedAt = performance.now();
        try {
          matched = await plugin.module.match(text, context);
        } catch (error) {
          metrics.pluginId = plugin.manifest.id;
          metrics.errorCode = String(error?.code || "PLUGIN_MATCH_ERROR");
          metrics.errorMessage = shortError(error);
          return remember(pluginError(plugin.manifest.id, error));
        } finally {
          metrics.matchElapsedMs += Math.max(0, performance.now() - matchStartedAt);
        }
        if (matched) {
          return remember(await invokePlugin(plugin, text, context, metrics));
        }
      }

      return remember(null);
    } catch (error) {
      unexpectedError = error;
      metrics.errorCode = String(error?.code || "ROUTE_ERROR");
      metrics.errorMessage = shortError(error);
      throw error;
    } finally {
      const elapsedMs = Math.max(0, performance.now() - startedAt);
      const event = metrics.errorCode
        ? "route_failed"
        : routedResult
          ? "route_completed"
          : "route_unmatched";
      const message = metrics.errorMessage
        || routedResult?.command
        || (unexpectedError ? "route failed" : "unmatched");
      emitLog(logger, {
        level: metrics.errorCode ? "error" : "info",
        requestId,
        pluginId: metrics.pluginId,
        event,
        elapsedMs,
        externalElapsedMs: metrics.externalElapsedMs,
        matchElapsedMs: metrics.matchElapsedMs,
        handleElapsedMs: metrics.handleElapsedMs,
        errorCode: metrics.errorCode,
        message,
      });
    }
  };
}
