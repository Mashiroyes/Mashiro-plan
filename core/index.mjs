import { createMashiroBotRuntime } from "./runtime/mashirobot-runtime.mjs";

let startupState = "booting";
let startupError = null;
let runtime = null;
export let pluginRegistry = null;

function shortError(error) {
  return String(error instanceof Error ? error.message : error).replace(/\s+/gu, " ").trim().slice(0, 300);
}

let runtimePromise = null;

function getRuntime() {
  runtimePromise ??= createMashiroBotRuntime().then((created) => {
    runtime = created;
    pluginRegistry = created.registry;
    startupState = created.getStatus().state;
    return created;
  }).catch((error) => {
    startupState = "failed";
    startupError = shortError(error);
    return null;
  });
  return runtimePromise;
}

export async function handleMashiroBotMessage(rawText, context = {}) {
  const activeRuntime = await getRuntime();
  if (activeRuntime) return activeRuntime.handleMessage(rawText, context);
  return {
    handled: true,
    command: "系统启动失败",
    reply: `本地系统启动失败，未交给 GPT 重试：${startupError || "未知错误"}`,
    mediaPaths: [],
  };
}

export function getMashiroBotStartupStatus() {
  return runtime?.getStatus() ?? Object.freeze({ state: startupState, error: startupError, loadedPluginCount: 0 });
}

export async function shutdownMashiroBot() {
  if (!runtimePromise) return { ok: true, failures: [] };
  const activeRuntime = await runtimePromise;
  return activeRuntime ? activeRuntime.shutdown() : { ok: true, failures: [] };
}

export { createMashiroBotRuntime };
