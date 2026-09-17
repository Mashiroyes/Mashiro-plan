# MashiroBot 财报与招股书课程插件 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 MashiroBot 中新增菜单编号 5 的零基础财报与招股书课程插件，每天 12:20 发送财报卡、每周二和周五 18:10 发送招股书卡，并使用 OpenClaw 聊天模式点评微信回答。

**Architecture:** 插件路由、课程读取、日期推进和 SQLite 状态均使用 Node.js 同步模块；Windows 计划任务运行复制到 `%LOCALAPPDATA%` 的版本化 worker，通过同一 SQLite 数据库幂等发送。课程正文预制并引用官方 PDF；点评通过 `openclaw agent` 发起独立聊天会话，禁止使用 Codex CLI、Paseo agent、工作模式或持久目标。

**Tech Stack:** Node.js 26 / ESM / `node:sqlite` / Node test runner，PowerShell 7，Windows Task Scheduler，OpenClaw 2026.7.1-2，现有 OpenClaw 微信通道。

## Global Constraints

- 插件目录固定为 `plan/plugin/mashirobot-plugin-financial-report`，插件 ID 同名，菜单编号固定为 `5`。
- 财报课程固定 30 天，每天 12:20；招股书课程固定 8 节，每周二、周五 18:10。
- 财报只使用伊利股份、美的集团、顺丰控股、腾讯控股的 2025 年官方完整年报。
- 招股书只使用农夫山泉、泡泡玛特、小米集团、京东物流的港交所中文招股书。
- 所有课程数字必须包含报告期、单位、PDF 页码和官方 URL。
- 自动发送失败只在当天每 15 分钟重试；跨天不补发，手动补学始终可用。
- 财报和招股书按日历推进，回答与否不阻塞下一课；暂停同时冻结两类自动
  课程，继续后从各自下一课恢复。
- `今日财报`、`今日招股书`、`重学今日财报` 和所有补学命令不得改变
  自动发送幂等记录。
- 第 30 天财报和第 8 节招股书完成后停止对应自动推送；招股书额外发送一次
  首期完成提示。
- 点评只使用 OpenClaw Gateway 的聊天式 agent turn；不得调用 Codex CLI、Paseo agent、工作模式、Codex goal 或工作区。
- 插件不得提供股票买卖建议、目标价或收益预测。
- 官方来源失效或身份校验失败时不得改用财经媒体或转载，必须阻止该课发送并
  记录来源异常。
- 正式状态只写入 `plan/sqlite/openclaw-planner.sqlite` 的 `financial_report_*` 表。
- 数据库迁移前必须 WAL checkpoint、完整性检查并创建可恢复备份。
- Windows 任务只引用复制到 `%LOCALAPPDATA%\MashiroBot\financial-report\runtime-v1` 的持久 runtime。
- PowerShell 必须使用无 BOM UTF-8 输出、PowerShell 7 绝对路径、`StartWhenAvailable`、`WakeToRun`、电池运行和 `MultipleInstances IgnoreNew`。
- 统一日志只记录插件 ID、事件、课程类型、课程序号和简短错误，不记录完整
  用户回答、聊天提示词或模型上下文。
- 当前 `plan` 目录不是 Git 仓库；每个任务以测试结果和变更文件清单作为检查点，不执行虚假的 Git 提交。

---

## File Map

### Plugin entry and commands

- Create `plan/plugin/mashirobot-plugin-financial-report/plugin.json`: manifest, menu index 5, exact help commands.
- Create `plan/plugin/mashirobot-plugin-financial-report/index.mjs`: four required synchronous exports.
- Create `plan/plugin/mashirobot-plugin-financial-report/core/parser.mjs`: pure command parser.
- Create `plan/plugin/mashirobot-plugin-financial-report/core/handler.mjs`: command-to-service orchestration.
- Create `plan/plugin/mashirobot-plugin-financial-report/help/help-data.mjs`: concise and detailed help content.

### Curriculum and state

- Create `plan/plugin/mashirobot-plugin-financial-report/curriculum/financial-reports.json`: 30 verified lesson records.
- Create `plan/plugin/mashirobot-plugin-financial-report/curriculum/prospectuses.json`: 8 verified lesson records.
- Create `plan/plugin/mashirobot-plugin-financial-report/curriculum/sources.json`: eight official source records and hashes.
- Create `plan/plugin/mashirobot-plugin-financial-report/core/curriculum.mjs`: strict loader/validator/formatter.
- Create `plan/plugin/mashirobot-plugin-financial-report/core/calendar.mjs`: Asia/Shanghai course-day calculation.
- Create `plan/plugin/mashirobot-plugin-financial-report/core/storage.mjs`: SQLite schema and transactional store.

### Background runtime

- Create `plan/plugin/mashirobot-plugin-financial-report/runtime/cli.mjs`: worker-facing JSON CLI.
- Create `plan/plugin/mashirobot-plugin-financial-report/runtime/chat-feedback.mjs`: OpenClaw chat invocation and output validation.
- Create `plan/plugin/mashirobot-plugin-financial-report/windows/common.ps1`: logging, paths and WeChat sending.
- Create `plan/plugin/mashirobot-plugin-financial-report/windows/delivery-worker.ps1`: finance/prospectus delivery worker.
- Create `plan/plugin/mashirobot-plugin-financial-report/windows/feedback-worker.ps1`: pending feedback worker.
- Create `plan/plugin/mashirobot-plugin-financial-report/windows/install-financial-report.ps1`: migration backup, runtime copy and three scheduled tasks.

### Tests and documentation

- Create focused `*.test.mjs` files under the plugin `tests` directory.
- Create `plan/plugin/mashirobot-plugin-financial-report/tests/test-windows-runtime.ps1`.
- Create `plan/plugin/mashirobot-plugin-financial-report/README.md`.
- Modify `plan/README.md`: add menu item 5 only.

---

### Task 1: Plugin shell, parser and help

**Files:**
- Create: `plan/plugin/mashirobot-plugin-financial-report/plugin.json`
- Create: `plan/plugin/mashirobot-plugin-financial-report/index.mjs`
- Create: `plan/plugin/mashirobot-plugin-financial-report/core/parser.mjs`
- Create: `plan/plugin/mashirobot-plugin-financial-report/help/help-data.mjs`
- Test: `plan/plugin/mashirobot-plugin-financial-report/tests/parser.test.mjs`
- Test: `plan/plugin/mashirobot-plugin-financial-report/tests/plugin-shell.test.mjs`

**Interfaces:**
- Produces: `parseLearningCommand(message): ParsedCommand | null`
- Produces: synchronous `match(message, context)`, `handle(message, context)`, `healthCheck()`, `getHelp()`
- `ParsedCommand.kind`: `help|status|today|catchup|answer|pause|resume|relearn`
- `ParsedCommand.courseType`: `financial_report|prospectus`

- [ ] **Step 1: Write parser tests for every agreed command**

```js
assert.deepEqual(parseLearningCommand("补学第7天"), {
  kind: "catchup", courseType: "financial_report", lessonNumber: 7,
});
assert.deepEqual(parseLearningCommand("招股书答案 第3课 渠道集中会增加风险"), {
  kind: "answer",
  courseType: "prospectus",
  lessonNumber: 3,
  answer: "渠道集中会增加风险",
});
assert.equal(parseLearningCommand("补学第31天").kind, "invalid");
assert.equal(parseLearningCommand("补学招股书第9课").kind, "invalid");
```

- [ ] **Step 2: Run the parser test and verify it fails because the module is missing**

Run: `node --test plan/plugin/mashirobot-plugin-financial-report/tests/parser.test.mjs`

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement an anchored, side-effect-free parser**

Use exact full-message patterns. Empty answers are invalid. `match()` may only call this parser and may not access SQLite, files or processes.

- [ ] **Step 4: Add manifest and plugin shell**

```json
{
  "schemaVersion": 1,
  "id": "mashirobot-plugin-financial-report",
  "name": "财报与招股书",
  "version": "1.0.0",
  "description": "零基础财报与招股书课程、进度和聊天点评",
  "menuIndex": 5,
  "priority": 220,
  "enabled": true,
  "entry": "index.mjs",
  "exactCommands": ["/财报课程", "/财报课程详细"]
}
```

- [ ] **Step 5: Add help groups containing all commands and the no-investment-advice boundary**

- [ ] **Step 6: Run parser, shell and system loader tests**

Run:

```powershell
node --test plan/plugin/mashirobot-plugin-financial-report/tests/parser.test.mjs plan/plugin/mashirobot-plugin-financial-report/tests/plugin-shell.test.mjs
node --test plan/tests/plugin-loader.test.mjs plan/tests/plugin-router.test.mjs plan/tests/help-service.test.mjs
```

Expected: all PASS; loaded plugin list includes menu index 5 without conflicts.

- [ ] **Step 7: Record checkpoint**

Record the six created files and test output; do not commit because the directory has no Git metadata.

### Task 2: Curriculum schema and strict validation

**Files:**
- Create: `plan/plugin/mashirobot-plugin-financial-report/core/curriculum.mjs`
- Create: `plan/plugin/mashirobot-plugin-financial-report/curriculum/financial-reports.json`
- Create: `plan/plugin/mashirobot-plugin-financial-report/curriculum/prospectuses.json`
- Create: `plan/plugin/mashirobot-plugin-financial-report/curriculum/sources.json`
- Test: `plan/plugin/mashirobot-plugin-financial-report/tests/curriculum.test.mjs`

**Interfaces:**
- Produces: `loadCurriculum(pluginRoot): { financialReports: Lesson[], prospectuses: Lesson[], sources: Source[] }`
- Produces: `getLesson(curriculum, courseType, lessonNumber): Lesson`
- Produces: `formatLessonCard(lesson): string`
- `Lesson` exact keys: `courseType, lessonNumber, company, title, objective, reading, facts, explanation, pitfall, question, referencePoints, sourceId, reportPeriod, pageNumbers, units, estimatedMinutes`

- [ ] **Step 1: Write schema tests before data**

Tests must assert exactly 30 unique financial-report lessons and 8 unique prospectus lessons; lesson numbers must be contiguous; each URL source must be HTTPS and on `cninfo.com.cn`, `hkexnews.hk` or a declared official investor-relations domain.

- [ ] **Step 2: Add minimum fixture records and verify strict failures**

Create one deliberately incomplete in-memory record in the test and assert the validator names the missing `pageNumbers`, `units`, `reportPeriod` and `referencePoints` fields.

- [ ] **Step 3: Implement strict loading and formatting**

```js
export function getLesson(curriculum, courseType, lessonNumber) {
  const list = courseType === "financial_report"
    ? curriculum.financialReports
    : curriculum.prospectuses;
  const lesson = list.find((item) => item.lessonNumber === lessonNumber);
  if (!lesson) throw new RangeError(`课程不存在: ${courseType} #${lessonNumber}`);
  return lesson;
}
```

The formatter must label sections `【财报事实】`, `【通俗解释】`, `【常见误区】`, `【今日问题】`, and `【官方原文】`.

- [ ] **Step 4: Run schema tests**

Run: `node --test plan/plugin/mashirobot-plugin-financial-report/tests/curriculum.test.mjs`

Expected: fixture tests PASS; production data count test remains failing until Task 3.

### Task 3: Curate and verify all 38 lessons

**Files:**
- Modify: `plan/plugin/mashirobot-plugin-financial-report/curriculum/financial-reports.json`
- Modify: `plan/plugin/mashirobot-plugin-financial-report/curriculum/prospectuses.json`
- Modify: `plan/plugin/mashirobot-plugin-financial-report/curriculum/sources.json`
- Create: `plan/plugin/mashirobot-plugin-financial-report/tests/source-ledger.test.mjs`

**Interfaces:**
- Consumes: Task 2 `Lesson` and `Source` schema.
- Produces: a complete immutable course pack whose facts can be traced to official PDFs.

- [ ] **Step 1: Resolve the eight official documents**

Use official disclosure search only:

- 2025 annual reports: 伊利股份、 美的集团、顺丰控股 from 巨潮/exchange disclosure; 腾讯控股 from HKEX or Tencent IR.
- Chinese prospectuses: 农夫山泉、泡泡玛特、小米集团、京东物流 from HKEXnews.

For each source record store `sourceId, company, documentTitle, reportPeriod, officialUrl, retrievedAt, sha256, localVerificationPath`. Verification PDFs go under `%TEMP%\MashiroBot\financial-report-source-check`, not the repository.

- [ ] **Step 2: Verify source identity before extracting facts**

For every PDF confirm company name, document type, report period and official host. Compute SHA-256 and reject HTML error pages or PDFs with zero extractable pages.

- [ ] **Step 3: Write the 30 financial-report lessons using the approved sequence**

Exact ranges:

- 1: annual-report map and three statements.
- 2–8: 伊利.
- 9–15: 美的.
- 16–22: 顺丰.
- 23–29: 腾讯.
- 30: four-company comparison.

Every `facts` item must contain `text, value, unit, period, pdfPage`; the explanation may simplify language but may not change the number or period.

- [ ] **Step 4: Write the eight prospectus lessons**

Exact mapping: 1–2 农夫山泉, 3–4 泡泡玛特, 5–6 小米集团, 7–8 京东物流. Odd lessons cover company/industry/model; even lessons cover financials/risks/fund use or the approved company-specific focus.

- [ ] **Step 5: Add source ledger verification tests**

The test must check source IDs, approved hosts, non-empty SHA-256, all referenced page numbers being positive integers, and at least two fact/page pairs per official document.

- [ ] **Step 6: Run all curriculum tests**

Run:

```powershell
node --test plan/plugin/mashirobot-plugin-financial-report/tests/curriculum.test.mjs plan/plugin/mashirobot-plugin-financial-report/tests/source-ledger.test.mjs
```

Expected: 30/8 counts, source ledger and traceability checks all PASS.

### Task 4: Course calendar engine

**Files:**
- Create: `plan/plugin/mashirobot-plugin-financial-report/core/calendar.mjs`
- Test: `plan/plugin/mashirobot-plugin-financial-report/tests/calendar.test.mjs`

**Interfaces:**
- Produces: `getFinancialReportSlot(state, now): CourseSlot`
- Produces: `getProspectusSlot(state, now): CourseSlot`
- Produces: `CourseSlot = { eligible, lessonNumber, localDate, scheduledTime, reason }`
- Time zone is always `Asia/Shanghai`.

- [ ] **Step 1: Write table-driven date tests**

Cover 12:19/12:20, 18:09/18:10, Monday/Tuesday/Friday/Saturday, first Tuesday after install, paused intervals, missed days, lesson 30 and prospectus lesson 8.

- [ ] **Step 2: Verify tests fail because calendar functions do not exist**

Run: `node --test plan/plugin/mashirobot-plugin-financial-report/tests/calendar.test.mjs`

- [ ] **Step 3: Implement calendar math with `Intl.DateTimeFormat`**

Do not derive Shanghai dates from the Windows locale. Financial lessons advance on each unpaused natural day. Prospectus lessons advance only on unpaused Tuesday/Friday slots.

- [ ] **Step 4: Run calendar tests**

Expected: all boundary cases PASS, including no previous-day delivery after midnight.

### Task 5: Transactional SQLite store and migration

**Files:**
- Create: `plan/plugin/mashirobot-plugin-financial-report/core/storage.mjs`
- Test: `plan/plugin/mashirobot-plugin-financial-report/tests/storage.test.mjs`

**Interfaces:**
- Produces: `createLearningStore(sqlitePath)`
- Store methods: `initialize, getCourseState, pauseCourses, resumeCourses, claimDelivery, finishDelivery, listProgress, saveAnswer, claimPendingFeedback, finishFeedback, failFeedback`

- [ ] **Step 1: Write tests against a temporary SQLite database**

Tests must prove table creation, course-type separation, unique delivery success, answer attempts not overwriting each other, pending feedback claims, rollback on error and preservation of a pre-existing `notes` table.

- [ ] **Step 2: Verify tests fail before implementation**

Run: `node --test plan/plugin/mashirobot-plugin-financial-report/tests/storage.test.mjs`

- [ ] **Step 3: Implement four prefixed tables and indexes**

Use:

```sql
financial_report_course_state
financial_report_deliveries
financial_report_answers
financial_report_feedback
```

All write races use `BEGIN IMMEDIATE`. A delivery claim key is
`(account_id, conversation_id, course_type, lesson_number, scheduled_date)`.

- [ ] **Step 4: Implement status transitions**

Delivery states: `pending|sending|sent|failed|missed`.
Feedback states: `pending|processing|ready|sent|failed`.
Claims older than ten minutes may be reclaimed after recording the previous worker as stale.

- [ ] **Step 5: Run storage tests and SQLite integrity check**

Expected: all PASS and `PRAGMA integrity_check` returns `ok`.

### Task 6: Synchronous plugin handler

**Files:**
- Create: `plan/plugin/mashirobot-plugin-financial-report/core/handler.mjs`
- Modify: `plan/plugin/mashirobot-plugin-financial-report/index.mjs`
- Test: `plan/plugin/mashirobot-plugin-financial-report/tests/handler.test.mjs`

**Interfaces:**
- Consumes parser, curriculum, calendar and store.
- Produces: `handleLearningCommand(command, context, dependencies): PluginResult`
- Produces standard `{ handled: true, command, reply, mediaPaths: [] }`.

- [ ] **Step 1: Write dependency-injected handler tests**

Cover status, today, both catch-up forms, pause/resume, explicit and implicit answer association, ambiguous association, repeated answer, and relearn. Assert that answer omission does not block the next calendar lesson; manual today/catch-up/relearn does not mutate automatic-delivery success rows; pause freezes both course types.

- [ ] **Step 2: Verify tests fail before handler exists**

- [ ] **Step 3: Implement command behavior without awaiting the model**

Saving an answer returns immediately:

```text
已收到第 N 天财报答案，正在使用聊天模式生成点评。
```

or:

```text
已收到第 N 课招股书答案，正在使用聊天模式生成点评。
```

Then invoke an injected `wakeFeedbackTask()`; wake failure must keep the answer pending and append a concise warning rather than lose the answer.

- [ ] **Step 4: Run handler and router tests**

Run:

```powershell
node --test plan/plugin/mashirobot-plugin-financial-report/tests/handler.test.mjs
node --test plan/tests/plugin-router.test.mjs plan/tests/help-service.test.mjs
```

Expected: all PASS and unmatched messages still fall through to GPT.

### Task 7: Worker JSON CLI and delivery pipeline

**Files:**
- Create: `plan/plugin/mashirobot-plugin-financial-report/runtime/cli.mjs`
- Create: `plan/plugin/mashirobot-plugin-financial-report/windows/common.ps1`
- Create: `plan/plugin/mashirobot-plugin-financial-report/windows/delivery-worker.ps1`
- Test: `plan/plugin/mashirobot-plugin-financial-report/tests/runtime-cli.test.mjs`
- Test: `plan/plugin/mashirobot-plugin-financial-report/tests/test-windows-runtime.ps1`

**Interfaces:**
- CLI commands: `init, prepare-delivery, finish-delivery, claim-feedback, finish-feedback, fail-feedback, progress`.
- JSON crosses Node/PowerShell only through stdout or Base64 UTF-8 payloads.

- [ ] **Step 1: Write CLI tests using a temporary database and fixed clock**

Assert `prepare-delivery --course-type financial_report` returns exactly one of
`send|already_sent|not_due|paused|complete|wrong_day`.

- [ ] **Step 2: Implement CLI with one JSON object on stdout**

Diagnostics go to stderr. Exit code is non-zero for malformed arguments or storage failure.

- [ ] **Step 3: Implement common PowerShell helpers**

Reuse exact OpenClaw account and target configuration from the existing reminder helper, call `openclaw.cmd message send --json`, and log UTF-8 JSON lines without full answer text.

- [ ] **Step 4: Implement delivery worker**

Parameters:

```powershell
param(
  [ValidateSet('financial_report','prospectus')][string]$CourseType,
  [string]$RuntimeRoot,
  [string]$SqlitePath,
  [switch]$DryRun
)
```

The worker claims, verifies the lesson source is healthy, sends, then marks sent. On failure it marks failed and exits non-zero so the next 15-minute trigger can retry. When financial lesson 30 or prospectus lesson 8 is sent, persist completion; prospectus lesson 8 also sends one idempotent first-batch completion notice.

- [ ] **Step 5: Run Node and PowerShell worker tests**

Dry-run tests must assert Chinese text survives, duplicate invocation does not resend, wrong weekday does not send, and no formal database is touched.

### Task 8: Chat-mode feedback pipeline

**Files:**
- Create: `plan/plugin/mashirobot-plugin-financial-report/runtime/chat-feedback.mjs`
- Create: `plan/plugin/mashirobot-plugin-financial-report/windows/feedback-worker.ps1`
- Test: `plan/plugin/mashirobot-plugin-financial-report/tests/chat-feedback.test.mjs`

**Interfaces:**
- Produces: `buildFeedbackPrompt({ lesson, answer }): string`
- Produces: `runChatFeedback({ openclawPath, sessionKey, promptFile, timeoutSeconds, spawnSyncImpl }): FeedbackResult`
- Session key prefix: `agent:main:financial-report-feedback:`.

- [ ] **Step 1: Write tests that forbid work-mode paths**

The captured child-process command must be `openclaw.cmd agent` with
`--session-key`, `--message-file`, `--json`, `--thinking low` and no
`codex`, `paseo`, `goal`, `workspace`, `worktree`, `--deliver` or work-mode flag.

- [ ] **Step 2: Write prompt and output validation tests**

The prompt must request 300–500 Chinese characters and the four required sections. Reject empty output, error JSON, stock recommendations and output over 1,500 characters.

- [ ] **Step 3: Implement chat invocation using a temporary UTF-8 prompt file**

Never pass Chinese prompt text on the CMD command line. Delete the temporary prompt file in `finally`. Do not log the prompt or full answer.

- [ ] **Step 4: Implement feedback worker**

Claim one pending answer, run the chat turn, persist the feedback, send it through WeChat, then mark sent. Use bounded retries with attempt count and next-attempt timestamp; no busy loop.

- [ ] **Step 5: Run tests**

Run: `node --test plan/plugin/mashirobot-plugin-financial-report/tests/chat-feedback.test.mjs`

Expected: chat command contract PASS and every prohibited work-mode token assertion PASS.

### Task 9: Safe installer and persistent scheduled runtime

**Files:**
- Create: `plan/plugin/mashirobot-plugin-financial-report/windows/install-financial-report.ps1`
- Test: `plan/plugin/mashirobot-plugin-financial-report/tests/test-installer.ps1`

**Interfaces:**
- Installer actions: `-Action Inspect|Install|Uninstall`.
- Task names:
  - `MashiroBot Financial Report Daily`
  - `MashiroBot Prospectus Tuesday Friday`
  - `MashiroBot Financial Report Feedback`

- [ ] **Step 1: Write static installer tests**

Assert exact task-name prefix, runtime destination boundary, PowerShell 7 absolute path, current-user limited principal, and no recursive deletion outside
`%LOCALAPPDATA%\MashiroBot\financial-report`.

- [ ] **Step 2: Implement Inspect mode**

Inspect reports current task XML, runtime hashes, SQLite integrity, OpenClaw/Gateway availability and prospective changes without writing.

- [ ] **Step 3: Implement pre-migration backup**

Run WAL checkpoint and integrity check; copy `.sqlite`, `-wal` and `-shm` when present into a timestamped `plan/sqlite/backups` set before `runtime cli init`.

- [ ] **Step 4: Copy a versioned runtime atomically**

Copy `runtime`, `core`, `curriculum` and `windows` required by workers into a staging directory, validate hashes, then rename staging to `runtime-v1`. Never run tasks from the synced workspace.

- [ ] **Step 5: Register three tasks**

- Daily trigger: 12:20, repetition every 15 minutes until 23:59.
- Weekly trigger: Tuesday and Friday 18:10, repetition every 15 minutes until 23:59.
- Feedback trigger: every 5 minutes, single instance, execution limit 10 minutes.

All tasks use `StartWhenAvailable`, `WakeToRun`, battery allowances, limited interactive user and `IgnoreNew`.

- [ ] **Step 6: Export and verify task XML**

Assert actual XML contains correct `StartBoundary`, days of week, repetition interval, executable absolute path, runtime-v1 path, principal and settings.

- [ ] **Step 7: Run installer tests with isolated task names and clean up**

Use a test suffix and temporary database. Verify LastTaskResult `0x0`, then remove only the exact test tasks and temporary runtime.

- [ ] **Step 8: Verify log privacy**

Inject a unique fake answer and prompt marker, run failure and success paths, then assert neither marker appears in `mashirobot.log`; the log must still contain plugin ID, course type, lesson number and event.

### Task 10: Documentation and system integration

**Files:**
- Create: `plan/plugin/mashirobot-plugin-financial-report/README.md`
- Modify: `plan/README.md`
- Test: `plan/tests/readme-boundary.test.mjs`

**Interfaces:**
- README is the authoritative command, schema, task and troubleshooting guide.

- [ ] **Step 1: Document all commands, schedules and content boundaries**

Include 12:20 daily, Tuesday/Friday 18:10, catch-up syntax, pause semantics, chat-mode restriction, task names, database tables and exact test commands.

- [ ] **Step 2: Add one root README plugin-index row**

Add menu index 5 and link to the plugin README. Do not copy internal schema or all commands into the root README.

- [ ] **Step 3: Run documentation and full system tests**

```powershell
node --test plan/tests/*.test.mjs
node --test plan/plugin/mashirobot-plugin-financial-report/tests/*.test.mjs
& pwsh -NoProfile -File plan/plugin/mashirobot-plugin-financial-report/tests/test-windows-runtime.ps1
& pwsh -NoProfile -File plan/plugin/mashirobot-plugin-financial-report/tests/test-installer.ps1
```

Expected: all PASS.

### Task 11: Install and perform real end-to-end verification

**Files:**
- Modify: formal SQLite database through the reviewed migration only.
- Create: persistent runtime under `%LOCALAPPDATA%\MashiroBot\financial-report\runtime-v1`.
- Create: three exact Windows scheduled tasks from Task 9.

**Interfaces:**
- Uses production OpenClaw WeChat account and target already configured in the existing reminder system.

- [ ] **Step 1: Run Inspect and review exact boundaries**

Confirm backup paths, runtime destination, task names, PowerShell path, Node path, OpenClaw path and formal SQLite path.

- [ ] **Step 2: Install and run health checks**

Verify plugin loader includes menu 5, runtime hashes match source, SQLite integrity is `ok`, and all three exported task XML definitions match the plan.

- [ ] **Step 3: Restart the OpenClaw gateway**

Use the existing safe gateway wrapper; verify the plugin loads without disabling any of the existing four plugins.

- [ ] **Step 4: Perform real WeChat command tests**

Send: `财报课程`, `今日财报`, `补学第1天`, `招股书课程`, `补学招股书第1课`, pause and resume. Verify one reply per command.

- [ ] **Step 5: Trigger one real financial-report and one real prospectus delivery**

Use installer-supported test-time triggers without changing the formal schedule. Confirm correct card, page numbers and official links arrive in WeChat.

- [ ] **Step 6: Prove delivery idempotency**

Run each delivery worker twice for the same account, conversation, course type, lesson and date. Confirm only one automatic WeChat card exists and the database has one sent delivery row.

- [ ] **Step 7: Prove same-day recovery**

Use an injected send failure in isolated mode, then restore sending on the same simulated date. Confirm a later attempt sends once. Confirm a next-day invocation does not send the missed card.

- [ ] **Step 8: Prove chat-mode feedback for both course types**

Submit one `财报答案……` and one `招股书答案……`. Confirm immediate acknowledgment, later 300–500-character feedback, saved answer/feedback rows, and captured command evidence showing `openclaw agent` with no prohibited work-mode path.

- [ ] **Step 9: Audit eight source documents**

For each official PDF, compare at least two course fact/page pairs with the rendered PDF page. Record pass/fail evidence without copying entire copyrighted reports.

- [ ] **Step 10: Final completion audit**

Map every specification section to a file, test output, task XML, SQLite query or real WeChat observation. Do not claim completion for any requirement supported only by file existence or a Ready task state.
