# MashiroBot 财报与招股书课程插件

菜单编号 5。这个插件面向没有财报和股票基础的学习者，用 30 天财报课程与第一批 8 节招股书课程建立基本阅读习惯。课程只用于理解公司、报表和商业模式，不提供股票买卖建议。

## 自动课程

- 财报课：每天 12:20 推送；当天失败时每 15 分钟重试，跨天后不补发旧课。
- 招股书课：每周二、周五 18:10 推送；第一批共 8 节。
- 财报未回答不会阻止下一天课程；招股书也按自己的周二、周五日历独立推进。
- `暂停财报` 同时冻结两类自动课程；`继续财报` 从暂停前的下一课继续，不补发暂停期间内容。
- 暂停时仍可手动补学。

## 微信指令

| 指令 | 作用 |
| --- | --- |
| `财报课程` / `招股书课程` | 查看对应课程进度 |
| `今日财报` / `今日招股书` | 重新显示今天的课程，不改变自动发送记录 |
| `补学第N天` | 查看已经开始的第 N 天财报课，范围 1～30 |
| `补学招股书第N课` | 查看已经开始的第 N 节招股书课，范围 1～8 |
| `财报答案 内容` | 回答唯一一节最近发送但未回答的财报课 |
| `财报答案 第N天 内容` | 明确回答某一天，可重复提交新的尝试 |
| `招股书答案 内容` | 回答唯一一节最近发送但未回答的招股书课 |
| `招股书答案 第N课 内容` | 明确回答某一节，可重复提交新的尝试 |
| `暂停财报` / `继续财报` | 暂停或继续两类自动推送 |
| `重学今日财报` | 重新显示今天课程，并允许再答一次 |
| `/财报课程` / `/财报课程详细` | 查看帮助 |

省略课程序号时，如果有零节或多节未回答课程，插件不会猜测，会要求改用带序号的格式。

## 个性化点评边界

答案先写入 SQLite，微信立即回复“正在使用聊天模式生成点评”，后台任务再生成并发送点评。点评固定调用 `openclaw.cmd agent` 的独立聊天会话，使用 `agent:main:financial-report-feedback:` 会话键前缀。

这条链路明确禁止 Codex、Paseo、持久目标、工作区、worktree、`--deliver` 和任何工作模式参数。点评包含“答对了什么、还缺什么、更好的理解、下一步”四段，最后注明不构成投资建议。

## 内容与来源

- `curriculum/financial-reports.json`：30 天财报课。
- `curriculum/prospectuses.json`：8 节招股书课。
- `curriculum/sources.json`：4 份官方年报、4 份港交所中文招股章程的 URL、获取日期和 SHA-256。
- 每个事实都保存期间、单位和 PDF 页码；课程卡片附官方原文链接。

## 数据库

正式数据库为 `plan\sqlite\openclaw-planner.sqlite`。插件只新增四张带前缀的表：

- `financial_report_course_state`
- `financial_report_deliveries`
- `financial_report_answers`
- `financial_report_feedback`

安装器迁移前执行 WAL checkpoint 和完整性检查，并将数据库及存在的 `-wal`、`-shm` 文件备份到 `plan\sqlite\backups`。它不会重建或删除已有表。

## Windows 计划任务

任务运行固定版本 `%LOCALAPPDATA%\MashiroBot\financial-report\runtime-v1`，不直接引用同步盘工作区：

- `MashiroBot Financial Report Daily`
- `MashiroBot Prospectus Tuesday Friday`
- `MashiroBot Financial Report Feedback`

检查、安装和卸载：

```powershell
pwsh -NoProfile -File .\windows\install-financial-report.ps1 -Action Inspect
pwsh -NoProfile -File .\windows\install-financial-report.ps1 -Action Install
pwsh -NoProfile -File .\windows\install-financial-report.ps1 -Action Uninstall
```

`Inspect` 只读显示数据库完整性、运行时哈希、OpenClaw 可用性和任务 XML。`Uninstall` 只删除上述精确任务及插件自己的 `runtime-v1`，保留课程数据库记录。

## 日志与排错

日志写入 `%USERPROFILE%\.openclaw\logs\mashirobot.log`，只记录事件、课程类型、课程序号和简短错误，不记录完整答案或点评提示词。

- 没有自动消息：先运行安装器 `Inspect`，检查任务 XML、SQLite 完整性、OpenClaw 和 Gateway。
- 收到课程但没有点评：检查 Feedback 任务和 `financial_report_feedback` 状态；失败答案仍保留，可重试。
- 手机不在家中网络：微信连接的是已经登录的 OpenClaw 微信通道，手机无需连接家中 Wi-Fi；但家中电脑必须开机联网，睡眠可由任务唤醒，关机不能唤醒。

## 测试

```powershell
node --test .\tests\*.test.mjs
pwsh -NoProfile -File .\tests\test-windows-runtime.ps1
pwsh -NoProfile -File .\tests\test-installer.ps1
node --test ..\..\tests\plugin-router.test.mjs ..\..\tests\help-service.test.mjs
```

正式验收还必须从微信验证财报与招股书推送、两种补学、暂停/继续、回答和聊天模式点评；文件存在或任务显示 Ready 不能单独证明完成。
