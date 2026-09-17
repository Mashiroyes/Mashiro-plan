import assert from "node:assert/strict";
import test from "node:test";

import {
  formatLessonCard,
  getLesson,
  loadCurriculum,
  validateLesson,
  validateSource,
} from "../core/curriculum.mjs";

const pluginRoot = new URL("..", import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (value) => value.slice(1));

function validLesson(overrides = {}) {
  return {
    courseType: "financial_report",
    lessonNumber: 1,
    company: "测试公司",
    title: "认识年报",
    objective: "理解三张主要报表",
    reading: "阅读第 1—2 页",
    facts: [
      { text: "测试事实", value: "100", unit: "万元", period: "2025年度", pdfPage: 1 },
    ],
    explanation: "这是通俗解释。",
    pitfall: "不要混淆收入与利润。",
    question: "收入和利润有什么区别？",
    referencePoints: ["收入不等于利润"],
    sourceId: "test-source",
    reportPeriod: "2025年度",
    pageNumbers: [1, 2],
    units: ["万元"],
    estimatedMinutes: 12,
    ...overrides,
  };
}

test("validator reports every missing traceability field", () => {
  const lesson = validLesson();
  delete lesson.pageNumbers;
  delete lesson.units;
  delete lesson.reportPeriod;
  delete lesson.referencePoints;

  assert.throws(
    () => validateLesson(lesson, "fixture"),
    (error) => ["pageNumbers", "units", "reportPeriod", "referencePoints"]
      .every((field) => error.message.includes(field)),
  );
});

test("loads exactly 30 financial-report and 8 prospectus lessons", () => {
  const curriculum = loadCurriculum(pluginRoot);

  assert.equal(curriculum.financialReports.length, 30);
  assert.equal(curriculum.prospectuses.length, 8);
  assert.deepEqual(curriculum.financialReports.map((item) => item.lessonNumber),
    Array.from({ length: 30 }, (_, index) => index + 1));
  assert.deepEqual(curriculum.prospectuses.map((item) => item.lessonNumber),
    Array.from({ length: 8 }, (_, index) => index + 1));
});

test("rejects a non-official source domain", () => {
  assert.throws(() => validateSource({
    sourceId: "bad",
    company: "测试公司",
    documentTitle: "测试文件",
    reportPeriod: "2025年度",
    officialUrl: "https://example.com/report.pdf",
    retrievedAt: "2026-08-09",
    sha256: "a".repeat(64),
    localVerificationPath: "test.pdf",
  }), /非官方来源域名/);
});

test("gets and formats a lesson card with all required labels", () => {
  const lesson = validLesson();
  const curriculum = { financialReports: [lesson], prospectuses: [], sources: [] };
  assert.equal(getLesson(curriculum, "financial_report", 1), lesson);
  assert.throws(() => getLesson(curriculum, "financial_report", 2), RangeError);

  const card = formatLessonCard(lesson, { officialUrl: "https://www.cninfo.com.cn/test.pdf" });
  for (const label of ["【财报事实】", "【通俗解释】", "【常见误区】", "【今日问题】", "【官方原文】"]) {
    assert.match(card, new RegExp(label));
  }
  assert.match(card, /2025年度/);
  assert.match(card, /万元/);
  assert.match(card, /PDF 第 1 页/);
});
