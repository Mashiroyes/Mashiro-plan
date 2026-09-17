# 状态图片采集超时修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让状态图片不因完整硬件采集超过 20 秒而失败。

**Architecture:** Node 侧根据命令传入采集模式和超时；PowerShell 仅在硬件模式执行硬件枚举。超时转为用户可读错误。

**Tech Stack:** Node.js、PowerShell 7、Python/Pillow、OpenClaw Gateway。

## Global Constraints

- 状态图保留 CPU、内存、磁盘、进程、网络和温度数据。
- 硬件信息保留完整硬件数据。
- 不改变正式数据库。

---

### Task 1: 分离状态与硬件采集

**Files:**
- Modify: `plugin/mashirobot-plugin-status/core/collector.mjs`
- Modify: `plugin/mashirobot-plugin-status/index.mjs`
- Modify: `plugin/mashirobot-plugin-status/powershell/status-collector.ps1`
- Test: `plugin/mashirobot-plugin-status/tests/plugin.test.mjs`

- [ ] **Step 1: 为采集器增加 kind 参数与模式超时**

`status` 使用 30 秒，`hardware` 使用 45 秒，并将 ETIMEDOUT 转换为“状态采集超过 N 秒”。

- [ ] **Step 2: 在 PowerShell 中仅为 hardware 执行完整硬件枚举**

保留状态图的数据字段；未执行的硬件字段使用既有规范化默认值。

- [ ] **Step 3: 增加命令模式传递断言**

验证 `状态` 向自定义采集器传递 `kind: status`，`硬件信息` 传递 `kind: hardware`。

### Task 2: 验证运行时行为

**Files:**
- Verify: `plugin/mashirobot-plugin-status/tests/*.test.mjs`
- Verify: `plugin/mashirobot-plugin-status/tests/test-renderer.ps1`

- [ ] **Step 1: 运行插件和渲染测试**

运行 Node 状态插件测试及 PowerShell 渲染测试。

- [ ] **Step 2: 真实生成两类图片**

运行 `状态` 和 `硬件信息`，确认每次都返回媒体文件。

- [ ] **Step 3: 重启并探测网关**

重启 OpenClaw Gateway，确认微信通道和本地连接探测恢复。
