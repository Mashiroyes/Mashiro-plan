const PAUSE_REMINDERS = /^暂停提醒\s*(\d{1,4})\s*分钟$/u;
const ACKNOWLEDGE_REMINDER = /^(?:收到|收到了|知道了|不用提醒了)(?:\s+R\d{3})?$/iu;

export const HELP_ALIASES = Object.freeze(new Set(["help", "/help", "帮助"]));
export const SCOPED_HELP_ALIASES = Object.freeze(new Map([
  ["提醒帮助", "mashirobot-plugin-plan"],
  ["游戏帮助", "mashirobot-plugin-game-timer"],
  ["禁止帮助", "mashirobot-plugin-game-timer"],
  ["英语帮助", "mashirobot-plugin-language"],
]));

export const CORE_EXACT_COMMANDS = Object.freeze(new Set([
  ...HELP_ALIASES,
  ...SCOPED_HELP_ALIASES.keys(),
  "今晚静默",
  "恢复提醒",
  "查看当前提醒",
  "数据库自检",
  "撤销上一操作",
  "当前任务",
  "自检",
]));

export function matchPauseReminderCommand(text) {
  return PAUSE_REMINDERS.exec(String(text ?? "").trim());
}

export function isReminderAcknowledgement(text) {
  return ACKNOWLEDGE_REMINDER.test(String(text ?? "").trim());
}

export function isReservedCoreCommand(text) {
  const value = String(text ?? "").trim();
  return CORE_EXACT_COMMANDS.has(value)
    || PAUSE_REMINDERS.test(value)
    || ACKNOWLEDGE_REMINDER.test(value);
}
