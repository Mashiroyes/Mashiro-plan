import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { shanghaiParts } from "./core/dates.mjs";
import { parseLootCommand } from "./core/parser.mjs";
import { createLootStore } from "./core/store.mjs";

const pluginRoot = path.dirname(fileURLToPath(import.meta.url));

function result(reply, command = "爽点") {
  return { handled: true, command, reply, mediaPaths: [] };
}

export function match(message) {
  return parseLootCommand(message) !== null;
}

export function handle(message, context = {}) {
  const command = parseLootCommand(message);
  if (!command) throw new Error("无法解析战利品命令。");
  if (command.kind === "help") {
    return context.renderPluginHelp?.("mashirobot-plugin-loot", { detailed: command.detailed })
      ?? result(getHelp().fallbackText, command.detailed ? "战利品详细帮助" : "战利品帮助");
  }
  if (command.kind === "invalid") return result(command.error, "记录爽点");

  const entryDate = shanghaiParts(context.now ?? new Date()).date;
  createLootStore(context.sqlitePath).save(entryDate, command.content, context.now ?? new Date());
  return result("已记录今天的爽点；当天再次发送会覆盖这次内容。", "记录爽点");
}

export function healthCheck() {
  const required = ["core/parser.mjs", "core/store.mjs", "core/messages.mjs"];
  const paths = required.map((relative) => path.join(pluginRoot, relative));
  return { ok: paths.every((entry) => fs.existsSync(entry)), name: "mashirobot-plugin-loot", paths };
}

export function getHelp() {
  return {
    groups: [
      { title: "记录爽点", items: ["第一行写“爽点”，下一行开始自由记录", "同一天最后一次有效发送覆盖前一次"] },
      { title: "自动提醒", items: ["21:00 至 22:00 未记录时每 10 分钟提醒", "第二天 10:00 回放前一天最终记录"] },
    ],
    detailedGroups: [
      { title: "输入格式", items: ["爽点", "下一行开始写今天真实完成的内容，可以自由换行", "只发“爽点”不会保存空记录"] },
      { title: "保存规则", items: ["每天只保留最后一次完整内容", "不设置固定任务类别，不评分、不改写"] },
      { title: "提醒规则", items: ["21:00、21:10 至 22:00 检查当天记录", "记录后当晚不再提醒；前一天无记录时 10:00 静默"] },
    ],
    fallbackText: "爽点\n今天真实完成的内容，可以自由换行。\n\n同一天最后一次有效发送覆盖前一次；21:00 至 22:00 提醒，第二天 10:00 回放。",
  };
}
