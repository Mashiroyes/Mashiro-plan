# 财报课程多行微信发送修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让微信收到完整分段财报课程卡和官方原文链接，不再只显示第一行标题。

**Architecture:** 保留现有课程生成、SQLite 幂等和任务计划结构，只替换普通微信消息的 Windows 执行入口。`common.ps1` 使用 PowerShell 原生的 `openclaw.ps1` 传递多行字符串；聊天点评仍使用 `openclaw.cmd agent --message-file`，因为提示词通过 UTF-8 文件传递。

**Tech Stack:** PowerShell 7、OpenClaw CLI、Node.js 26、Node Test Runner、SQLite。

## Global Constraints

- 普通课程呈现固定为完整分段文字加官方原文链接。
- 不制作图片卡片，不附整份 PDF。
- 找不到 `D:\Program\nodejs\npm_global24\openclaw.ps1` 时明确失败，禁止回退到 `.cmd message send`。
- 不修改课程内容、课程日历、SQLite 自动发送记录或聊天模式点评命令。
- 日志不得写入完整课程卡、用户答案或点评提示词。
- `plan` 不是 Git 仓库；本计划中的提交步骤记录为“不适用”，不得伪造 commit。

---

### Task 1: 保真传递多行微信消息

**Files:**
- Modify: `plan/plugin/mashirobot-plugin-financial-report/windows/common.ps1`
- Modify: `plan/plugin/mashirobot-plugin-financial-report/tests/test-windows-runtime.ps1`

**Interfaces:**
- Consumes: `Send-FinancialWeixinMessage -Message <string> [-DryRun]`
- Produces: 相同函数签名；非模拟模式通过 `openclaw.ps1 message send` 发送完整字符串。

- [ ] **Step 1: 写入会失败的静态与多行边界测试**

在 `test-windows-runtime.ps1` 增加：

```powershell
$commonSource = Get-Content -Raw -Encoding UTF8 (Join-Path $pluginRoot 'windows\common.ps1')
if ($commonSource -notmatch [regex]::Escape("openclaw.ps1")) {
    throw 'ordinary WeChat delivery must use openclaw.ps1'
}
if ($commonSource -match '\$script:OpenClawCmd\s+message\s+send') {
    throw 'ordinary WeChat delivery still uses openclaw.cmd'
}

$capturePath = Join-Path $tempRoot 'captured-message.txt'
$fakeOpenClaw = Join-Path $tempRoot 'openclaw.ps1'
@'
param()
$messageIndex = [Array]::IndexOf($args, '--message')
[IO.File]::WriteAllText($env:MASHIRO_CAPTURE_PATH, [string]$args[$messageIndex + 1], [Text.UTF8Encoding]::new($false))
'{"ok":true,"messageId":"fake-multiline"}'
'@ | Set-Content -LiteralPath $fakeOpenClaw -Encoding utf8NoBOM
$script:OpenClawPs1 = $fakeOpenClaw
$env:MASHIRO_CAPTURE_PATH = $capturePath
$expected = "【第 1 天财报课】`n`n【财报事实】`n营业收入`n`n【官方原文】`nhttps://example.test/report.pdf"
Send-FinancialWeixinMessage -Message $expected | Out-Null
if ([IO.File]::ReadAllText($capturePath, [Text.Encoding]::UTF8) -cne $expected) {
    throw 'multiline UTF-8 course card changed at the OpenClaw boundary'
}
```

- [ ] **Step 2: 运行测试并确认旧实现失败**

Run:

```powershell
pwsh -NoProfile -File plan/plugin/mashirobot-plugin-financial-report/tests/test-windows-runtime.ps1
```

Expected: FAIL，指出普通消息仍使用 `openclaw.cmd` 或多行内容没有完整到达模拟边界。

- [ ] **Step 3: 将普通消息入口替换为 openclaw.ps1**

在 `common.ps1` 中保留聊天点评所需的 `$script:OpenClawCmd`，并新增：

```powershell
$script:OpenClawPs1 = 'D:\Program\nodejs\npm_global24\openclaw.ps1'
```

把 `Send-FinancialWeixinMessage` 的非模拟分支改为：

```powershell
if (-not (Test-Path -LiteralPath $script:OpenClawPs1)) {
    throw "OpenClaw PowerShell entry not found: $script:OpenClawPs1"
}
$output = & $script:OpenClawPs1 message send --json --channel openclaw-weixin `
    --account $script:WeixinAccount --target $script:WeixinTarget --message $Message 2>&1
if ($LASTEXITCODE -ne 0) { throw ($output -join [Environment]::NewLine) }
return (($output -join [Environment]::NewLine) | ConvertFrom-Json -AsHashtable)
```

- [ ] **Step 4: 运行多行边界及插件测试**

Run:

```powershell
pwsh -NoProfile -File plan/plugin/mashirobot-plugin-financial-report/tests/test-windows-runtime.ps1
node --test plan/plugin/mashirobot-plugin-financial-report/tests/*.test.mjs
```

Expected: PowerShell 边界测试通过；插件全部 Node 测试通过。

- [ ] **Step 5: 提交**

不适用：`plan` 目录不是 Git 仓库。记录测试输出，不创建虚假提交。

### Task 2: 安装、补发和端到端确认

**Files:**
- Modify by installer: `%LOCALAPPDATA%\MashiroBot\financial-report\runtime-v1`
- Read/verify: `plan/sqlite/openclaw-planner.sqlite`

**Interfaces:**
- Consumes: `install-financial-report.ps1 -Action Install`
- Produces: 固定运行时中的新版 `common.ps1`，以及微信中的完整第一课。

- [ ] **Step 1: 运行系统回归与安装器隔离测试**

Run:

```powershell
node --test plan/tests/*.test.mjs
pwsh -NoProfile -File plan/plugin/mashirobot-plugin-financial-report/tests/test-installer.ps1
```

Expected: 系统测试与真实临时任务安装测试全部通过，临时任务和临时数据库自动清理。

- [ ] **Step 2: 正式安装并核对运行时哈希**

Run:

```powershell
pwsh -NoProfile -File plan/plugin/mashirobot-plugin-financial-report/windows/install-financial-report.ps1 -Action Install
pwsh -NoProfile -File plan/plugin/mashirobot-plugin-financial-report/windows/install-financial-report.ps1 -Action Inspect
```

Expected: SQLite 完整性为 `ok`；3 个正式任务为 `Ready`；`runtime-v1\plugin\windows\common.ps1` 哈希与工作区一致。

- [ ] **Step 3: 生成今天第一课但不改变自动发送记录**

通过 `plan/core/index.mjs` 调用 `今日财报`，使用正式账号、会话、SQLite 路径和当前时间，取得完整 `reply`。断言正文包含：

```text
【财报事实】
【通俗解释】
【常见误区】
【今日问题】
【官方原文】
```

- [ ] **Step 4: 使用新版公共发送函数补发完整第一课**

在同一个 PowerShell 7 进程内：

```powershell
. "$env:LOCALAPPDATA\MashiroBot\financial-report\runtime-v1\plugin\windows\common.ps1"
Send-FinancialWeixinMessage -Message $reply
```

Expected: OpenClaw 返回成功消息 ID；不得把完整课程正文写入日志。

- [ ] **Step 5: 审计数据库幂等和日志隐私**

查询正式 SQLite：今天 `financial_report` 第 1 课只有一条 `sent` 自动发送记录。运行 `PRAGMA integrity_check`，结果必须为 `ok`。搜索 `mashirobot.log`，不得出现完整课程段落正文。

- [ ] **Step 6: 微信端确认**

请用户确认新消息能看到 `【财报事实】` 到 `【官方原文】` 的全部段落。OpenClaw 成功回执只证明出站接受，不能代替用户侧可见性确认。

- [ ] **Step 7: 提交**

不适用：`plan` 目录不是 Git 仓库。保留规格、计划、测试输出、消息 ID 和用户确认作为验收证据。
