const REPLAY_PREFIX = "与其整天沉醉于别人的故事，不如自己安心多学一些，也留下点自己的故事。";

export function buildEveningReminder() {
  return "请先记录今天的爽点，写完再继续手头的事。";
}

export function buildReplayMessage(entryDate, content) {
  const [year, month, day] = String(entryDate).split("-").map(Number);
  return `${REPLAY_PREFIX}\n\n${year}年${month}月${day}日的爽点：\n${String(content)}`;
}
