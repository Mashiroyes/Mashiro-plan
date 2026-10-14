import assert from "node:assert/strict";
import test from "node:test";
import { createRunState, nextPhase, redactReport, summarizeRun } from "../core/deployment/run-state.mjs";

test("resume starts at the first non-passed phase", () => { const state = createRunState({ phases: ["preflight", "configure", "backup"] }); state.phases.preflight.status = "passed"; assert.equal(nextPhase(state), "configure"); });
test("warnings and unverified gates cannot become passed", () => { assert.equal(summarizeRun({ warnings: ["audit"] }), "completed_with_warnings"); assert.equal(summarizeRun({ unverified: ["WeChat"] }), "unverified"); assert.equal(summarizeRun({ requiredFailures: ["adapter"] }), "failed"); });
test("reports redact delivery targets and credentials", () => { assert.deepEqual(redactReport({ weixinTarget: "user-12345678", nested: { token: "abcdef" }, safe: "ok" }), { weixinTarget: "***5678", nested: { token: "***cdef" }, safe: "ok" }); });
