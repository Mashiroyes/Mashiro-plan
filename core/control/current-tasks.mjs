export async function collectCurrentTasks({ reminderManager, pluginSections = [] } = {}) {
  const reminders = reminderManager?.listCurrent?.() ?? [];
  return [
    { title: "活动提醒", status: "ok", items: reminders.map((item) => `${item.shortId} ${item.content}`) },
    ...await Promise.resolve(pluginSections),
  ];
}

export function formatCurrentTasks(sections) {
  return sections.map((section) => `${section.title}：${section.status === "unknown" ? "未核验" : section.items.length ? section.items.join("；") : "无"}`).join("\n");
}
