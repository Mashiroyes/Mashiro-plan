# Plan Period Heading Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove standalone Plan time-period headings before plan detection, persistence, and reminder generation without changing legitimate task titles.

**Architecture:** Add one exported normalization function to the existing plan route and make every plan-save path consume its normalized text. Prove behavior through the existing end-to-end route fixture and SQLite assertions so the persisted revision and reminder source titles are both covered.

**Tech Stack:** Node.js ES modules, `node:test`, `node:assert/strict`, Node SQLite, existing Python planner bridge

## Global Constraints

- Only exact standalone lines matching `凌晨`, `早上`, `上午`, `中午`, `下午`, `傍晚`, `晚上`, `夜间`, or `夜里` are removed after trimming surrounding whitespace.
- Text inside a timed item is preserved, including `18:00-18:50 下午复盘`.
- `今日计划`, `明日计划`, date parsing, query replies, and existing reminder formats remain unchanged.
- Filtering applies only to the plan-save route; daily records, wake-up parsing, and general reminders remain unchanged.
- The user's already-sent WeChat message cannot be rewritten; normalization begins after the bot receives it.
- The project directory is not a Git repository, so implementation steps must not fabricate commits or initialize a new repository.

---

### Task 1: Normalize plan input at the route boundary

**Files:**
- Modify: `plugin/mashirobot-plugin-plan/routes/plan.mjs:4-122`
- Test: `plugin/mashirobot-plugin-plan/tests/route-compatibility.test.mjs:10-235`

**Interfaces:**
- Consumes: incoming plan message as `rawText: unknown` and the existing `handle(rawText, context)` route contract.
- Produces: `normalizePlanInput(rawText): string`, returning the original lines in order except exact standalone time-period headings; `parsePlanItems`, `matchesPlan`, and `handlePlan` consume the normalized result.

- [ ] **Step 1: Write the failing normalization and persistence test**

Update the plan-route import:

```js
import {
  normalizePlanInput,
  parsePlanDate,
  parsePlanItems,
} from "../routes/plan.mjs";
```

Add this test after the existing combined-plan save test:

```js
test("filters standalone Plan period headings before persistence and reminders", async (t) => {
  const fixture = await createFixture(t, new Date("2026-08-10T11:00:00+08:00"));
  const text = [
    "今日计划",
    "上午",
    "11:00 - 12:00 哈利波特",
    "下午",
    "12:00 - 17:00 chatgpt",
    "傍晚",
    "18:00 - 18:50 下午复盘",
    "晚上",
    "20:00 - 22:00 哈利波特",
    "夜间",
  ].join("\n");

  assert.equal(
    normalizePlanInput(text),
    [
      "今日计划",
      "11:00 - 12:00 哈利波特",
      "12:00 - 17:00 chatgpt",
      "18:00 - 18:50 下午复盘",
      "20:00 - 22:00 哈利波特",
    ].join("\n"),
  );
  assert.deepEqual(
    parsePlanItems(text).map((item) => item.title),
    ["哈利波特", "chatgpt", "下午复盘", "哈利波特"],
  );

  const result = handle(text, fixture.context);
  assert.equal(result.command, "保存计划");

  const db = new DatabaseSync(fixture.sqlitePath);
  try {
    const revision = db.prepare("SELECT raw_text FROM plan_revisions").get();
    assert.ok(!/^(?:上午|下午|傍晚|晚上|夜间)$/m.test(revision.raw_text));
    assert.match(revision.raw_text, /18:00 - 18:50 下午复盘/);
    const titles = db
      .prepare("SELECT title FROM plan_items ORDER BY start_time")
      .all()
      .map((row) => row.title);
    assert.deepEqual(titles, ["哈利波特", "chatgpt", "下午复盘", "哈利波特"]);
  } finally {
    db.close();
  }
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run from `D:\BaiduSyncdisk\Study\AI\codex\codex-study`:

```powershell
node --test --test-name-pattern "filters standalone Plan period headings" plan/plugin/mashirobot-plugin-plan/tests/route-compatibility.test.mjs
```

Expected: FAIL because `normalizePlanInput` is not exported.

- [ ] **Step 3: Implement the minimal route-boundary normalization**

Add near the top of `routes/plan.mjs`:

```js
const PLAN_PERIOD_HEADINGS = new Set([
  "凌晨",
  "早上",
  "上午",
  "中午",
  "下午",
  "傍晚",
  "晚上",
  "夜间",
  "夜里",
]);

export function normalizePlanInput(rawText) {
  return String(rawText)
    .split(/\r?\n/)
    .filter((line) => !PLAN_PERIOD_HEADINGS.has(line.trim()))
    .join("\n");
}
```

Make `parsePlanItems` iterate over `normalizePlanInput(rawText)`. In both `matchesPlan` and `handlePlan`, create `const planText = normalizePlanInput(rawText)`, then use `planText` for date parsing, item parsing, save detection, query detection, and the persisted JSON payload:

```js
JSON.stringify({ date: planDate, rawText: planText, items })
```

Do not modify reminder, record, wake-up, or general-reminder modules.

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```powershell
node --test --test-name-pattern "filters standalone Plan period headings" plan/plugin/mashirobot-plugin-plan/tests/route-compatibility.test.mjs
```

Expected: PASS. The database stores no standalone headings and retains `下午复盘` as a plan-item title.

- [ ] **Step 5: Run the plan plugin regression suite**

Run:

```powershell
node --test plan/plugin/mashirobot-plugin-plan/tests/*.test.mjs
```

Expected: all JavaScript plan-plugin tests pass with zero failures.

- [ ] **Step 6: Run the core router regression suite**

Run:

```powershell
node --test plan/tests/*.test.mjs
```

Expected: all core JavaScript tests pass with zero failures.

- [ ] **Step 7: Verify the production route source is the active plugin path**

Run:

```powershell
rg -n "normalizePlanInput|PLAN_PERIOD_HEADINGS" plan/plugin/mashirobot-plugin-plan/routes/plan.mjs
rg -n "mashirobot-plugin-plan" plan/core plan/plugin/mashirobot-plugin-plan/plugin.json
```

Expected: normalization exists only in the plan plugin route, and the active plugin manifest/router still points to `mashirobot-plugin-plan`.

- [ ] **Step 8: Record the no-commit limitation**

Run:

```powershell
git -C plan rev-parse --show-toplevel
```

Expected: Git reports that the directory is not a repository. Do not run `git init`; hand off the changed files and test results directly.
