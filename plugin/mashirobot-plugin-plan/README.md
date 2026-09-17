# MashiroBot 计划插件

`mashirobot-plugin-plan` 是 MashiroBot 的第 1 个插件，固定菜单编号为 **1**。它在 GPT 之前本地处理计划、每日记录、英语听说读写统计、睡觉、打卡、起床、通用提醒、固定提醒和磁盘空间监测；匹配后不会消耗 GPT token。

## 位置与入口

```text
D:\BaiduSyncdisk\Study\AI\codex\codex-study\plan\plugin\mashirobot-plugin-plan
```

正式数据库：

```text
D:\BaiduSyncdisk\Study\AI\codex\codex-study\plan\sqlite\openclaw-planner.sqlite
```

清单中的精确指令为 `/计划` 和 `/计划详细`。其余自然语言先由无副作用的 `match` 判断，再由 `handle` 执行；已匹配但失败的消息也在本地结束，不会转交 GPT。

## 用户指令

### 帮助

- `/计划`：返回按功能分组的图片帮助。
- `/计划详细`：返回完整图片帮助；内容较长时拆成多张。
- 在全局 `help` 菜单出现后的 35 秒内回复纯数字 `1`，效果等同打开计划插件详情。

图片生成失败时自动降级为文字帮助。

### 保存或覆盖完整计划

第一行写日期语义，后面每行写一个时间段：

```text
今日计划
09:00 - 10:00 背单词
10:00 - 11:00 哈利波特
```

第一行还支持：

- `计划`、`今天计划`、`今天的计划`、`今天的日程`
- `明天计划`、`明天的计划`
- `8月1日的新版计划`
- `2026-08-01的计划`

时间段支持半角或全角冒号，以及 `-`、`—`、`至`、`到` 等连接符。保存同一日期的新完整计划会创建新版本，并使旧的生效项目进入历史；录入时已经结束的项目自动记为 `completed`，不记为 `missed`。

整条消息中出现多个日期词时，明确日期优先于相对日期：`2026-08-03`、`2026年8月3日` 或 `8月3日` 的优先级高于后文中的“今天/今日/明天/昨天”。因此“8月3日计划”后面即使包含“今日记录”，计划仍保存到 8 月 3 日。

同一条微信可以同时保存计划和记录，两部分按标题切开：

```text
今日计划
09:00 - 10:00 背单词

今日记录
学习：1h
娱乐：0h
```

如果计划标题使用明确日期（例如 `8月3日计划`），同一条消息后面的 `今日记录` 也继承该明确日期并保存为 8 月 3 日记录，而不是消息实际发送日。

### 查询计划

示例：

- `查询8月1日的计划`
- `8月1日计划`
- `2026-08-01的计划`
- `昨天计划`、`今天计划`、`明天计划`

查询返回当前生效版本和项目，并提示该日期保留的历史版本数量。

### 保存每日记录

```text
今日记录
学习：5.5h
娱乐：2h
其他：
  chatgpt：7.5h
英文小说：哈利波特 54360字
1730603-1676243=54360
```

第一行可写 `今日记录`、`昨天记录`、`8月1日记录` 或 `2026-08-01记录`。学习、娱乐和其他项目支持小时或分钟；`chatgpt` 默认作为“其他”明细，不自动归入学习或娱乐。

英文小说字段不绑定具体书名。未写英文小说时按 0 字保存；位置差值行可同时保存起止位置和阅读字数。每日记录中的“今天/昨天”按自然日期计算，不采用睡觉记录的 06:00 边界。

### 查询每日记录与统计图

单日：

- `今天记录`、`查询昨天记录`
- `8月1日记录`、`2026年8月1日记录`

自然周期：

- `本周记录`、`上周记录`
- `本月记录`、`上月记录`、`2026年8月记录`
- `今年记录`、`去年记录`、`2026年记录`

周期查询返回文字汇总和一张彩色图：学习、娱乐、其他和英文小说字数使用柱状图，睡觉时间使用折线图。周和月按天绘制，年按月绘制。当前周、月、年截至今天；上一周期使用完整自然周期。没有记录的普通数值按 0 显示，没有睡觉记录的日期不参与睡觉平均且折线断开。

### 英语听说读写统计

保存计划时会同步提供英语分类数据；查看统计、管理关键词和图表由 [语言学习插件](../mashirobot-plugin-language/README.md) 负责。


自动发送不做每日轮询，而是由三个 Windows 日历任务直接触发：`MashiroBot English Skills Weekly` 每周一 11:00 发送上周，`MashiroBot English Skills Monthly` 每月 1 日 11:00 发送上个月，`MashiroBot English Skills Yearly` 每年 1 月 1 日 11:00 发送去年。任务带有明确周期参数，电脑错过时间后补跑也会计算正确的上一周期；成功记录具有幂等保护。

安装或更新自动发送任务：

```powershell
& pwsh -NoProfile -File "plan\plugin\mashirobot-plugin-plan\windows\install-english-skills.ps1" -Action Install
```

检查状态：

```powershell
& pwsh -NoProfile -File "plan\plugin\mashirobot-plugin-plan\windows\install-english-skills.ps1" -Action Inspect
```

### 固定完成与晚间指令

以下指令必须在去除首尾空格后**完全等于**关键词：

- `已打卡`
- `没打卡`
- `已睡觉`
- `已起床`
- `收到`

`已睡觉` 无论当前是否有催促任务，都要写入睡觉记录并停止对应晚间催促。`已起床` 停止当前起床提醒，但不会自动恢复系统音量或关闭网易云。`收到` 只确认最近一条已经实际发送、仍等待确认的通用提醒。

### 查询睡觉时间

示例：

- `上个星期睡觉时间`
- `查询上个星期睡觉时间`
- `本周睡觉时间`
- `8月睡觉时间`
- `2026年8月睡觉时间`

回复包含逐日时间、平均、最早和最晚时间。**00:00 至 05:59** 回复 `已睡觉` 归属前一日，06:00 起归属当日；同一归属日最后一次回复覆盖此前记录。统计平均值时，凌晨记录按次日 24:00 至 29:59 计算，避免平均到中午。

### 起床提醒

示例：

- `明天早上7点叫我起床`
- `今天早上8点30叫我起床`
- `8月5日早上7点叫我起床`
- `2026-08-05 07:00叫我起床`
- `查询起床提醒`
- `取消起床提醒`

到点后 Windows 任务允许唤醒睡眠或休眠中的电脑，把系统音量调到最大，尝试播放网易云上一次音乐，并每 10 分钟发送微信提醒，直到精确回复 `已起床`。完全关机的电脑无法被普通计划任务唤醒。

起床设置、查询和取消不执行 OpenClaw 旧 cron 扫描，避免网关超时造成微信重试和重复回复。旧 cron 清理只通过维护动作 `CleanupLegacyWakeup` 按需运行。

### 通用提醒

示例：

- `提醒我12点吃饭`
- `11:57提醒我吃饭`
- `提醒我明天12点有个会议`
- `提醒我8月5日12点30分开会`
- `提醒我2026年8月5日下午3点开会`

未指定日期默认今天；今天的目标时间已过时直接提示，不自动顺延到明天。提醒内容不能为空。到点后如果没有精确回复 `收到`，每 5 分钟重复一次。`好的，收到` 等更长文本不会确认。

### 固定提醒与磁盘监测

- 21:40 洗澡提醒、22:00 晚间状态初始化，以及 22:00 至次日 02:50 的打卡/睡觉催促由本地定时任务执行。
- 磁盘监测检查固定磁盘，任一磁盘剩余空间低于 20 GB 时发送微信提醒；同一低空间组合每天至多提醒一次。

## 运行规则与状态

### 计划项目

- `item_status`：`active` 表示当前版本生效；`superseded` 表示被后续完整计划或修改取代。
- `actual_status`：新项目通常是 `unknown`；录入时已经结束或用户上报完成后为 `completed`。
- `reminder_status`：覆盖待调度、立即补发、发送中、已发送、失败、错过或已完成等投递阶段。
- 计划中途修改后，新任务立即补发一次提醒；旧项目和旧任务进入历史或被取消。

### 通用提醒

`general_reminders` 使用 `active`、`sending`、`failed` 和 `acknowledged` 管理并发提醒。发送成功后仍回到 `active` 等待 `收到`；确认时按 `last_sent_at` 选择最近一条已经发送的提醒，并清理对应 `OpenClaw-General-*` 任务。

### 插件持久状态

`plugin_runtime_state` 以插件 ID 和状态键为联合主键。当前状态键：

- `night:<YYYY-MM-DD>`：单词打卡和睡觉催促状态。
- `wakeup:active`：当前起床时间、任务名、重复间隔和完成状态。
- `disk-space:20gb`：低空间磁盘组合和最近提醒日期。

35 秒帮助菜单状态不写入数据库，只在核心进程内存中保存。

## 数据库

正式 SQLite 使用 WAL、外键和 5 秒忙等待。主要表：

| 表 | 用途 |
|---|---|
| `plan_revisions` | 每个日期的完整计划版本和原始文本 |
| `plan_items` | 生效项目、历史项目、实际完成与提醒状态 |
| `completion_reports` | 当天实际完成情况原文 |
| `sleep_events` | 按 06:00 边界归属的睡觉时间 |
| `daily_records` | 学习、娱乐、其他、英文小说和阅读位置 |
| `general_reminders` | 一次性通用提醒、投递与确认状态 |
| `plugin_runtime_state` | 晚间、起床和磁盘监测运行状态 |
| `english_skill_plan_entries` | 当前及历史计划项目的听说读写/Anki 分类与时长 |
| `english_skill_deliveries` | 周、月、年自动统计图的幂等投递状态 |
| `learned_english_reading_titles` | 从每日记录自动学习的英文小说书名 |

不要重建或清空正式数据库。结构变更必须可重复执行，并在变更前完成 WAL checkpoint、`PRAGMA integrity_check` 和安全备份。

## 目录职责

```text
mashirobot-plugin-plan/
├─ plugin.json       # 插件清单和固定菜单编号
├─ index.mjs         # 标准插件接口
├─ health.mjs        # 插件依赖自检
├─ help/             # 图片帮助数据
├─ routes/           # GPT 前的无模型消息匹配与处理
├─ shared/           # Asia/Shanghai 日期语义
├─ bridge/           # Node 到 Python/PowerShell 的受控调用
├─ planner/          # SQLite、汇总和 Pillow 图表
├─ windows/          # 计划任务、提醒、起床、网易云和磁盘动作
└─ tests/            # Node、Python 和 PowerShell 回归测试
```

日志统一写入：

```text
%USERPROFILE%\.openclaw\logs\mashirobot.log
```

每条日志应包含插件 ID。图表和帮助图片使用临时目录；核心帮助缓存位于 `%TEMP%\MashiroBot\help`。

## Windows 计划任务与调用链

主要 Windows 计划任务：

| 任务前缀或名称 | 作用 | 重复规则 |
|---|---|---|
| `OpenClaw-Plan-*` | 计划项目到点提醒 | 一次，到点可补跑 |
| `OpenClaw-General-*` | 通用提醒 | 每 5 分钟，直到 `收到` |
| `OpenClaw-Wakeup-*` | 起床提醒 | 每 10 分钟，直到 `已起床` |
| `MashiroBot English Skills Weekly` | 自动发送上周英语四项统计图 | 每周一 11:00 |
| `MashiroBot English Skills Monthly` | 自动发送上月英语四项统计图 | 每月 1 日 11:00 |
| `MashiroBot English Skills Yearly` | 自动发送去年英语四项统计图 | 每年 1 月 1 日 11:00 |

这些任务启用 `WakeToRun` 和 `StartWhenAvailable`，使用插件内 `windows` 目录的入口。晚间洗澡、打卡/睡觉轮询和 6 小时磁盘检查可由 OpenClaw cron 调用同一插件 Windows 动作。

调用链：

```text
微信文字
  → plan\core 本地插件路由
  → routes
  → bridge\planner-runner.mjs
  → planner\planner.py / windows\*.ps1
  → plan\sqlite\openclaw-planner.sqlite
```

计划任务投递时由 `windows\reminder-common.ps1` 调用 OpenClaw 微信发送能力。电脑睡眠或休眠时任务可以唤醒并继续；电脑关机、微信网关未运行或网络不可用时不能保证准时送达。

## 网易云注意事项

`windows\cloudmusic-playback.ps1` 会寻找网易云进程，必要时启动客户端，优先发送系统媒体播放键并通过持续系统音频判断是否真的播放。自动测试只允许使用 `-StaticOnly`；省略该参数可能启动网易云、改变音量或实际播放音乐，必须得到用户明确许可。

起床流程把音量调到最大后不会自动恢复，回复 `已起床` 也不会关闭网易云，这是用户确认的行为。

## 健康检查

插件自检会检查清单、Python 入口、Windows 入口、正式数据库和 Python 解释器：

```powershell
node --input-type=module -e "import { healthCheck } from './plan/plugin/mashirobot-plugin-plan/index.mjs'; console.log(JSON.stringify(healthCheck(), null, 2))"
```

验证加载器能发现当前插件：

```powershell
node --input-type=module -e "import path from 'node:path'; import { loadPlugins } from './plan/core/loader/plugin-loader.mjs'; const r = await loadPlugins({ pluginRoot: path.resolve('plan/plugin') }); console.log(JSON.stringify({ plugins: r.plugins.map(p => p.manifest.id), failures: r.failures }, null, 2))"
```

预期插件列表包含 `mashirobot-plugin-plan` 且 `failures` 为空。

## 测试

系统级 Node 测试：

```powershell
node --test plan/tests/plugin-loader.test.mjs plan/tests/plugin-router.test.mjs plan/tests/help-service.test.mjs plan/tests/readme-boundary.test.mjs
```

计划插件路由测试：

```powershell
node --test plan/plugin/mashirobot-plugin-plan/tests/route-compatibility.test.mjs
```

Python 数据和图表测试：

```powershell
& "C:\Users\Mashiroyes\AppData\Local\Python\pythoncore-3.14-64\python.exe" -m unittest discover -s "plan\plugin\mashirobot-plugin-plan\tests" -p "test_*.py" -v
```

Windows 动作测试使用临时 SQLite，不应修改正式数据库：

```powershell
& pwsh -NoProfile -File "plan\plugin\mashirobot-plugin-plan\tests\test_windows_actions.ps1"
```

网易云只做静态检查：

```powershell
& pwsh -NoProfile -File "plan\plugin\mashirobot-plugin-plan\tests\test-cloudmusic-playback.ps1" -StaticOnly
```

## 故障排查

1. **指令进入 GPT**：确认插件清单为 `enabled: true`，重启网关，再检查加载器输出是否有编号、指令或入口冲突。
2. **`/计划` 没有图片**：检查 Python、Pillow 和 `%TEMP%\MashiroBot\help` 写入权限；渲染失败应仍返回文字帮助。
3. **数据库忙或查询失败**：不要删除 WAL/SHM；先停止写入源，执行 WAL checkpoint 和完整性检查，再从安全备份恢复。
4. **提醒未发送**：检查对应 `OpenClaw-*` 任务是否启用、动作是否指向本插件 `windows` 目录，以及 `mashirobot.log` 中的插件 ID 和错误。
5. **回复后仍重复提醒**：确认回复完全等于 `收到`、`已起床` 或 `已睡觉`，再检查 `general_reminders` 或 `plugin_runtime_state` 的最新状态。
6. **网易云只打开不播放**：只在允许发声时运行非静态测试，检查媒体键、客户端状态和持续系统音频检测；不要在自动回归中强制播放。
7. **睡觉日期不对**：核对消息实际时间和 Asia/Shanghai 时区；00:00–05:59 必须归到前一日，同一归属日以最后一次记录为准。

## 迁移与维护

- 插件保留现有 SQLite 表和用户数据，不得用空库覆盖正式库。
- 旧 JSON 夜间和起床状态只允许经过逐字段验证后一次性导入 `plugin_runtime_state`；导入后以 SQLite 为准。
- OpenClaw 包内只应保留薄适配入口，业务实现以本插件目录为唯一正式来源。
- 插件代码视为本机可信代码；当前没有热加载、网络安装、不可信沙箱或公开插件市场。
- 修改本插件的指令、输入格式、目录、数据库表、状态键、Windows 任务、调用关系或用户可见行为时，必须在同一次变更中同步更新本 `README.md` 和相关测试。
