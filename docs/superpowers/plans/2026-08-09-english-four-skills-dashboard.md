# English Four-Skills Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn saved plan time into queryable and automatically delivered listening, speaking, reading, and writing charts.

**Architecture:** The plan parser supplies timed items; Python owns classification persistence, aggregation, delivery claims, and Pillow rendering. The JavaScript route handles chat commands. One Windows scheduled worker performs due-period selection and Weixin media delivery through an immutable installed runtime.

**Tech Stack:** Node.js ESM, Python 3.14, SQLite, Pillow, PowerShell 7, Windows Task Scheduler, OpenClaw CLI.

## Global Constraints

- The chart includes exactly four skill shares and four skill trend panels; Anki appears only in the textual/footer imbalance context.
- Plan revisions never double-count superseded items.
- All report periods use Asia/Shanghai calendar boundaries.
- The daily worker runs at 11:00 and all sends are idempotent.
- Existing plugin behavior and SQLite data remain compatible.

---

### Task 1: Classification and SQLite aggregation

**Files:**
- Create: `plugin/mashirobot-plugin-plan/planner/english_skills.py`
- Create: `plugin/mashirobot-plugin-plan/config/english-skill-keywords.json`
- Modify: `plugin/mashirobot-plugin-plan/planner/database.py`
- Modify: `plugin/mashirobot-plugin-plan/planner/planner.py`
- Test: `plugin/mashirobot-plugin-plan/tests/test_english_skills.py`

**Interfaces:**
- Produces `classify_title(title)`, `duration_minutes(start, end)`, `query_english_skills(from_date, to_date, granularity)`, and delivery claim/finalize methods.
- Daily-record book titles are normalized into `learned_english_reading_titles` and trigger reconciliation of existing plan items.
- `query-english-skills` emits totals, percentages, points, Anki minutes, and optional warning.

- [ ] Write tests for every keyword family, learned daily-record book titles, precedence, mixed case, cross-midnight ranges, revision replacement, aggregation, zero state, and imbalance warning.
- [ ] Run `python -m unittest plugin/mashirobot-plugin-plan/tests/test_english_skills.py -v` and confirm the new tests fail.
- [ ] Add configuration loading and pure classification/duration functions.
- [ ] Add the skill-entry and delivery tables and synchronize entries inside `save_plan`.
- [ ] Add range aggregation and delivery claim/finalize CLI commands.
- [ ] Re-run the focused tests and commit the independently working data layer.

### Task 2: Manual command route and Python chart

**Files:**
- Create: `plugin/mashirobot-plugin-plan/routes/english-skills.mjs`
- Create: `plugin/mashirobot-plugin-plan/planner/english_skills_chart.py`
- Modify: `plugin/mashirobot-plugin-plan/routes/index.mjs`
- Modify: `plugin/mashirobot-plugin-plan/bridge/planner-runner.mjs`
- Modify: `plugin/mashirobot-plugin-plan/planner/planner.py`
- Modify: `plugin/mashirobot-plugin-plan/help/help-data.mjs`
- Test: `plugin/mashirobot-plugin-plan/tests/english-skills-route.test.mjs`
- Test: `plugin/mashirobot-plugin-plan/tests/test_english_skills_chart.py`

**Interfaces:**
- Consumes the Task 1 `query-english-skills` payload.
- Produces `parseEnglishSkillsQuery(text, now)` and `generateEnglishSkillsChart(payload)`.

- [ ] Write route tests for all six requested phrases and exact period boundaries.
- [ ] Write chart tests for a non-empty and zero-state payload.
- [ ] Run both focused suites and confirm failure.
- [ ] Implement period parsing, textual summary, media path generation, and graceful chart fallback.
- [ ] Implement the Pillow pie, legend, four line panels, and warning footer.
- [ ] Update help data, run focused tests, then run existing plan-plugin tests.

### Task 3: Automatic report worker and installation

**Files:**
- Create: `plugin/mashirobot-plugin-plan/windows/english-skills-worker.ps1`
- Create: `plugin/mashirobot-plugin-plan/windows/install-english-skills.ps1`
- Create: `plugin/mashirobot-plugin-plan/windows/run-hidden-worker.vbs`
- Modify: `plugin/mashirobot-plugin-plan/README.md`
- Modify: `plugin/mashirobot-plugin-plan/plugin.json`
- Test: `plugin/mashirobot-plugin-plan/tests/test_english_skills_windows.ps1`

**Interfaces:**
- Consumes Task 1 delivery claims and Task 2 chart CLI.
- Produces one verified Task Scheduler entry and Weixin sends containing text plus `--media`.

- [ ] Write tests for Monday, month-first, year-first, coincident periods, claim idempotency, failed retry, and dry-run media delivery.
- [ ] Run the PowerShell test and confirm failure.
- [ ] Implement due-period calculation, claim/render/send/finalize flow, structured logs, and dry-run output.
- [ ] Implement inspect/install/uninstall with backup, immutable runtime copy, hidden launcher, and one daily 11:00 task.
- [ ] Run the Windows tests, install the runtime, inspect the registered task, and execute a dry-run worker.

### Task 4: Full regression and live verification

**Files:**
- Modify only files implicated by failures.

**Interfaces:**
- Consumes all earlier deliverables and proves end-to-end behavior.

- [ ] Run every Python, Node, and PowerShell suite under `mashirobot-plugin-plan`.
- [ ] Back up and integrity-check the live SQLite database before installation.
- [ ] Save an isolated dated fixture plan, query week/month/year charts, and inspect each produced PNG.
- [ ] Verify the installed task is Ready, points only to `runtime-v1`, runs at 11:00, and a dry-run reports the correct previous periods.
- [ ] Reload the MashiroBot/OpenClaw plugin adapter and confirm the route is active without GPT fallback.
