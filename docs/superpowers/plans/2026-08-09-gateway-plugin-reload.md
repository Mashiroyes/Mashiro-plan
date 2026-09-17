# 微信计划插件重载 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让微信网关加载已实现的指定日期睡觉时间删除功能。

**Architecture:** 微信插件通过 `fast-routine.js` 的绝对文件导入直接读取工作区代码。重启 Node 网关即可清除模块缓存，不复制代码也不改数据库。

**Tech Stack:** OpenClaw Gateway、Node.js、计划插件 SQLite 测试夹具。

## Global Constraints

- 只重启 `OpenClaw Gateway`，不终止其他 Node 进程。
- 不向正式 SQLite 写入测试数据。
- 验证必须覆盖“删除8月9日睡觉时间”不会再进入查询路由。

---

### Task 1: 重启并验证网关加载新版路由

**Files:**
- Verify: `C:\Users\Mashiroyes\.openclaw\npm\projects\tencent-weixin-openclaw-weixin-7783ac86ba\node_modules\@tencent-weixin\openclaw-weixin\dist\src\messaging\fast-routine.js`
- Verify: `plugin/mashirobot-plugin-plan/tests/route-compatibility.test.mjs`

**Interfaces:**
- Consumes: `fast-routine.js` 的 `handleMashiroBotMessage` 导入。
- Produces: 重启后的网关进程和已验证的新路由结果。

- [ ] **Step 1: 确认网关入口和工作区导入路径**

运行：`Get-Content fast-routine.js`，确认它导入 `D:/BaiduSyncdisk/Study/AI/codex/codex-study/plan/core/index.mjs`。

- [ ] **Step 2: 重启 OpenClaw Gateway**

运行 OpenClaw 的网关重启命令，只操作 `OpenClaw Gateway` 服务。

- [ ] **Step 3: 验证网关恢复**

检查网关状态和 Node 进程，确认新的网关进程正在监听本地端口。

- [ ] **Step 4: 验证删除路由**

运行：`node --test --test-name-pattern='explicitly supplied routine date' plugin/mashirobot-plugin-plan/tests/route-compatibility.test.mjs`。

预期：通过；“删除8月3日睡觉时间”返回 `删除指定日期睡觉时间`，第二次返回不存在记录。
