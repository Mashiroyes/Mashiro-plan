import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRotatingBackup } from "../control/backup-manager.mjs";
import { collectCurrentTasks, formatCurrentTasks } from "../control/current-tasks.mjs";
import { migrateControlDatabase } from "../control/database.mjs";
import { inspectDatabase } from "../control/database-health.mjs";
import { createLifecycleHooks } from "../control/lifecycle-hooks.mjs";
import { createReminderManager } from "../control/reminder-manager.mjs";
import { createCommandRouter } from "../control/command-router.mjs";
import { runSystemDiagnostics, formatDiagnostics } from "../control/system-diagnostics.mjs";
import { createUndoManager } from "../control/undo-manager.mjs";
import { reconcileWindowsTasks } from "../control/windows-task-reconciler.mjs";
import { runLocalProcess } from "../execution/local-process.mjs";
import { loadPlugins } from "../loader/plugin-loader.mjs";
import { appendMashiroLog } from "../logging/logger.mjs";
import { createPictureHelpService } from "../menu/help-service.mjs";
import { createMenuSessionStore } from "../menu/menu-session.mjs";
import { createPluginRouter } from "../router/plugin-router.mjs";
import { createClock } from "../time/clock.mjs";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultPlanRoot = path.resolve(moduleDirectory, "..", "..");

function shortError(error) {
  return String(error instanceof Error ? error.message : error).replace(/\s+/gu, " ").trim().slice(0, 300);
}

async function inspectPluginHealth(registry, timeoutMs) {
  const checks = Promise.all(registry.plugins.map(async (plugin) => {
    try {
      const health = await plugin.module.healthCheck();
      return { pluginId: plugin.manifest.id, ok: health?.ok === true, health };
    } catch (error) {
      return { pluginId: plugin.manifest.id, ok: false, error: shortError(error) };
    }
  }));
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref?.();
  });
  const results = await Promise.race([checks, timeout]);
  clearTimeout(timer);
  return results;
}

export async function createMashiroBotRuntime(options = {}) {
  const planRoot = path.resolve(options.planRoot ?? defaultPlanRoot);
  const sqlitePath = path.resolve(options.sqlitePath ?? path.join(planRoot, "sqlite", "openclaw-planner.sqlite"));
  const backupRoot = path.resolve(options.backupRoot ?? path.join(planRoot, "sqlite", "backups", "control"));
  const logger = options.logger ?? appendMashiroLog;
  const processRunner = options.runLocalProcess ?? runLocalProcess;
  const pluginLoader = options.loadPlugins ?? loadPlugins;
  const reconcile = options.reconcileWindowsTasks ?? reconcileWindowsTasks;
  const clock = options.clock ?? createClock();
  const state = { state: "booting", error: null, startedAt: clock.utcNow().toISOString(), shutdownFailures: [] };
  const log = (record) => logger({ pluginId: "mashirobot-core", ...record });

  try {
    (options.createRotatingBackup ?? createRotatingBackup)({ sqlitePath, backupRoot, reason: "startup-before-migration" });
    (options.migrateControlDatabase ?? migrateControlDatabase)(sqlitePath);
  } catch (error) {
    state.state = "failed";
    state.error = shortError(error);
    log({ level: "error", event: "startup_failed", message: state.error });
    throw error;
  }

  const reminderManager = (options.createReminderManager ?? createReminderManager)({ sqlitePath, now: () => clock.utcNow() });
  const undoManager = (options.createUndoManager ?? createUndoManager)({ sqlitePath, now: () => clock.utcNow() });
  const lifecycleHooks = createLifecycleHooks();
  const registry = await pluginLoader({ pluginRoot: path.join(planRoot, "plugin"), logger });
  let degraded = registry.failures.length > 0;

  for (const plugin of registry.plugins) {
    if (typeof plugin.module.registerLifecycle !== "function") continue;
    try {
      await plugin.module.registerLifecycle({ undoManager, lifecycleHooks, sqlitePath, planRoot, pluginRoot: plugin.directory, runLocalProcess: processRunner, logger, clock });
    } catch (error) {
      degraded = true;
      registry.failures.push({ code: "PLUGIN_LIFECYCLE_ERROR", pluginId: plugin.manifest.id, message: shortError(error) });
      log({ level: "error", pluginId: plugin.manifest.id, event: "plugin_lifecycle_failed", message: shortError(error) });
    }
  }

  const health = await inspectPluginHealth(registry, options.pluginHealthTimeoutMs ?? 10_000);
  if (!health || health.some((entry) => !entry.ok)) degraded = true;

  let lastInspection = null;
  try {
    lastInspection = await reconcile({ sqlitePath, apply: options.applyReconciliation !== false, runner: processRunner });
    if (!lastInspection.ok) degraded = true;
    log({ level: lastInspection.ok ? "info" : "error", event: "job_reconcile", message: JSON.stringify({ missing: lastInspection.missing?.length ?? 0, drifted: lastInspection.drifted?.length ?? 0, orphaned: lastInspection.orphaned?.length ?? 0, failed: lastInspection.failed?.length ?? 0 }) });
  } catch (error) {
    degraded = true;
    log({ level: "error", event: "job_reconcile_failed", message: shortError(error) });
  }

  const inspectTasks = async () => {
    lastInspection = await reconcile({ sqlitePath, apply: false, runner: processRunner });
    return lastInspection;
  };
  const systemRouter = createCommandRouter({
    reminderManager,
    inspectDatabase: () => inspectDatabase(sqlitePath, { backupRoot }),
    undoManager,
    currentTasks: async () => formatCurrentTasks(await collectCurrentTasks({ reminderManager, pluginSections: lifecycleHooks.collectCurrentTasks({ clock }) })),
    diagnostics: async () => formatDiagnostics(await runSystemDiagnostics({ sqlitePath, planRoot, jobInspection: await inspectTasks(), runner: processRunner, runtimeStatus: state })),
    onAcknowledge: (reminder, context) => lifecycleHooks.runAcknowledgement(reminder, context),
  });

  const routeMessage = createPluginRouter({
    registry,
    menuSessions: options.menuSessions ?? createMenuSessionStore(),
    helpService: options.helpService ?? createPictureHelpService(),
    planRoot,
    sqlitePath,
    logger,
    runLocalProcess: processRunner,
    clock,
    systemRouter,
    pluginHandleTimeoutMs: options.pluginHandleTimeoutMs,
  });

  state.state = degraded ? "degraded" : "ready";
  log({ level: degraded ? "error" : "info", event: "startup_completed", message: JSON.stringify({ state: state.state, loadedPlugins: registry.plugins.length, pluginFailures: registry.failures.length }) });
  let shutdownPromise = null;
  return Object.freeze({
    registry,
    sqlitePath,
    planRoot,
    handleMessage: (rawText, rawContext = {}) => routeMessage(rawText, rawContext),
    diagnostics: async () => runSystemDiagnostics({ sqlitePath, planRoot, jobInspection: await inspectTasks(), runner: processRunner, runtimeStatus: state }),
    getStatus: () => Object.freeze({ ...state, planRoot, sqlitePath, loadedPluginCount: registry.plugins.length }),
    shutdown() {
      shutdownPromise ??= lifecycleHooks.shutdown({ clock, logger }).then((failures) => {
        state.shutdownFailures = failures;
        return { ok: failures.length === 0, failures };
      });
      return shutdownPromise;
    },
  });
}
