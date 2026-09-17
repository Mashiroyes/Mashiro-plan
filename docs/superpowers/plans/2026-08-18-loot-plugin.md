# 「战利品」插件替换旧笔记功能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完整删除旧笔记和喝水/英语日志固定习惯入口，新增通过微信记录当天最后一次「爽点」、21:00 至 22:00 催促并在次日 10:00 回放的独立「战利品」插件。

**Architecture:** `mashirobot-plugin-loot` 以同步插件接口处理微信输入，使用 `node:sqlite` 按上海日期 upsert 每天唯一记录。PowerShell worker 调用无副作用的 Node CLI 决定是否发送，再复用现有 OpenClaw 微信通道；安装器复制版本化运行副本并注册两个稳定 Windows 任务。

**Tech Stack:** Node.js ESM、`node:sqlite`、Node test runner、PowerShell 7、Windows Task Scheduler、OpenClaw Weixin、SQLite。

## Global Constraints

- 插件显示名称固定为「战利品」，插件 ID 固定为 `mashirobot-plugin-loot`，菜单编号固定为 `4`。
- 唯一业务关键词是首行精确匹配的 `爽点`；正文自由多行，同一天最后一次有效发送整体覆盖前一次。
- 日期统一使用 `Asia/Shanghai`；晚间仅在 21:00 至 22:00 每 10 分钟检查，22:00 后停止。
- 次日 10:00 仅在前一天有记录时发送固定前缀、日期和原始正文；不改写、不评分、不总结。
- 旧 `notes` 表中的 2 条数据不迁移、不导出、不创建删除前备份。
- 删除 `OpenClaw-Daily-Water-1000` 与 `OpenClaw-Daily-EnglishJournal-2100`，不影响其他计划任务。
- 当前工作区没有可用 Git 元数据；不得初始化新仓库。计划中的提交步骤仅在 Git 恢复后执行，否则记录为跳过。

---

## File Structure

新插件文件职责：

- `plugin/mashirobot-plugin-loot/core/parser.mjs`：纯解析 `爽点` 首行和自由正文。
- `plugin/mashirobot-plugin-loot/core/store.mjs`：初始化 `loot_entries`、按上海日期 upsert 和查询。
- `plugin/mashirobot-plugin-loot/core/messages.mjs`：生成晚间提醒与次日固定回放文本。
- `plugin/mashirobot-plugin-loot/core/worker-cli.mjs`：供定时 worker 查询动作，输出单个 JSON 对象。
- `plugin/mashirobot-plugin-loot/index.mjs`：同步插件契约、帮助和健康检查。
- `plugin/mashirobot-plugin-loot/windows/loot-worker.ps1`：调用 Node CLI、发送微信并记录日志。
- `plugin/mashirobot-plugin-loot/windows/install.ps1`：复制稳定运行副本、迁移数据库并注册/检查任务。
- `plugin/mashirobot-plugin-loot/tests/*.test.mjs`：解析、存储、入口、消息和 CLI 单元测试。
- `plugin/mashirobot-plugin-loot/tests/test-windows.ps1`：worker DryRun 与任务 XML 边界测试。

现有文件修改职责：

- `plugin/mashirobot-plugin-plan/help/help-data.mjs`：移除喝水和英语日志帮助文字。
- `plugin/mashirobot-plugin-plan/routes/routine.mjs`：移除 `已喝水`、`已写日志` 路由。
- `plugin/mashirobot-plugin-plan/windows/routine-reminder.ps1`：移除固定习惯安装和发送动作。
- `plugin/mashirobot-plugin-plan/tests/route-compatibility.test.mjs`：断言旧关键词不再匹配。
- `plugin/mashirobot-plugin-plan/README.md`：删除旧固定习惯说明。
- `core/health/check-mashirobot.ps1`：以「战利品」替换笔记清单和健康检查。
- `README.md`、`tests/readme-boundary.test.mjs`：更新菜单 4 和系统文档边界。

---

### Task 1: 自由正文解析与每日覆盖存储

**Files:**
- Create: `plugin/mashirobot-plugin-loot/core/parser.mjs`
- Create: `plugin/mashirobot-plugin-loot/core/store.mjs`
- Create: `plugin/mashirobot-plugin-loot/tests/parser.test.mjs`
- Create: `plugin/mashirobot-plugin-loot/tests/store.test.mjs`

**Interfaces:**
- Produces: `parseLootCommand(message) -> null | { kind: "help", detailed } | { kind: "invalid", error } | { kind: "save", content }`
- Produces: `createLootStore(sqlitePath)` with `initialize()`, `save(entryDate, content, now)`, `get(entryDate)`, and `dropLegacyNotes()`.

- [ ] **Step 1: Write parser tests for exact first-line matching and free multiline content**

```js
assert.deepEqual(parseLootCommand("爽点\n读完一章\n解决了配置问题"), {
  kind: "save",
  content: "读完一章\n解决了配置问题",
});
assert.equal(parseLootCommand("今天的爽点\n读完一章"), null);
assert.match(parseLootCommand("爽点").error, /内容/);
assert.deepEqual(parseLootCommand("/战利品"), { kind: "help", detailed: false });
```

- [ ] **Step 2: Run parser tests and verify the missing module failure**

Run: `node --test plugin/mashirobot-plugin-loot/tests/parser.test.mjs`

Expected: FAIL because `core/parser.mjs` does not exist.

- [ ] **Step 3: Implement `parseLootCommand` as a side-effect-free parser**

Implementation rules: normalize CRLF to LF, trim the complete message, require the first line to equal `爽点`, trim only the outer whitespace of the remaining body, preserve internal line breaks, and recognize `/战利品` plus `/战利品详细`.

- [ ] **Step 4: Write store tests for schema, same-day overwrite, cross-day isolation, and legacy drop**

```js
const store = createLootStore(sqlitePath);
store.initialize();
store.save("2026-08-18", "第一次", new Date("2026-08-18T13:01:00Z"));
store.save("2026-08-18", "第二次\n完整内容", new Date("2026-08-18T13:05:00Z"));
store.save("2026-08-19", "另一天", new Date("2026-08-19T13:01:00Z"));
assert.equal(store.get("2026-08-18").content, "第二次\n完整内容");
assert.equal(store.get("2026-08-19").content, "另一天");
```

The fixture must create a `notes` table with two rows, call `dropLegacyNotes()`, and assert `sqlite_master` no longer contains `notes`, `idx_notes_active_id`, or `idx_notes_active_label`.

- [ ] **Step 5: Implement the SQLite store**

Use `DatabaseSync`, `PRAGMA busy_timeout=5000`, `CREATE TABLE IF NOT EXISTS loot_entries`, and this upsert:

```sql
INSERT INTO loot_entries(entry_date, content, created_at, updated_at)
VALUES(?, ?, ?, ?)
ON CONFLICT(entry_date) DO UPDATE SET
  content=excluded.content,
  updated_at=excluded.updated_at;
```

`dropLegacyNotes()` must execute `DROP TABLE IF EXISTS notes` without exporting rows or creating a database copy.

- [ ] **Step 6: Run Task 1 tests**

Run: `node --test plugin/mashirobot-plugin-loot/tests/parser.test.mjs plugin/mashirobot-plugin-loot/tests/store.test.mjs`

Expected: all tests PASS and temporary databases are removed by test cleanup.

- [ ] **Step 7: Commit when Git metadata is available**

```powershell
git add plan/plugin/mashirobot-plugin-loot/core plan/plugin/mashirobot-plugin-loot/tests
git commit -m "feat: add daily loot storage"
```

If `git rev-parse --show-toplevel` fails, record this step as skipped and do not initialize a repository.

### Task 2: 标准插件入口、帮助和次日文案

**Files:**
- Create: `plugin/mashirobot-plugin-loot/plugin.json`
- Create: `plugin/mashirobot-plugin-loot/index.mjs`
- Create: `plugin/mashirobot-plugin-loot/core/messages.mjs`
- Create: `plugin/mashirobot-plugin-loot/README.md`
- Create: `plugin/mashirobot-plugin-loot/tests/plugin.test.mjs`
- Create: `plugin/mashirobot-plugin-loot/tests/messages.test.mjs`

**Interfaces:**
- Consumes: `parseLootCommand`, `createLootStore` from Task 1.
- Produces: synchronous `match`, `handle`, `healthCheck`, `getHelp` exports.
- Produces: `buildReplayMessage(entryDate, content)` and `buildEveningReminder()`.

- [ ] **Step 1: Write plugin tests for contract, help, invalid input, save, and overwrite**

The test context uses a temporary SQLite path and `now: new Date("2026-08-18T13:30:00Z")`. Assert `match("爽点\n第一版")` is true, `match("闲聊")` is false, `handle` replies with a short saved confirmation, and a second message replaces the first row for `2026-08-18`.

- [ ] **Step 2: Write exact replay-message tests**

```js
assert.equal(
  buildReplayMessage("2026-08-18", "读完一章\n听懂一段"),
  "与其整天沉醉于别人的故事，不如自己安心多学一些，也留下点自己的故事。\n\n" +
    "2026年8月18日的爽点：\n读完一章\n听懂一段",
);
```

- [ ] **Step 3: Run tests and verify they fail before implementation**

Run: `node --test plugin/mashirobot-plugin-loot/tests/plugin.test.mjs plugin/mashirobot-plugin-loot/tests/messages.test.mjs`

Expected: FAIL because the manifest, entry, and messages module do not exist.

- [ ] **Step 4: Implement the manifest and synchronous plugin exports**

`plugin.json` must declare schema version `1`, ID `mashirobot-plugin-loot`, name `战利品`, menu index `4`, enabled `true`, entry `index.mjs`, and exact commands `[/战利品, /战利品详细]`.

`handle` derives the Shanghai date from `context.now`, saves valid content, routes exact help commands through `context.renderPluginHelp`, and returns `{ handled: true, command, reply, mediaPaths: [] }`.

- [ ] **Step 5: Implement help and README without fixed task categories**

Help must show only this shape:

```text
爽点
今天真实完成的内容，可以自由换行。
```

It must state that the last valid message of the day wins, reminders run from 21:00 through 22:00, and yesterday is replayed at 10:00.

- [ ] **Step 6: Run Task 2 tests**

Run: `node --test plugin/mashirobot-plugin-loot/tests/*.test.mjs`

Expected: all new plugin tests PASS. Defer plugin-root loader tests until Task 5 removes the old menu-4 plugin and resolves the intentional temporary conflict.

- [ ] **Step 7: Commit when Git metadata is available**

```powershell
git add plan/plugin/mashirobot-plugin-loot
git commit -m "feat: add loot plugin interface"
```

### Task 3: 晚间检查、次日回放和稳定计划任务

**Files:**
- Create: `plugin/mashirobot-plugin-loot/core/worker-cli.mjs`
- Create: `plugin/mashirobot-plugin-loot/windows/loot-worker.ps1`
- Create: `plugin/mashirobot-plugin-loot/windows/install.ps1`
- Create: `plugin/mashirobot-plugin-loot/tests/worker-cli.test.mjs`
- Create: `plugin/mashirobot-plugin-loot/tests/test-windows.ps1`

**Interfaces:**
- Consumes: `createLootStore`, `buildEveningReminder`, `buildReplayMessage`.
- Produces CLI JSON: `{ ok, action: "skip"|"send", reason, message, entryDate }`.
- Produces installer actions: `Install`, `Inspect`, `Uninstall`.

- [ ] **Step 1: Write worker CLI tests using `--now`, `--action evening|morning`, and a temporary database**

Cover 20:59 skip, 21:00 send, 21:37 send, 22:00 send, 22:01 skip, same-day recorded skip, morning previous-day send, and morning missing-record skip. Assert the morning message exactly matches Task 2.

- [ ] **Step 2: Run worker tests and verify failure before implementation**

Run: `node --test plugin/mashirobot-plugin-loot/tests/worker-cli.test.mjs`

Expected: FAIL because `core/worker-cli.mjs` does not exist.

- [ ] **Step 3: Implement worker CLI with deterministic Shanghai-date calculations**

The CLI accepts `--sqlite`, `--action`, and optional `--now`. Evening sends only when local time is within `[21:00, 22:00]` and today's row is absent. Morning always queries `localDate - 1 day`; task scheduling determines the 10:00 invocation.

- [ ] **Step 4: Write PowerShell DryRun tests**

The test invokes `loot-worker.ps1 -Action Evening -Now 2026-08-18T21:00:00+08:00 -DryRun` against a temporary database and asserts returned JSON contains `action=send` without calling OpenClaw. It then stores a row and asserts `action=skip`.

- [ ] **Step 5: Implement PowerShell delivery worker**

Use the stable runtime plugin root, call `node core/worker-cli.mjs`, parse JSON, and only call:

```powershell
& 'D:\Program\nodejs\npm_global24\openclaw.ps1' message send --json `
  --channel 'openclaw-weixin' --account 'ea8fd13b2100-im-bot' `
  --target 'o9cq803sh0NGK6VgYAiBKUYMnDiA@im.wechat' --message $decision.message
```

Write UTF-8 JSON-line logs under `%USERPROFILE%\.openclaw\logs\mashirobot.log` with plugin ID, action, date, outcome, and error.

- [ ] **Step 6: Implement installer and exact task XML**

`Install` copies the complete plugin to `%LOCALAPPDATA%\MashiroBot\loot\runtime-v1\plugin`, initializes `loot_entries`, drops legacy `notes`, unregisters both old habit tasks, and registers:

- `MashiroBot Loot Evening`: seven daily triggers at 21:00, 21:10, 21:20, 21:30, 21:40, 21:50, 22:00.
- `MashiroBot Loot Morning`: one daily trigger at 10:00.

Both tasks use the full PowerShell 7 path, `StartWhenAvailable=true`, `WakeToRun=true`, and runtime-v1 paths. `Inspect` returns JSON with task existence, trigger boundaries, action path, and runtime path. `Uninstall` removes only these two tasks and the loot runtime directory.

- [ ] **Step 7: Run Task 3 tests**

Run: `node --test plugin/mashirobot-plugin-loot/tests/worker-cli.test.mjs`

Run: `pwsh -NoProfile -File plugin/mashirobot-plugin-loot/tests/test-windows.ps1`

Expected: all tests PASS, DryRun sends no微信 message, and temporary tasks/databases are cleaned.

- [ ] **Step 8: Commit when Git metadata is available**

```powershell
git add plan/plugin/mashirobot-plugin-loot
git commit -m "feat: schedule loot reminders"
```

### Task 4: 下线计划插件的喝水和英语日志旧习惯

**Files:**
- Modify: `plugin/mashirobot-plugin-plan/help/help-data.mjs`
- Modify: `plugin/mashirobot-plugin-plan/routes/routine.mjs`
- Modify: `plugin/mashirobot-plugin-plan/windows/routine-reminder.ps1`
- Modify: `plugin/mashirobot-plugin-plan/tests/route-compatibility.test.mjs`
- Modify: `plugin/mashirobot-plugin-plan/README.md`
- Modify: `tests/task-paths.test.ps1`
- Delete: `tests/fixtures/task-paths/OpenClaw-Daily-Water-1000.xml`

**Interfaces:**
- Preserves all plan, sleep, wakeup, general reminder, shower, night, disk, and English skill statistics interfaces.
- Removes exact local matches `已喝水`, `已写日志` and PowerShell actions `InstallFixed`, `SendHabit`.

- [ ] **Step 1: Change regression tests to require the old keywords to be unmatched**

```js
for (const message of ["已喝水", "已写日志"]) {
  assert.equal(match(message, fixture.context), false, message);
}
for (const message of ["没打卡", "已打卡", "已睡觉", "已起床"]) {
  assert.equal(match(message, fixture.context), true, message);
}
```

Add assertions that `JSON.stringify(getHelp())` does not contain `喝水`, `英语日志`, `已喝水`, or `已写日志`.

- [ ] **Step 2: Run focused plan tests and verify failure**

Run: `node --test plugin/mashirobot-plugin-plan/tests/route-compatibility.test.mjs`

Expected: FAIL because old routes and help text still exist.

- [ ] **Step 3: Remove old routes and fixed-habit PowerShell actions**

Remove the two keywords and habit branch from `routes/routine.mjs`. Remove `Habit`, `InstallFixed`, `SendHabit`, their functions, and switch cases from `routine-reminder.ps1`; preserve all unrelated actions byte-for-byte where practical.

- [ ] **Step 4: Remove all old habit wording from help and plan README**

Rename the help group to `睡觉、打卡和起床`; remove only the two habit items; change fixed-reminder wording to retain `洗澡、夜间催促和磁盘空间提醒`. Delete fixed habit commands, task rows, troubleshooting references, and active `habit_events` usage descriptions from the README while leaving the historical table itself untouched.

- [ ] **Step 5: Remove obsolete water fixture and update task-path tests**

Delete the fixed-water XML case so the rewrite regression only covers still-supported `OpenClaw-Plan-*` tasks.

- [ ] **Step 6: Run plan and task-path regressions**

Run: `node --test plugin/mashirobot-plugin-plan/tests/route-compatibility.test.mjs`

Run: `pwsh -NoProfile -File tests/task-paths.test.ps1`

Expected: PASS; old keywords do not match locally and unrelated plan behavior remains green.

- [ ] **Step 7: Commit when Git metadata is available**

```powershell
git add plan/plugin/mashirobot-plugin-plan plan/tests
git commit -m "refactor: remove legacy habit reminders"
```

### Task 5: 删除旧笔记并接入菜单、健康检查和文档

**Files:**
- Delete: `plugin/mashirobot-plugin-note/**`
- Modify: `core/health/check-mashirobot.ps1`
- Modify: `README.md`
- Modify: `tests/readme-boundary.test.mjs`
- Delete: `docs/superpowers/specs/2026-08-09-note-plugin-and-block-merge-design.md`
- Delete: `docs/superpowers/specs/2026-08-09-note-reusable-labels-design.md`
- Delete: `docs/superpowers/plans/2026-08-09-note-plugin-and-block-merge.md`
- Delete: `docs/superpowers/plans/2026-08-09-note-reusable-labels.md`
- Modify: `docs/superpowers/specs/2026-08-09-financial-report-learning-plugin-design.md`
- Delete: `sqlite/backups/openclaw-planner-pre-note-20260809-124659.sqlite`
- Delete: `sqlite/backups/openclaw-planner-pre-note-labels-20260809-130713.sqlite`

**Interfaces:**
- Replaces health/menu ID `mashirobot-plugin-note` with `mashirobot-plugin-loot` at menu index 4.
- Leaves menu indices 1, 2, 3, and 5 unchanged.

- [ ] **Step 1: Update system tests to require menu 4「战利品」 and forbid old note commands**

Add README and loader assertions for `plugin\mashirobot-plugin-loot`, menu index 4, and absence of `mashirobot-plugin-note`, `添加笔记`, `查询笔记`, `删除笔记` from active README/help/health sources.

- [ ] **Step 2: Run system tests and verify failure before cleanup**

Run: `node --test tests/plugin-loader.test.mjs tests/plugin-router.test.mjs tests/help-service.test.mjs tests/readme-boundary.test.mjs`

Expected: FAIL because old note plugin and menu references still exist.

- [ ] **Step 3: Update health checks and root README**

Rename `$NoteManifest*` variables and check name to loot equivalents, require `mashirobot-plugin-loot` in loaded/health output, and render menu 4 as `战利品` with a concise description. Replace the root README menu row and link with the new plugin README.

- [ ] **Step 4: Delete the old plugin and note-specific historical documents**

Delete every tracked source file under `plugin/mashirobot-plugin-note` and the four note-specific design/plan documents listed above. Remove the incidental note-plugin sentence from the financial-report design without changing its financial requirements.

- [ ] **Step 5: Delete the two exact note-specific SQLite backup files**

Before deletion, verify both resolved paths are under `plan\sqlite\backups` and exactly match the names listed in this task. Remove only those two files; do not recursively delete `sqlite/backups` or any general snapshot.

- [ ] **Step 6: Run active-source residue checks**

Run:

```powershell
rg -n "mashirobot-plugin-note|添加笔记|查询笔记|删除笔记" README.md core plugin tests
```

Expected: no matches.

Run:

```powershell
Test-Path plugin\mashirobot-plugin-note
Get-ChildItem sqlite\backups -File -Recurse | Where-Object Name -Like 'openclaw-planner-pre-note*'
```

Expected: `False` and no files.

- [ ] **Step 7: Run system regression tests**

Run: `node --test tests/*.test.mjs plugin/mashirobot-plugin-loot/tests/*.test.mjs`

Expected: all tests PASS; plugin loader reports menu 4 as `mashirobot-plugin-loot` with no conflicts.

- [ ] **Step 8: Commit when Git metadata is available**

```powershell
git add -A plan
git commit -m "refactor: replace notes with loot plugin"
```

### Task 6: 正式迁移、计划任务安装和端到端验收

**Files:**
- Modify at runtime: `sqlite/openclaw-planner.sqlite`
- Modify external state: Windows Task Scheduler
- Create/update external runtime: `%LOCALAPPDATA%\MashiroBot\loot\runtime-v1`
- Verify: `%USERPROFILE%\.openclaw\logs\mashirobot.log`

**Interfaces:**
- Consumes installer `Install` and `Inspect` from Task 3.
- Produces the live plugin database table, runtime copy, two scheduled tasks, and gateway-loaded route.

- [ ] **Step 1: Inspect exact destructive targets before mutation**

Confirm the formal database path, `notes` row count equals the observed value `2`, both old habit task names, old plugin directory, and two note-specific backup paths. Abort if any deletion target resolves outside the named paths.

- [ ] **Step 2: Run the installer without creating a backup**

Run:

```powershell
pwsh -NoProfile -File plugin\mashirobot-plugin-loot\windows\install.ps1 -Action Install -SqlitePath sqlite\openclaw-planner.sqlite
```

Expected: JSON reports `loot_entries` initialized, `notes` dropped, old habit tasks absent, runtime-v1 populated, and both loot tasks ready.

- [ ] **Step 3: Verify formal database state**

Use a read-only `node:sqlite` check to assert `loot_entries` exists, `notes` does not exist, and `PRAGMA integrity_check` returns `ok`.

- [ ] **Step 4: Inspect exact scheduled triggers and unaffected tasks**

Run installer `-Action Inspect`. Assert evening triggers are exactly 21:00 through 22:00 at 10-minute increments, morning is exactly 10:00, task actions point to runtime-v1, both old habit tasks are absent, and the pre-existing unrelated task-name snapshot remains unchanged.

- [ ] **Step 5: Run full automated verification**

Run:

```powershell
node --test tests/*.test.mjs plugin/mashirobot-plugin-plan/tests/*.test.mjs plugin/mashirobot-plugin-loot/tests/*.test.mjs
pwsh -NoProfile -File plugin\mashirobot-plugin-loot\tests\test-windows.ps1
pwsh -NoProfile -File core\health\check-mashirobot.ps1
```

Also run the plan plugin Python suite and existing PowerShell static tests documented in `plugin/mashirobot-plugin-plan/README.md`. Expected: all pass without modifying user data beyond the approved migration.

- [ ] **Step 6: Render and inspect updated help images**

Generate `/计划`, `/计划详细`, main menu, `/战利品`, and `/战利品详细` help artifacts through the core help service. Inspect images to confirm no clipping and no visible `喝水`, `英语日志`, `已喝水`, `已写日志`, or old笔记 wording.

- [ ] **Step 7: Restart the gateway and verify live plugin discovery**

Restart through the existing `OpenClaw Gateway` task or approved gateway wrapper. Require a fresh log entry showing `mashirobot-plugin-loot` loaded, no `mashirobot-plugin-note`, no plugin failures, and a connected Weixin channel.

- [ ] **Step 8: Perform an actual route and delivery acceptance check**

Through the real plugin entry, send a temporary `爽点` value twice on the same date and confirm the second value is the only row. Run evening and morning workers with controlled `-Now` values; permit one actual test WeChat message for morning replay, verify the fixed prefix and original multiline content, then replace the temporary record with the user's intended content or remove only the identified test row.

- [ ] **Step 9: Final residue and requirement audit**

Verify every acceptance item in `docs/superpowers/specs/2026-08-18-loot-plugin-design.md`: source absence, database schema, task boundaries, help images, same-day overwrite, no-record silence, fixed morning prefix, runtime paths, logs, and unaffected task state. Do not claim completion from tests alone.

- [ ] **Step 10: Commit when Git metadata is available**

```powershell
git add -A plan
git commit -m "chore: install and verify loot plugin"
```

If Git remains unavailable, preserve the verified files and report that no commit was possible; do not initialize `.git`.
