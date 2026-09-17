import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadPlugins } from "./loader/plugin-loader.mjs";
import { appendMashiroLog } from "./logging/logger.mjs";
import { createPictureHelpService } from "./menu/help-service.mjs";
import { createMenuSessionStore } from "./menu/menu-session.mjs";
import { createPluginRouter } from "./router/plugin-router.mjs";

const coreDirectory = path.dirname(fileURLToPath(import.meta.url));
const planRoot = path.resolve(coreDirectory, "..");
const registry = await loadPlugins({
  pluginRoot: path.join(planRoot, "plugin"),
  logger: appendMashiroLog,
});
const menuSessions = createMenuSessionStore();
const routeMessage = createPluginRouter({
  registry,
  menuSessions,
  helpService: createPictureHelpService(),
  planRoot,
  logger: appendMashiroLog,
});

/**
 * Asynchronous OpenClaw entry point. Plugin discovery ran once above.
 */
export async function handleMashiroBotMessage(rawText, context = {}) {
  return routeMessage(rawText, { ...context, planRoot: context.planRoot ?? planRoot });
}

export { registry as pluginRegistry };
