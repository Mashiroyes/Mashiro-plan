import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createContentCache } from "../../../core/cache/content-cache.mjs";
import { runLocalProcess as defaultRunLocalProcess } from "../../../core/execution/local-process.mjs";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plannerCli = path.join(pluginRoot, "planner", "planner.py");
const recordChartRenderer = path.join(pluginRoot, "planner", "chart.py");
const englishChartRenderer = path.join(pluginRoot, "planner", "english_skills_chart.py");
const managePlanScript = path.join(pluginRoot, "windows", "manage-plan.ps1");
const routineReminderScript = path.join(pluginRoot, "windows", "routine-reminder.ps1");
const CHART_CACHE_VERSION = "planner-chart-v2";

function pythonExecutable(context) {
  if (context.pythonExecutable) return context.pythonExecutable;
  if (process.env.OPENCLAW_PYTHON_PATH) return process.env.OPENCLAW_PYTHON_PATH;
  if (process.env.MASHIROBOT_PYTHON) return process.env.MASHIROBOT_PYTHON;
  const local = path.join(os.homedir(), "AppData", "Local", "Python", "pythoncore-3.14-64", "python.exe");
  return existsSync(local) ? local : "python";
}

function powershellExecutable(context) {
  if (context.powershellExecutable) return context.powershellExecutable;
  if (process.env.MASHIROBOT_PWSH) return process.env.MASHIROBOT_PWSH;
  const windowsApps = path.join(os.homedir(), "AppData", "Local", "Microsoft", "WindowsApps", "pwsh.exe");
  return existsSync(windowsApps) ? windowsApps : "pwsh.exe";
}

function appendNamedArguments(target, values) {
  for (const [name, value] of Object.entries(values ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    target.push(`-${name}`);
    if (value !== true) target.push(String(value));
  }
}

function plannerEnvironment(context) {
  return {
    ...process.env,
    PYTHONUTF8: "1",
    OPENCLAW_PLANNER_DB_PATH: String(context.sqlitePath),
    ...(context.englishKeywordsPath ? { OPENCLAW_ENGLISH_KEYWORDS_PATH: String(context.englishKeywordsPath) } : {}),
  };
}

async function fileHash(file) {
  try {
    return createHash("sha256").update(await readFile(file)).digest("hex");
  } catch {
    return "missing";
  }
}

function defaultRemoveScheduledTask(taskName) {
  const name = String(taskName ?? "");
  if (!/^(?:OpenClaw-General-|OpenClaw-Wakeup-)/u.test(name)) return Promise.resolve(false);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("schtasks.exe", ["/Delete", "/TN", name, "/F"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

export function createPlanRuntime(context = {}) {
  if (context.planRuntime) return context.planRuntime;
  if (!context.sqlitePath) throw new TypeError("context.sqlitePath is required");

  const runner = context.runLocalProcess ?? defaultRunLocalProcess;
  const tempRoot = path.resolve(context.tempRoot ?? os.tmpdir());
  const chartCache = context.planChartCache ?? createContentCache({
    root: path.join(tempRoot, "cache"),
    namespace: "planner-charts",
    maxEntries: 64,
    maxBytes: 256 * 1024 * 1024,
  });

  const runPlanner = async (args, options = {}) => {
    const result = await runner({
      executable: pythonExecutable(context),
      args: [plannerCli, ...args.map(String)],
      timeoutMs: options.timeoutMs ?? options.timeout ?? 10_000,
      env: plannerEnvironment(context),
      output: "json",
      jsonMode: "document",
      maxStdoutBytes: options.maxStdoutBytes ?? 4 * 1024 * 1024,
      maxStderrBytes: options.maxStderrBytes ?? 256 * 1024,
      signal: options.signal,
    });
    return result.value;
  };

  const runPowerShell = async (script, action, values = {}, timeoutMs = 30_000, options = {}) => {
    const args = [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", script, "-Action", action,
    ];
    appendNamedArguments(args, values);
    const result = await runner({
      executable: powershellExecutable(context),
      args,
      timeoutMs,
      env: plannerEnvironment(context),
      output: "json",
      jsonMode: "document",
      maxStdoutBytes: 4 * 1024 * 1024,
      maxStderrBytes: 256 * 1024,
      signal: options.signal,
    });
    return result.value;
  };

  async function generateChart(command, payload, rendererPath) {
    if (process.env.OPENCLAW_FORCE_CHART_FAILURE === "1") {
      throw new Error("forced chart failure for regression testing");
    }
    const [rendererHash, keywordHash] = await Promise.all([
      fileHash(rendererPath),
      context.englishKeywordsPath ? fileHash(context.englishKeywordsPath) : Promise.resolve("default"),
    ]);
    const cached = await chartCache.getOrCreate({
      keyPayload: { command, payload, rendererHash, keywordHash },
      version: CHART_CACHE_VERSION,
      extension: ".png",
      create: async ({ outputPaths }) => {
        await runPlanner([
          command,
          "--payload-base64", Buffer.from(JSON.stringify(payload), "utf8").toString("base64"),
          "--output", outputPaths[0],
        ], { timeoutMs: 30_000 });
        if (!existsSync(outputPaths[0])) throw new Error(command === "chart" ? "图表文件没有生成" : "英语能力图表文件没有生成");
        return outputPaths;
      },
    });
    return cached[0];
  }

  return Object.freeze({
    runPlanner,
    runManagePlan(action, values = {}, options = {}) {
      return runPowerShell(managePlanScript, action, { ...values, OperationId: values.OperationId ?? randomUUID() }, 45_000, options);
    },
    runRoutineAction(action, values = {}, options = {}) {
      return runPowerShell(routineReminderScript, action, { ...values, OperationId: values.OperationId ?? randomUUID() }, 120_000, options);
    },
    removeScheduledTask: context.removeScheduledTask ?? defaultRemoveScheduledTask,
    generateRecordChart(payload) {
      return generateChart("chart", payload, recordChartRenderer);
    },
    generateEnglishSkillsChart(payload) {
      return generateChart("english-skills-chart", payload, englishChartRenderer);
    },
    copyChartForUse(paths) {
      return chartCache.copyForUse(paths, { targetRoot: path.join(tempRoot, "outbound", "planner-charts") });
    },
  });
}

export const plannerRuntimePaths = Object.freeze({
  pluginRoot,
  plannerCli,
  managePlanScript,
  routineReminderScript,
});
