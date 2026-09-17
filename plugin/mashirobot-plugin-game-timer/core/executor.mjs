export function buildReminderMessage(task) {
  return `真白，${task.displayName}的游玩时间到了，请保存并关闭游戏。${task.forceAfter}分钟后仍未关闭，电脑会强制退出游戏。`;
}

export function buildForceMessage(task) {
  return `真白，${task.displayName}仍在运行，已按约定强制退出。`;
}
