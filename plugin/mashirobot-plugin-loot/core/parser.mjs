const HELP_COMMANDS = new Map([
  ["/战利品", false],
  ["/战利品详细", true],
]);

export function parseLootCommand(message) {
  const text = String(message ?? "").replace(/\r\n?/gu, "\n").trim();
  if (HELP_COMMANDS.has(text)) {
    return { kind: "help", detailed: HELP_COMMANDS.get(text) };
  }

  const [firstLine, ...bodyLines] = text.split("\n");
  if (firstLine !== "爽点") return null;
  const content = bodyLines.join("\n").trim();
  if (!content) return { kind: "invalid", error: "请在“爽点”下一行写下今天的内容。" };
  return { kind: "save", content };
}
