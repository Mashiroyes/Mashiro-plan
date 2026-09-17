# 指定日期睡觉时间 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 支持按明确作息日期新增、修改和删除睡觉时间，同时保留现有 `已睡觉` 的 06:00 自动归属规则。

**Architecture:** `routes/sleep.mjs` 新增纯解析和指令处理，日期由 `resolveMessageDate` 解析。Python 数据层根据明确的 `routine_date` 与 `HH:mm` 计算带 `+08:00` 的实际时刻；凌晨时刻落到次日。所有写入继续使用既有 `sleep_events` 表，统计读取逻辑不变。

**Tech Stack:** Node.js ESM、Python 3.14、SQLite、`node --test`、`unittest`。

## Global Constraints

- 指令中的日期始终是 `routine_date`，不是 `slept_at` 的日历日期。
- `00:00` 至 `05:59` 的明确时间映射为次日的实际入睡时刻；`06:00` 至 `23:59` 映射为当天。
- `已睡觉` 和 `record-sleep` 的既有 06:00 自动归属逻辑不得改变。
- 不修改 `sleep_events` 表结构；结构迁移前不重建、不清空正式数据库。
- `plan` 目录不是 Git 仓库；不要执行提交命令。

---

### Task 1: 添加显式日期睡觉记录的数据库接口

**Files:**
- Modify: `plugin/mashirobot-plugin-plan/planner/database.py:38-46,461-466`
- Modify: `plugin/mashirobot-plugin-plan/planner/planner.py:25-55`
- Test: `plugin/mashirobot-plugin-plan/tests/test_planner.py:83-113`

**Interfaces:**
- Consumes: `routine_date: str` (`YYYY-MM-DD`) 和 `clock: str` (`H:mm` 或 `HH:mm`)。
- Produces: `PlannerDatabase.save_explicit_sleep(routine_date, clock, require_existing=False) -> dict[str, Any]`，返回 `action`、`routineDate`、`sleptAt`、`replaced`。
- Produces: CLI 命令 `save-explicit-sleep --date YYYY-MM-DD --clock HH:mm [--require-existing]`。

- [ ] **Step 1: 写入失败测试，覆盖凌晨跨日和晚间当日映射**

```python
saved = self.cli("save-explicit-sleep", "--date", "2026-08-03", "--clock", "2:04")
self.assertEqual(saved["routineDate"], "2026-08-03")
self.assertEqual(saved["sleptAt"], "2026-08-04T02:04:00+08:00")

late = self.cli("save-explicit-sleep", "--date", "2026-08-03", "--clock", "23:40")
self.assertEqual(late["sleptAt"], "2026-08-03T23:40:00+08:00")
```

- [ ] **Step 2: 运行测试，确认新命令尚不存在**

Run: `& "C:\Users\Mashiroyes\AppData\Local\Python\pythoncore-3.14-64\python.exe" -m unittest plugin/mashirobot-plugin-plan/tests/test_planner.py -v`

Expected: FAIL，错误包含 `unknown command: save-explicit-sleep`。

- [ ] **Step 3: 实现日期和时刻映射及显式写入**

```python
def explicit_sleep_at(routine_date: str, clock: str) -> str:
    routine_date = require_date(routine_date)
    normalized = normalize_time(clock, "clock")
    day = date.fromisoformat(routine_date) + timedelta(days=1 if normalized < "06:00" else 0)
    return f"{day.isoformat()}T{normalized}:00+08:00"

def save_explicit_sleep(self, routine_date: str, clock: str, require_existing: bool = False) -> dict[str, Any]:
    routine_date = require_date(routine_date)
    slept_at = explicit_sleep_at(routine_date, clock)
    updated = shanghai_iso()
    with self.transaction():
        existing = self.db.execute(
            "SELECT routine_date FROM sleep_events WHERE routine_date=?", (routine_date,)
        ).fetchone()
        if require_existing and existing is None:
            return {"ok": True, "action": "save-explicit-sleep", "routineDate": routine_date,
                    "sleptAt": None, "replaced": False, "found": False}
        self.db.execute(
            "INSERT INTO sleep_events(routine_date,slept_at,updated_at) VALUES(?,?,?) "
            "ON CONFLICT(routine_date) DO UPDATE SET slept_at=excluded.slept_at,updated_at=excluded.updated_at",
            (routine_date, slept_at, updated),
        )
    return {"ok": True, "action": "save-explicit-sleep", "routineDate": routine_date,
            "sleptAt": slept_at, "replaced": existing is not None, "found": True}
```

在 CLI 增加 `--clock` 和 `--require-existing` 参数，并把 `save-explicit-sleep` 路由到该方法。

- [ ] **Step 4: 运行 Python 测试，确认新映射与现有 06:00 边界测试均通过**

Run: `& "C:\Users\Mashiroyes\AppData\Local\Python\pythoncore-3.14-64\python.exe" -m unittest plugin/mashirobot-plugin-plan/tests/test_planner.py -v`

Expected: PASS。

### Task 2: 添加删除接口及不存在记录保护

**Files:**
- Modify: `plugin/mashirobot-plugin-plan/planner/database.py:461-466`
- Modify: `plugin/mashirobot-plugin-plan/planner/planner.py:25-55`
- Test: `plugin/mashirobot-plugin-plan/tests/test_planner.py`

**Interfaces:**
- Consumes: `routine_date: str` (`YYYY-MM-DD`)。
- Produces: `PlannerDatabase.delete_explicit_sleep(routine_date) -> dict[str, Any]`，返回 `deleted: bool` 和 `routineDate`。
- Produces: CLI 命令 `delete-explicit-sleep --date YYYY-MM-DD`。

- [ ] **Step 1: 写入删除与不存在记录的失败测试**

```python
self.cli("save-explicit-sleep", "--date", "2026-08-09", "--clock", "01:10")
deleted = self.cli("delete-explicit-sleep", "--date", "2026-08-09")
self.assertTrue(deleted["deleted"])
self.assertFalse(self.cli("delete-explicit-sleep", "--date", "2026-08-09")["deleted"])
```

- [ ] **Step 2: 运行测试，确认删除命令尚不存在**

Run: `& "C:\Users\Mashiroyes\AppData\Local\Python\pythoncore-3.14-64\python.exe" -m unittest plugin/mashirobot-plugin-plan/tests/test_planner.py -v`

Expected: FAIL，错误包含 `unknown command: delete-explicit-sleep`。

- [ ] **Step 3: 实现精确日期删除**

```python
def delete_explicit_sleep(self, routine_date: str) -> dict[str, Any]:
    routine_date = require_date(routine_date)
    cursor = self.db.execute("DELETE FROM sleep_events WHERE routine_date=?", (routine_date,))
    self.db.commit()
    return {"ok": True, "action": "delete-explicit-sleep", "routineDate": routine_date, "deleted": cursor.rowcount == 1}
```

在 CLI handlers 中接入 `delete-explicit-sleep`。

- [ ] **Step 4: 运行 Python 测试**

Run: `& "C:\Users\Mashiroyes\AppData\Local\Python\pythoncore-3.14-64\python.exe" -m unittest plugin/mashirobot-plugin-plan/tests/test_planner.py -v`

Expected: PASS。

### Task 3: 路由自然语言指令并输出无歧义回复

**Files:**
- Modify: `plugin/mashirobot-plugin-plan/routes/sleep.mjs`
- Modify: `plugin/mashirobot-plugin-plan/routes/index.mjs:1-42`
- Test: `plugin/mashirobot-plugin-plan/tests/route-compatibility.test.mjs:275-318`

**Interfaces:**
- Consumes: `parseExplicitSleepCommand(rawText, now) -> { action: "save" | "update" | "delete", routineDate: string, clock?: string } | null`。
- Produces: `handleExplicitSleep(rawText, context) -> { command: string, reply: string } | null`。
- Produces: 保存回复 `已保存：8月3日睡觉时间 02:04（实际入睡时刻：8月4日 02:04）。`。

- [ ] **Step 1: 写入路由失败测试**

```javascript
assert.equal(match("8月3日睡觉时间 2:04", fixture.context), true);
assert.match(handle("8月3日睡觉时间 2:04", fixture.context).reply, /8月4日 02:04/);
assert.match(handle("修改8月3日睡觉时间为23:40", fixture.context).reply, /8月3日 23:40/);
assert.match(handle("删除8月9日睡觉时间", fixture.context).reply, /没有睡觉时间记录/);
```

- [ ] **Step 2: 运行 Node 路由测试，确认新指令尚未匹配**

Run: `node --test plugin/mashirobot-plugin-plan/tests/route-compatibility.test.mjs`

Expected: FAIL，首条断言为 `false !== true`。

- [ ] **Step 3: 实现纯解析、处理与路由优先级**

在 `sleep.mjs` 中：

```javascript
const CLOCK = "([01]?\\d|2[0-3])[:：]([0-5]\\d)";

export function parseExplicitSleepCommand(rawText, now = new Date()) {
  const text = String(rawText).trim().replace(/\s+/g, "");
  const routineDate = resolveMessageDate(text, now);
  if (!routineDate || !/睡觉时间/.test(text)) return null;
  if (/^删除/.test(text) && /睡觉时间$/.test(text)) {
    return { action: "delete", routineDate };
  }
  const edit = new RegExp(`^修改.*睡觉时间(?:为|是)?${CLOCK}$`).exec(text);
  if (edit) return { action: "update", routineDate, clock: `${edit[1].padStart(2, "0")}:${edit[2]}` };
  const save = new RegExp(`睡觉时间(?:为|是)?${CLOCK}$`).exec(text);
  if (save) return { action: "save", routineDate, clock: `${save[1].padStart(2, "0")}:${save[2]}` };
  return null;
}
```

在 `routes/index.mjs` 中，将显式睡觉指令的 matcher 和 handler 放在 `handleSleepQuery` 之前，使“8月3日睡觉时间 2:04”不会被查询逻辑吞掉。

`save` 使用 UPSERT；`update` 带 `--require-existing`；`delete` 根据 `deleted` 生成成功或“没有睡觉时间记录”回复。保存/修改回复必须同时格式化 `routineDate` 与 `sleptAt`。

- [ ] **Step 4: 运行 Node 路由测试并确认精确关键词回归通过**

Run: `node --test plugin/mashirobot-plugin-plan/tests/route-compatibility.test.mjs`

Expected: PASS，包含既有 `已睡觉` 的 06:00 边界断言。

### Task 4: 更新帮助和说明并完成回归验证

**Files:**
- Modify: `plugin/mashirobot-plugin-plan/help/help-data.mjs:21-26,80-90`
- Modify: `plugin/mashirobot-plugin-plan/README.md:睡觉时间章节`
- Test: `plugin/mashirobot-plugin-plan/tests/test_planner.py`
- Test: `plugin/mashirobot-plugin-plan/tests/route-compatibility.test.mjs`

**Interfaces:**
- Consumes: 已实现的自然语言指令。
- Produces: 帮助和 README 中可复制的新增、修改、删除示例及凌晨次日说明。

- [ ] **Step 1: 在帮助数据与 README 中加入精确示例**

加入以下文案：

```text
8月3日睡觉时间 2:04
修改8月3日睡觉时间为 23:40
删除8月9日睡觉时间
指定日期是作息归属日；00:00 至 05:59 的实际入睡时刻在次日。
```

- [ ] **Step 2: 运行完整插件回归测试**

Run: `node --test plugin/mashirobot-plugin-plan/tests/route-compatibility.test.mjs; & "C:\Users\Mashiroyes\AppData\Local\Python\pythoncore-3.14-64\python.exe" -m unittest discover -s "plugin\mashirobot-plugin-plan\tests" -p "test_*.py" -v`

Expected: 所有 Node 与 Python 测试 PASS。

- [ ] **Step 3: 用临时数据库进行端到端数据库验证**

Run:

```powershell
$env:OPENCLAW_PLANNER_DB_PATH = Join-Path $env:TEMP 'specified-sleep-check.sqlite'
Remove-Item -LiteralPath $env:OPENCLAW_PLANNER_DB_PATH -ErrorAction SilentlyContinue
& "C:\Users\Mashiroyes\AppData\Local\Python\pythoncore-3.14-64\python.exe" plugin\mashirobot-plugin-plan\planner\planner.py save-explicit-sleep --date 2026-08-03 --clock 02:04
& "C:\Users\Mashiroyes\AppData\Local\Python\pythoncore-3.14-64\python.exe" plugin\mashirobot-plugin-plan\planner\planner.py save-explicit-sleep --date 2026-08-03 --clock 23:40 --require-existing
& "C:\Users\Mashiroyes\AppData\Local\Python\pythoncore-3.14-64\python.exe" plugin\mashirobot-plugin-plan\planner\planner.py delete-explicit-sleep --date 2026-08-03
```

Expected: 首次输出 `2026-08-04T02:04:00+08:00`，修改输出 `2026-08-03T23:40:00+08:00`，删除输出 `deleted: true`；正式 `sqlite/openclaw-planner.sqlite` 未被写入。
