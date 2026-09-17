import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseLearningCommand } from "./core/parser.mjs";
import { loadCurriculum } from "./core/curriculum.mjs";
import { createLearningStore } from "./core/storage.mjs";
import { handleLearningCommand } from "./core/handler.mjs";
import { helpData } from "./help/help-data.mjs";

const pluginRoot = path.dirname(fileURLToPath(import.meta.url));

function wakeFeedbackTask(context) {
  if (typeof context.wakeFinancialReportFeedbackTask === "function") {
    return context.wakeFinancialReportFeedbackTask();
  }
  if (process.platform !== "win32") return;
  const started = spawnSync("schtasks.exe", ["/Run", "/TN", "MashiroBot Financial Report Feedback"], {
    encoding: "utf8", windowsHide: true,
  });
  if (started.status !== 0) throw new Error(String(started.stderr || started.stdout || "计划任务启动失败").trim());
}

export function match(message) {
  return parseLearningCommand(message) !== null;
}

export function handle(message, context = {}) {
  const command = parseLearningCommand(message);
  if (!command) throw new Error("财报插件收到未匹配消息。");
  if (command.kind === "help") {
    return context.renderPluginHelp?.("mashirobot-plugin-financial-report", { detailed: command.detailed })
      ?? { handled: true, command: "财报课程帮助", reply: helpData.fallbackText, mediaPaths: [] };
  }
  if (command.kind === "invalid") {
    return { handled: true, command: command.command, reply: command.error, mediaPaths: [] };
  }
  if (!context.sqlitePath) throw new Error("财报课程需要正式 SQLite 路径。");
  const store = createLearningStore(context.sqlitePath);
  const now = context.now ?? new Date();
  const installedDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  store.initialize({
    accountId: String(context.accountId ?? "default"),
    conversationId: String(context.conversationId ?? "default"),
    installedDate: context.financialReportInstalledDate ?? installedDate,
  });
  try {
    return handleLearningCommand(command, context, {
      store,
      curriculum: loadCurriculum(pluginRoot),
      now,
      wakeFeedbackTask: () => wakeFeedbackTask(context),
    });
  } finally {
    store.close();
  }
}

export function healthCheck() {
  const required = [
    path.join(pluginRoot, "plugin.json"),
    path.join(pluginRoot, "core", "parser.mjs"),
    path.join(pluginRoot, "core", "handler.mjs"),
    path.join(pluginRoot, "core", "storage.mjs"),
    path.join(pluginRoot, "help", "help-data.mjs"),
  ];
  return { ok: required.every((item) => fs.existsSync(item)), name: "mashirobot-plugin-financial-report", required };
}

export function getHelp() {
  return helpData;
}
