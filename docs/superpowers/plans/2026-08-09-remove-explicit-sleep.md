# 移除指定日期睡觉指令 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 移除指定日期睡觉聊天命令，并准确写入两条用户指定的睡眠记录。

**Architecture:** 计划插件只保留睡眠范围查询和“已睡觉”记录。移除指定日期命令的路由、CLI 与数据库辅助函数；直接使用参数化 SQLite upsert 写入两条记录。

**Tech Stack:** Node.js、Python、SQLite、OpenClaw Gateway。

## Global Constraints

- 不删除或重建 SQLite 数据库。
- 指定日期命令不得落入按月查询路由。
- 写入仅限 `2026-08-06` 与 `2026-08-07` 两个 `routine_date`。

---

### Task 1: 删除指定日期命令实现

**Files:**
- Modify: `plugin/mashirobot-plugin-plan/routes/sleep.mjs`
- Modify: `plugin/mashirobot-plugin-plan/routes/index.mjs`
- Modify: `plugin/mashirobot-plugin-plan/planner/database.py`
- Modify: `plugin/mashirobot-plugin-plan/planner/planner.py`
- Modify: `plugin/mashirobot-plugin-plan/help/help-data.mjs`
- Modify: `plugin/mashirobot-plugin-plan/README.md`
- Test: `plugin/mashirobot-plugin-plan/tests/route-compatibility.test.mjs`
- Test: `plugin/mashirobot-plugin-plan/tests/test_planner.py`

- [ ] **Step 1: 移除专用路由、CLI、数据库方法和帮助文本**

保留 `record-sleep`、`query-sleep` 和既有范围查询，删除 `save-explicit-sleep`、`delete-explicit-sleep` 及其参数。

- [ ] **Step 2: 添加回归断言**

断言 `删除8月9日睡觉时间` 和 `8月3日睡觉时间 2:04` 不再匹配计划插件；保留现有按周和按月查询断言。

- [ ] **Step 3: 运行完整 Python 与 Node 测试**

运行 Python unittest discovery 和 Node route compatibility 测试，预期全部通过。

### Task 2: 写入并核对正式记录

**Files:**
- Verify: `sqlite/openclaw-planner.sqlite`

- [ ] **Step 1: 参数化 upsert 两条记录**

写入 `2026-08-06` / `2026-08-07T05:00:00+08:00`，以及 `2026-08-07` / `2026-08-08T07:00:00+08:00`。

- [ ] **Step 2: 重启网关并只读查询**

重启 `OpenClaw Gateway`，查询两个归属日，确认保存结果与用户要求完全一致。
