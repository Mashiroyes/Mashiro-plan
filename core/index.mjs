import { createMashiroBotRuntime } from "./runtime/mashirobot-runtime.mjs";
import { createLocalControlServer } from "./local-ui/server.mjs";
import fs from "node:fs/promises";
import path from "node:path";

let startupState = "booting";
let startupError = null;
let runtime = null;
let localControlServer = null;
export let pluginRegistry = null;

function shortError(error) {
  return String(error instanceof Error ? error.message : error).replace(/\s+/gu, " ").trim().slice(0, 300);
}

let runtimePromise = null;

function getRuntime() {
  runtimePromise ??= createMashiroBotRuntime({
    skipWindowsTaskReconciliation: process.env.MASHIROBOT_LOCAL_UI_ONLY === "1",
  }).then(async (created) => {
    runtime = created;
    pluginRegistry = created.registry;
    if (process.env.MASHIROBOT_LOCAL_UI !== "0") {
      try {
        localControlServer = await createLocalControlServer({ handleMessage: created.handleMessage });
        const urlFile = path.join(process.env.TEMP || ".", "MashiroBot", "local-control-url.txt");
        await fs.mkdir(path.dirname(urlFile), { recursive: true });
        await fs.writeFile(urlFile, `${localControlServer.url}\n`, "utf8");
        console.info(`[MashiroBot] local control console: ${localControlServer.url}`);
      }
      catch (error) { startupError = `本地控制台启动失败：${error.message}`; }
    }
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
  if (localControlServer) { await localControlServer.close(); localControlServer = null; }
  return activeRuntime ? activeRuntime.shutdown() : { ok: true, failures: [] };
}

export function getLocalControlServer() { return localControlServer; }

export { createMashiroBotRuntime };
