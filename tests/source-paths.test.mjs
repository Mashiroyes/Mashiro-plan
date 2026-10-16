import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { resolvePlanSourcePath } from "../core/runtime/source-paths.mjs";

test("uses the adapter-provided plan root instead of the captured module location", () => {
  const previous = process.env.MASHIROBOT_PLAN_ROOT;
  process.env.MASHIROBOT_PLAN_ROOT = "D:\\real-plan-root";
  try {
    assert.equal(
      resolvePlanSourcePath("plugin", "mashirobot-plugin-plan", "planner", "planner.py"),
      path.resolve("D:\\real-plan-root", "plugin", "mashirobot-plugin-plan", "planner", "planner.py"),
    );
  } finally {
    if (previous === undefined) delete process.env.MASHIROBOT_PLAN_ROOT;
    else process.env.MASHIROBOT_PLAN_ROOT = previous;
  }
});
