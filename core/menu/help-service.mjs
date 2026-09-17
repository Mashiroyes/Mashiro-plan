import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createContentCache } from "../cache/content-cache.mjs";
import { runLocalProcess as sharedRunLocalProcess } from "../execution/local-process.mjs";

const TEMPLATE_VERSION = 3;
const RENDERER_VERSION = 3;
const ASSET_VERSION = 3;
const DEFAULT_MAX_ENTRIES = 128;
const DEFAULT_MAX_BYTES = 128 * 1024 * 1024;
const rendererPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "render_help.py");
const cachePool = new Map();

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function defaultTempRoot() {
  return path.join(os.tmpdir(), "MashiroBot");
}

function defaultPythonExecutable() {
  return process.platform === "win32" ? "python" : "python3";
}

function contentCacheFor(options = {}) {
  if (options.contentCache) return options.contentCache;
  const root = path.resolve(options.tempRoot ?? defaultTempRoot());
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const key = `${root}\0${maxEntries}\0${maxBytes}`;
  let cache = cachePool.get(key);
  if (!cache) {
    cache = createContentCache({
      root,
      namespace: "help",
      maxEntries,
      maxBytes,
      now: options.now ?? Date.now,
    });
    cachePool.set(key, cache);
  }
  return cache;
}

async function renderPayload(payload, options = {}) {
  const cache = contentCacheFor(options);
  const rendererPayload = { templateVersion: TEMPLATE_VERSION, ...payload };
  const encoded = Buffer.from(stableJson(rendererPayload), "utf8").toString("base64");
  const runner = options.runLocalProcess ?? sharedRunLocalProcess;

  return cache.getOrCreate({
    keyPayload: rendererPayload,
    version: { template: TEMPLATE_VERSION, renderer: RENDERER_VERSION, assets: ASSET_VERSION },
    extension: ".png",
    create: async ({ outputPaths }) => {
      await runner({
        executable: options.pythonExecutable ?? defaultPythonExecutable(),
        args: [rendererPath, "--payload-base64", encoded, "--output", outputPaths[0]],
        timeoutMs: options.timeoutMs ?? 30_000,
        maxStdoutBytes: options.maxStdoutBytes ?? 256 * 1024,
        maxStderrBytes: options.maxStderrBytes ?? 256 * 1024,
        output: "text",
      });
      // Extra numbered pages are discovered and validated in the staging directory.
    },
  });
}

function mainPayload(registry) {
  return {
    kind: "main",
    plugins: [...registry.plugins]
      .sort((left, right) => left.manifest.menuIndex - right.manifest.menuIndex)
      .map((plugin) => ({
        id: plugin.manifest.id,
        name: plugin.manifest.name,
        version: plugin.manifest.version,
        description: plugin.manifest.hideDescription ? "" : plugin.manifest.description,
        hideDescription: plugin.manifest.hideDescription === true,
        menuIndex: plugin.manifest.menuIndex,
      })),
    unavailablePluginCount: registry.failures?.length ?? 0,
  };
}

async function pluginPayload(plugin, detailed) {
  const help = await plugin.module.getHelp();
  const detailedCommand = help?.detailedCommand
    ?? plugin.manifest.exactCommands.find((command) => command.includes("详细"))
    ?? `/${plugin.manifest.name}详细`;
  return {
    kind: "plugin",
    detailed: Boolean(detailed),
    plugin: {
      id: plugin.manifest.id,
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      description: plugin.manifest.description,
      menuIndex: plugin.manifest.menuIndex,
      detailedCommand,
    },
    groups: detailed ? help?.detailedGroups ?? help?.groups ?? [] : help?.groups ?? [],
  };
}

export async function renderMainMenu(registry, options = {}) {
  return (await renderPayload(mainPayload(registry), options))[0];
}

export async function renderPluginHelp(plugin, { detailed = false, ...options } = {}) {
  return renderPayload(await pluginPayload(plugin, detailed), options);
}

export function prepareOutboundCopies(cachedPaths, { tempRoot = defaultTempRoot() } = {}) {
  return contentCacheFor({ tempRoot }).copyForUse(cachedPaths, {
    targetRoot: path.join(path.resolve(tempRoot), "outbound"),
  });
}

function globalFallback(registry) {
  const lines = [...registry.plugins]
    .sort((left, right) => left.manifest.menuIndex - right.manifest.menuIndex)
    .map((plugin) => plugin.manifest.hideDescription
      ? `${plugin.manifest.menuIndex}. ${plugin.manifest.name}`
      : `${plugin.manifest.menuIndex}. ${plugin.manifest.name} — ${plugin.manifest.description}`);
  if (registry.failures?.length) lines.push(`另有 ${registry.failures.length} 个插件不可用`);
  return lines.length ? lines.join("\n") : "当前没有可用插件。";
}

export function createPictureHelpService(defaultOptions = {}) {
  function requestOptions(context) {
    return {
      ...defaultOptions,
      tempRoot: context?.tempRoot ?? defaultOptions.tempRoot ?? defaultTempRoot(),
      runLocalProcess:
        context?.runLocalProcess
        ?? defaultOptions.runLocalProcess
        ?? sharedRunLocalProcess,
    };
  }

  return Object.freeze({
    async renderMainMenu(registry, { context } = {}) {
      const options = requestOptions(context);
      try {
        const cachedPath = await renderMainMenu(registry, options);
        return {
          handled: true,
          command: "帮助菜单",
          reply: "",
          mediaPaths: contentCacheFor(options).copyForUse([cachedPath], {
            targetRoot: path.join(path.resolve(options.tempRoot), "outbound"),
          }),
        };
      } catch {
        return {
          handled: true,
          command: "帮助菜单",
          reply: globalFallback(registry),
          mediaPaths: [],
        };
      }
    },

    async renderPluginHelp(plugin, { detailed = false, context } = {}) {
      const options = requestOptions(context);
      try {
        const cachedPaths = await renderPluginHelp(plugin, { ...options, detailed });
        return {
          handled: true,
          command: detailed ? "插件详细帮助" : "插件帮助",
          reply: "",
          mediaPaths: contentCacheFor(options).copyForUse(cachedPaths, {
            targetRoot: path.join(path.resolve(options.tempRoot), "outbound"),
          }),
        };
      } catch {
        let help = null;
        try {
          help = await plugin.module.getHelp();
        } catch {
          // Rendering and fallback lookup failed independently; use manifest text.
        }
        return {
          handled: true,
          command: detailed ? "插件详细帮助" : "插件帮助",
          reply: help?.fallbackText
            || (help ? `${plugin.manifest.name}：${plugin.manifest.description}` : plugin.manifest.description),
          mediaPaths: [],
        };
      }
    },
  });
}
