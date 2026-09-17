import { readFileSync } from "node:fs";
import { join } from "node:path";

const LESSON_KEYS = [
  "courseType", "lessonNumber", "company", "title", "objective", "reading",
  "facts", "explanation", "pitfall", "question", "referencePoints", "sourceId",
  "reportPeriod", "pageNumbers", "units", "estimatedMinutes",
];

const SOURCE_KEYS = [
  "sourceId", "company", "documentTitle", "reportPeriod", "officialUrl",
  "retrievedAt", "sha256", "localVerificationPath",
];

const ALWAYS_OFFICIAL_HOSTS = new Set([
  "cninfo.com.cn", "www.cninfo.com.cn", "static.cninfo.com.cn",
  "hkexnews.hk", "www.hkexnews.hk", "www1.hkexnews.hk",
  "static.www.tencent.com",
]);

function requireExactKeys(record, requiredKeys, label) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new TypeError(`${label} 必须是对象`);
  }
  const missing = requiredKeys.filter((key) => !(key in record));
  const extra = Object.keys(record).filter((key) => !requiredKeys.includes(key));
  if (missing.length || extra.length) {
    throw new TypeError(`${label} 字段错误；缺少: ${missing.join(", ") || "无"}；多余: ${extra.join(", ") || "无"}`);
  }
}

function requireText(value, field, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label}.${field} 必须是非空文本`);
  }
}

function requireTextArray(value, field, label) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new TypeError(`${label}.${field} 必须是非空文本数组`);
  }
}

export function validateLesson(lesson, label = "lesson") {
  requireExactKeys(lesson, LESSON_KEYS, label);
  if (!["financial_report", "prospectus"].includes(lesson.courseType)) {
    throw new TypeError(`${label}.courseType 无效`);
  }
  if (!Number.isInteger(lesson.lessonNumber) || lesson.lessonNumber < 1) {
    throw new TypeError(`${label}.lessonNumber 必须是正整数`);
  }
  for (const field of ["company", "title", "objective", "reading", "explanation", "pitfall", "question", "sourceId", "reportPeriod"]) {
    requireText(lesson[field], field, label);
  }
  requireTextArray(lesson.referencePoints, "referencePoints", label);
  requireTextArray(lesson.units, "units", label);
  if (!Array.isArray(lesson.pageNumbers) || lesson.pageNumbers.length === 0 || lesson.pageNumbers.some((page) => !Number.isInteger(page) || page < 1)) {
    throw new TypeError(`${label}.pageNumbers 必须是非空正整数数组`);
  }
  if (!Number.isInteger(lesson.estimatedMinutes) || lesson.estimatedMinutes < 1 || lesson.estimatedMinutes > 60) {
    throw new TypeError(`${label}.estimatedMinutes 必须是 1—60 的整数`);
  }
  if (!Array.isArray(lesson.facts) || lesson.facts.length === 0) {
    throw new TypeError(`${label}.facts 必须是非空数组`);
  }
  lesson.facts.forEach((fact, index) => {
    const factLabel = `${label}.facts[${index}]`;
    const factKeys = ["text", "value", "unit", "period", "pdfPage"];
    const allowedFactKeys = [...factKeys, "sourceId"];
    const missing = factKeys.filter((key) => !(key in fact));
    const extra = Object.keys(fact).filter((key) => !allowedFactKeys.includes(key));
    if (missing.length || extra.length) {
      throw new TypeError(`${factLabel} 字段错误；缺少: ${missing.join(", ") || "无"}；多余: ${extra.join(", ") || "无"}`);
    }
    for (const field of ["text", "value", "unit", "period"]) requireText(fact[field], field, factLabel);
    if (!Number.isInteger(fact.pdfPage) || fact.pdfPage < 1) throw new TypeError(`${factLabel}.pdfPage 必须是正整数`);
    if (!lesson.pageNumbers.includes(fact.pdfPage)) throw new TypeError(`${factLabel}.pdfPage 未列入 pageNumbers`);
    if (!lesson.units.includes(fact.unit)) throw new TypeError(`${factLabel}.unit 未列入 units`);
    // A lesson may combine annual flow figures with point-in-time balances.
    // Each fact therefore carries its own exact period instead of being forced
    // to equal the lesson's broader report period.
    if (fact.sourceId !== undefined) requireText(fact.sourceId, "sourceId", factLabel);
  });
  return lesson;
}

export function validateSource(source, label = "source") {
  requireExactKeys(source, SOURCE_KEYS, label);
  for (const field of ["sourceId", "company", "documentTitle", "reportPeriod", "officialUrl", "retrievedAt", "sha256", "localVerificationPath"]) {
    requireText(source[field], field, label);
  }
  let url;
  try { url = new URL(source.officialUrl); } catch { throw new TypeError(`${label}.officialUrl 无效`); }
  if (url.protocol !== "https:") throw new TypeError(`${label}.officialUrl 必须使用 HTTPS`);
  const host = url.hostname.toLowerCase();
  const declaredIrHost = source.localVerificationPath.startsWith("official-ir:")
    ? source.localVerificationPath.slice("official-ir:".length).toLowerCase()
    : null;
  if (!ALWAYS_OFFICIAL_HOSTS.has(host) && host !== declaredIrHost) {
    throw new TypeError(`${label}.officialUrl 使用非官方来源域名: ${host}`);
  }
  if (!/^[a-f0-9]{64}$/i.test(source.sha256)) throw new TypeError(`${label}.sha256 无效`);
  return source;
}

function parseJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function validateSequence(list, courseType, expectedCount) {
  if (!Array.isArray(list)) throw new TypeError(`${courseType} 课程文件必须是数组`);
  if (list.length !== expectedCount) throw new RangeError(`${courseType} 课程数量应为 ${expectedCount}，实际为 ${list.length}`);
  list.forEach((lesson, index) => {
    validateLesson(lesson, `${courseType}[${index}]`);
    if (lesson.courseType !== courseType) throw new TypeError(`${courseType}[${index}].courseType 不匹配`);
    if (lesson.lessonNumber !== index + 1) throw new RangeError(`${courseType} 课程序号必须从 1 连续排列`);
  });
}

export function loadCurriculum(pluginRoot) {
  const directory = join(pluginRoot, "curriculum");
  const financialReports = parseJson(join(directory, "financial-reports.json"));
  const prospectuses = parseJson(join(directory, "prospectuses.json"));
  const sources = parseJson(join(directory, "sources.json"));
  validateSequence(financialReports, "financial_report", 30);
  validateSequence(prospectuses, "prospectus", 8);
  if (!Array.isArray(sources)) throw new TypeError("sources 必须是数组");
  sources.forEach((source, index) => validateSource(source, `sources[${index}]`));
  const sourceIds = new Set(sources.map((source) => source.sourceId));
  if (sourceIds.size !== sources.length) throw new TypeError("sourceId 必须唯一");
  for (const lesson of [...financialReports, ...prospectuses]) {
    if (!sourceIds.has(lesson.sourceId)) throw new TypeError(`课程引用了不存在的来源: ${lesson.sourceId}`);
    for (const fact of lesson.facts) {
      if (fact.sourceId && !sourceIds.has(fact.sourceId)) throw new TypeError(`事实引用了不存在的来源: ${fact.sourceId}`);
    }
  }
  return { financialReports, prospectuses, sources };
}

export function getLesson(curriculum, courseType, lessonNumber) {
  const list = courseType === "financial_report"
    ? curriculum.financialReports
    : courseType === "prospectus" ? curriculum.prospectuses : null;
  if (!list) throw new TypeError(`未知课程类型: ${courseType}`);
  const lesson = list.find((item) => item.lessonNumber === lessonNumber);
  if (!lesson) throw new RangeError(`课程不存在: ${courseType} #${lessonNumber}`);
  return lesson;
}

export function formatLessonCard(lesson, source) {
  const courseName = lesson.courseType === "financial_report" ? `第 ${lesson.lessonNumber} 天财报课` : `第 ${lesson.lessonNumber} 课招股书课`;
  const facts = lesson.facts.map((fact, index) => `${index + 1}. ${fact.text}：${fact.value} ${fact.unit}（${fact.period}，PDF 第 ${fact.pdfPage} 页）`).join("\n");
  const sourceList = Array.isArray(source) ? source : source ? [source] : [];
  const links = sourceList.length
    ? sourceList.map((item) => `${item.company ?? "官方来源"}：${item.officialUrl}`).join("\n")
    : "来源暂不可用";
  return [
    `【${courseName}｜${lesson.company}】`,
    lesson.title,
    `预计 ${lesson.estimatedMinutes} 分钟｜目标：${lesson.objective}`,
    `阅读：${lesson.reading}`,
    `【财报事实】\n${facts}`,
    `【通俗解释】\n${lesson.explanation}`,
    `【常见误区】\n${lesson.pitfall}`,
    `【今日问题】\n${lesson.question}`,
    `【官方原文】\n${links}\nPDF 页码：${lesson.pageNumbers.join("、")}`,
    "仅用于学习财报与商业分析，不构成投资建议。",
  ].join("\n\n");
}
