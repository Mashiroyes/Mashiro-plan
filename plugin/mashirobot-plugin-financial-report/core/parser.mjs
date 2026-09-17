function invalid(error, command = "财报与招股书") {
  return { kind: "invalid", courseType: "all", command, error };
}

function parseBoundedNumber(raw, maximum, label) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    return { error: `${label}必须在1～${maximum}之间。` };
  }
  return { value };
}

export function parseLearningCommand(message) {
  const text = String(message ?? "").trim();
  if (!text) return null;
  if (text === "/财报课程") return { kind: "help", courseType: "all", detailed: false };
  if (text === "/财报课程详细") return { kind: "help", courseType: "all", detailed: true };
  if (text === "财报课程") return { kind: "status", courseType: "financial_report" };
  if (text === "招股书课程") return { kind: "status", courseType: "prospectus" };
  if (text === "今日财报") return { kind: "today", courseType: "financial_report" };
  if (text === "今日招股书") return { kind: "today", courseType: "prospectus" };
  if (text === "暂停财报") return { kind: "pause", courseType: "all" };
  if (text === "继续财报") return { kind: "resume", courseType: "all" };
  if (text === "重学今日财报") return { kind: "relearn", courseType: "financial_report" };

  let match = text.match(/^补学第(\d+)天$/u);
  if (match) {
    const parsed = parseBoundedNumber(match[1], 30, "财报课程天数");
    return parsed.error ? invalid(parsed.error, "补学财报") : {
      kind: "catchup", courseType: "financial_report", lessonNumber: parsed.value,
    };
  }

  match = text.match(/^补学招股书第(\d+)课$/u);
  if (match) {
    const parsed = parseBoundedNumber(match[1], 8, "招股书课程序号");
    return parsed.error ? invalid(parsed.error, "补学招股书") : {
      kind: "catchup", courseType: "prospectus", lessonNumber: parsed.value,
    };
  }

  match = text.match(/^财报答案(?:\s+第(\d+)天)?\s*(.*)$/u);
  if (match) {
    const answer = match[2].trim();
    if (!answer) return invalid("请在“财报答案”后填写你的回答。", "财报答案");
    if (!match[1]) return { kind: "answer", courseType: "financial_report", lessonNumber: null, answer };
    const parsed = parseBoundedNumber(match[1], 30, "财报课程天数");
    return parsed.error ? invalid(parsed.error, "财报答案") : {
      kind: "answer", courseType: "financial_report", lessonNumber: parsed.value, answer,
    };
  }

  match = text.match(/^招股书答案(?:\s+第(\d+)课)?\s*(.*)$/u);
  if (match) {
    const answer = match[2].trim();
    if (!answer) return invalid("请在“招股书答案”后填写你的回答。", "招股书答案");
    if (!match[1]) return { kind: "answer", courseType: "prospectus", lessonNumber: null, answer };
    const parsed = parseBoundedNumber(match[1], 8, "招股书课程序号");
    return parsed.error ? invalid(parsed.error, "招股书答案") : {
      kind: "answer", courseType: "prospectus", lessonNumber: parsed.value, answer,
    };
  }
  return null;
}
