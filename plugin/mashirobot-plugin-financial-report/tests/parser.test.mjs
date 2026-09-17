import assert from "node:assert/strict";
import test from "node:test";
import { parseLearningCommand } from "../core/parser.mjs";

test("parses financial-report commands", () => {
  assert.deepEqual(parseLearningCommand("财报课程"), { kind: "status", courseType: "financial_report" });
  assert.deepEqual(parseLearningCommand("今日财报"), { kind: "today", courseType: "financial_report" });
  assert.deepEqual(parseLearningCommand("补学第7天"), {
    kind: "catchup", courseType: "financial_report", lessonNumber: 7,
  });
  assert.deepEqual(parseLearningCommand("财报答案 第7天 经营现金流低于净利润"), {
    kind: "answer", courseType: "financial_report", lessonNumber: 7, answer: "经营现金流低于净利润",
  });
  assert.deepEqual(parseLearningCommand("财报答案 毛利率反映收入扣除营业成本后的余量"), {
    kind: "answer", courseType: "financial_report", lessonNumber: null, answer: "毛利率反映收入扣除营业成本后的余量",
  });
  assert.deepEqual(parseLearningCommand("暂停财报"), { kind: "pause", courseType: "all" });
  assert.deepEqual(parseLearningCommand("继续财报"), { kind: "resume", courseType: "all" });
  assert.deepEqual(parseLearningCommand("重学今日财报"), { kind: "relearn", courseType: "financial_report" });
});

test("parses prospectus commands", () => {
  assert.deepEqual(parseLearningCommand("招股书课程"), { kind: "status", courseType: "prospectus" });
  assert.deepEqual(parseLearningCommand("今日招股书"), { kind: "today", courseType: "prospectus" });
  assert.deepEqual(parseLearningCommand("补学招股书第3课"), {
    kind: "catchup", courseType: "prospectus", lessonNumber: 3,
  });
  assert.deepEqual(parseLearningCommand("招股书答案 第3课 渠道集中会增加风险"), {
    kind: "answer", courseType: "prospectus", lessonNumber: 3, answer: "渠道集中会增加风险",
  });
});

test("parses plugin help commands", () => {
  assert.deepEqual(parseLearningCommand("/财报课程"), {
    kind: "help", courseType: "all", detailed: false,
  });
  assert.deepEqual(parseLearningCommand("/财报课程详细"), {
    kind: "help", courseType: "all", detailed: true,
  });
});

test("rejects out-of-range and empty answers", () => {
  assert.equal(parseLearningCommand("补学第31天").kind, "invalid");
  assert.equal(parseLearningCommand("补学招股书第9课").kind, "invalid");
  assert.equal(parseLearningCommand("财报答案").kind, "invalid");
  assert.equal(parseLearningCommand("招股书答案 第0课 内容").kind, "invalid");
  assert.equal(parseLearningCommand("普通聊天"), null);
});
