import assert from "node:assert/strict";
import test from "node:test";
import { resolvePlanRoot } from "../core/runtime/plan-root.mjs";

test("MASHIROBOT_PLAN_ROOT overrides a captured module URL", () => {
  assert.equal(resolvePlanRoot({
    env: { MASHIROBOT_PLAN_ROOT: "D:\\repo\\plan" },
    moduleUrl: "file:///C:/Users/test/.openclaw/plugin-captures/random/core/runtime/mashirobot-runtime.mjs",
  }), "D:\\repo\\plan");
});

test("captured modules require the explicit root", () => {
  assert.throws(() => resolvePlanRoot({
    env: {},
    moduleUrl: "file:///C:/Users/test/.openclaw/plugin-captures/random/core/runtime/mashirobot-runtime.mjs",
  }), /MASHIROBOT_PLAN_ROOT is required/);
});

test("normal repository modules infer the plan root", () => {
  assert.equal(resolvePlanRoot({
    env: {},
    moduleUrl: "file:///D:/repo/plan/core/runtime/mashirobot-runtime.mjs",
  }), "D:\\repo\\plan");
});
