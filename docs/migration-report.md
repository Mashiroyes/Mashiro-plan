# MashiroBot 插件系统迁移记录

生成时间：2026-08-03T12:47:31.0291544+08:00

## Task 1：迁移前盘点与恢复点

本阶段只进行了只读盘点、SQLite 安全检查、任务定义导出和恢复快照创建。没有修改 OpenClaw 生产逻辑、Windows 计划任务、OpenClaw cron、网关入口或旧运行状态，也没有删除任何生产文件。

### SQLite 安全检查

- 数据库：`D:\BaiduSyncdisk\Study\AI\codex\codex-study\plan\sqlite\openclaw-planner.sqlite`
- `PRAGMA wal_checkpoint(FULL)`：`[(0, 0, 0)]`
- `PRAGMA integrity_check`：`ok`

### 旧目录盘点

- 旧根目录：`D:\BaiduSyncdisk\Study\AI\codex\codex-study\plan\script`
- 文件总数：57
- `migrate`：33
- `duplicate`：7
- `backup`：2
- `obsolete`：15
- 仍引用旧根目录的 Windows 计划任务：12
- OpenClaw cron 总数：4，其中仍引用旧根目录：3
- 当前 OpenClaw 包运行入口引用：`fast-routine.js` 第 6 行仍导入旧 `plan/script/bridge/openclaw-router.mjs`
- 运行说明引用：`.openclaw\workspace\TOOLS.md` 2 处
- 项目 README 旧路径引用：15 处

逐文件处置、每个 Windows 任务的完整执行参数、每个 OpenClaw cron 的完整 `argv`、包入口哈希和旧状态文件哈希见 `migration-inventory.json`。

### 外部恢复快照

- ZIP：`D:\BaiduSyncdisk\Study\AI\codex\codex-study\migration-backups\plan-before-plugin-system-20260803-124659.zip`
- 大小：166,902 字节
- SHA-256：`4FA679CBF50251C279D9CC71A4B418475C69B5CAED5CD9A1DD7812485A145FD3`
- ZIP 条目数：77

已使用 `System.IO.Compression.ZipFile::OpenRead` 成功打开，并断言下列内容存在：

- `plan-script/`
- `openclaw-package/fast-routine.js`
- `openclaw-package/process-message.js`
- `tasks/`（12 个导出的计划任务 XML）
- `openclaw-cron/cron-jobs.json`（4 个 cron 的安全定义快照）
- `openclaw-gateway/gateway.cmd`
- `openclaw-gateway/gateway.vbs`
- `legacy-state/routine-state.json`
- `legacy-state/wakeup-state.json`

快照没有复制 `openclaw.json`、账号文件、令牌、Cookie、环境文件或数据库凭据。cron 快照只保留任务标识、说明、调度和命令参数，不包含投递账号或会话标识。

### Git checkpoint

`git rev-parse --is-inside-work-tree` 返回“not a git repository”。未初始化、修复或重建 `.git`，因此本阶段没有提交；迁移材料仅存在于当前工作目录，外部 ZIP 是恢复点。

### Task 1 验收结果

- SQLite WAL 已检查点并通过完整性检查。
- 57 个旧文件均有处置分类。
- 所有发现的旧路径生产引用均已记录，任务和 cron 保存了精确命令参数。
- 外部 ZIP 可读、关键条目齐全且已记录 SHA-256。
- 生产逻辑、运行任务和旧状态保持不变。

## Task 6：Windows 动作迁移与旧状态导入

本阶段只在 `plan\plugin\mashirobot-plugin-plan\windows` 建立新的 Windows 动作副本和测试；旧 `plan\script`、现有 Windows 计划任务、OpenClaw cron、已安装 OpenClaw 包与网关入口仍保持原样，尚未切换生产入口。

### 新插件 Windows 动作

- 已迁移统一提醒入口、计划提醒执行器、计划任务生成器、提醒公共函数、夜间状态、起床状态、网易云播放和磁盘空间检查。
- 新任务定义均由新插件中的 `$PSCommandPath` 或 `$PSScriptRoot` 生成，不引用 `plan\script`。
- 保留 `WakeToRun`、`StartWhenAvailable`、一般提醒每 5 分钟重复、起床提醒每 10 分钟重复和原有用户可见提醒文字。
- 夜间、起床和磁盘提醒状态改用 `plugin_runtime_state`，不再读写新 JSON 状态文件。
- 日志统一写入 `%USERPROFILE%\.openclaw\logs\mashirobot.log`，并包含插件 ID。

### 一次性旧状态导入

导入前逐字段验证了两个旧 JSON：夜间状态 4 个字段、起床状态 10 个字段；日期、带时区时间、布尔值、间隔和可空字段均符合预期。导入前正式数据库 `PRAGMA integrity_check` 为 `ok`，两个目标键均不存在，因此没有覆盖已有插件状态。

已导入并逐字段回读比对：

- `night:2026-08-02`
- `wakeup:active`

回读值与旧 JSON 的全部字段一致。导入后正式数据库 `PRAGMA integrity_check` 仍为 `ok`。旧 `routine-state.json` 和 `wakeup-state.json` 均保留，未删除或改写。`disk-space:20gb` 仅用于新代码运行状态，本阶段没有从旧 JSON 导入，也没有为正式库创建该键。

### 验证

- `test_windows_actions.ps1`：通过；所有测试强制使用临时 SQLite，临时库完整性为 `ok`。
- `test-cloudmusic-playback.ps1 -StaticOnly`：通过；没有启动网易云、没有播放音频。
- 正式 SQLite 导入后完整性：`ok`。
- Git 仍不可用；未初始化、修复或重建 `.git`，因此未创建提交。

## Task 8：系统与插件文档拆分

根 `plan\README.md` 已改为 MashiroBot 系统级说明，只维护整体架构、公共目录、插件发现、全局帮助、35 秒菜单状态、可信插件边界和已安装插件索引。计划插件的完整指令、数据库表、运行状态、Windows 任务、测试和故障排查集中到 `plan\plugin\mashirobot-plugin-plan\README.md`，根说明通过链接指向插件说明，不再重复维护业务细节。

检查时 `plan\doc` 不存在，因此没有文件需要复制、归档或判定为废弃，也没有执行删除。`plan\docs` 是唯一活动的系统文档根；分类结果已写入 `migration-inventory.json` 的 `documentation` 字段。根目录也没有发现 `README.md.bak.*`，最终清理阶段仍应按精确目标再次核验。

已增加 `plan\tests\readme-boundary.test.mjs`，用自动测试约束根 README 与插件 README 的职责边界。验证结果：

- `node --test plan\tests\readme-boundary.test.mjs`：2 项通过。
- `node --test plan\tests\plugin-loader.test.mjs`：26 项通过。
- 使用真实 `plan\plugin` 目录调用加载器：成功加载 `mashirobot-plugin-plan`，菜单编号为 1，精确指令为 `/计划` 和 `/计划详细`，失败列表为空。
- `migration-inventory.json` 重新解析成功。

## Task 9：OpenClaw 薄入口与受保护的升级自修复

本阶段建立了 `plan\core\adapter` 的标准薄入口、受保护的修复脚本和 Gateway 启动包装器。修复脚本只解析到一个活动 Tencent Weixin OpenClaw 包；生产写入前，两个入口的 SHA-256 均与 Task 1 迁移快照完全一致，并命中已知旧布局标记。

生产修补只修改：

- `fast-routine.js`：整文件替换为标准薄入口。
- `process-message.js`：只把单参数 fast-handler 调用替换为包含 `accountId`、`conversationId` 和 `now` 的调用。

写入前已在原文件旁生成：

- `fast-routine.js.bak.mashirobot-20260803-141644372`，SHA-256 `2955FEEB8DCC7BA508E58D13A2EF2D5D843BF5E3A3C29EDE32088E3A07E7C473`。
- `process-message.js.bak.mashirobot-20260803-141644372`，SHA-256 `B3520791372CACA4EE133F5B0F60A3D906D367E6E9CA43E4678103FE9B5CB374`。

修补后标准入口 SHA-256 为 `0775BF852E957AEFEBE8EF11691EAE4BFA9B015AB5C99ED5CA072A8930C56C39`；`process-message.js` SHA-256 为 `4370DE949247B2D512504D262D02135304831385B3A3B87550DF5087E4274D7E`。字符串级回读证明后者只发生了预期的一处调用替换。

验证结果：

- 假包测试覆盖已知旧布局、已修复布局、未知入口、未知调用、双文件备份、二次幂等和 `node --check` 失败回滚；连续运行两次均通过。
- `plan\core`、计划插件和已安装入口共 22 个 JavaScript/ESM 文件通过 `node --check`。
- 已安装薄入口可实际导入，导出的处理函数可调用，未匹配探针返回 `null`。
- 生产 `-WhatIfReport` 回读两个入口均为 `Canonical` 且 `no change`。

`start-openclaw-gateway.ps1` 已生成并通过静态测试，但 Task 10 的 `check-mashirobot.ps1 -PreStart` 尚未建立。因此本阶段没有切换 `OpenClaw Gateway` 任务；它仍直接执行 `C:\Users\Mashiroyes\.openclaw\gateway.vbs`，待健康检查存在且启动前验证通过后再迁移。

## Task 10：生产任务、OpenClaw cron 与 Gateway 路径切换

真实修改前创建了独立恢复快照：

- `D:\BaiduSyncdisk\Study\AI\codex\codex-study\migration-backups\task10-runtime-cutover-20260803-142656216`
- 快照包含当时存在的 12 个 `OpenClaw*` 任务 XML、完整任务摘要、4 个 cron 定义、`TOOLS.md`、`gateway.vbs`、`gateway.cmd` 和 SHA-256 清单。
- 快照时 11 个任务仍指向旧根；其中 14:30 的 `OpenClaw-Plan-20260803-7cbc3d07` 随后按原任务行为自行完成并删除，不是迁移操作删除的任务。

### Windows 任务

迁移了修改时仍存在的 10 个旧路径任务：2 个固定日常任务和 8 个 `OpenClaw-Plan-*` 任务。每个计划任务的 `ItemId` 均先在正式 SQLite 的 `plan_items` 中确认存在；没有孤儿任务需要跳过或删除。

每个任务都保存了 `before`、`proposed` 和 `after` XML。把 `-File` 参数归一化为同一占位符后，修改前后整份任务定义完全相等，证明任务名、URI、触发器、principal、`WakeToRun`、`StartWhenAvailable`、PowerShell 路径和其余参数没有变化。证据位于快照的 `scheduled-task-migration` 子目录。

### OpenClaw cron

只修改以下 3 个 cron 的命令脚本路径：

- `85f0f53b-2b84-417a-9694-bef450c88671`
- `1302bc52-80ab-4e47-bd31-026ce9395de9`
- `753bb3cc-621f-4814-972b-81f9758f3ef8`

三个任务都从旧 `routine-reminder.ps1` 切换到计划插件中的同名入口。排除 `updatedAtMs` 和运行状态，并把旧、新脚本路径归一化后，对每个 cron 的其余完整 JSON 定义做了深层比较；调度、时区、投递对象、账号、启用状态、说明、超时、输出上限和其余 `argv` 均保持不变。修改后定义和精确 `argv` 差异保存在 `openclaw-cron-after-path-migration.json` 与 `openclaw-cron-path-diff.json`。

### OpenClaw 操作说明与 Gateway

`.openclaw\workspace\TOOLS.md` 只更新了两处活动入口：

- 起床入口改为插件统一 `routine-reminder.ps1`，并补上该入口必需的 `-Action SetWakeup`。
- 计划管理入口改为插件的 `manage-plan.ps1`。

`OpenClaw Gateway` 修改前后另存了 XML。唯一变化是 Action：由直接执行 `gateway.vbs` 改为 PowerShell 7 执行 `plan\core\adapter\start-openclaw-gateway.ps1`。移除 Actions 节点后，修改前后任务 XML 完全相等；登录触发器、运行身份、权限、启用状态、`WakeToRun` 和 `StartWhenAvailable` 均保持不变。

本阶段没有运行 Gateway 任务、没有启动第二个网关，也没有实际发送微信或播放音乐。Gateway 的上次运行时间和结果在切换后仍为 `2026-08-03 12:02:35 +08:00` 和 `0`。

### 健康检查与回归结果

- `task-paths.test.ps1`：通过，覆盖固定日常任务和 `OpenClaw-Plan-*` XML。
- `check-mashirobot.ps1 -PreCleanup`：通过。
- `check-mashirobot.ps1 -PreStart`：通过。
- Gateway wrapper PowerShell 语法：通过；静态确认执行顺序为 adapter repair、`-PreStart` 健康检查、隐藏启动 `gateway.vbs`，且不调用计划任务自身。
- adapter `-WhatIfReport`：两个安装入口均为 `Canonical`、`no change`。
- 正式 SQLite `PRAGMA integrity_check`：仍为 `ok`；本阶段没有修改业务数据。
- 活动 Windows 任务、OpenClaw cron、已安装入口、Gateway 和操作说明中不再存在 `plan\script` 引用。旧目录、迁移记录、测试样例、适配器的旧布局识别规则和已安装包的 `.bak` 文件仍可包含历史字符串，但都不是活动生产入口。

Git 仍不可用；没有初始化、修复或重建 `.git`，因此没有创建 Task 10 提交。

## Task 11：切换验证与删除放行

网关入口修复并重启后，本地健康探针通过。用户随后在真实微信会话依次验证了主帮助菜单、35 秒内数字 `1`、`/计划` 和 `/计划详细`，并明确回复“通过”。这构成删除旧代码树的人工放行；删除前没有再次改变路由、任务、cron、数据库或插件配置。

## Task 12：删除旧代码树与最终复核

清理时间：2026-08-03T14:58:58.9722651+08:00

### 删除前安全检查

- 破坏性目标经 `Resolve-Path` 精确解析为 `D:\BaiduSyncdisk\Study\AI\codex\codex-study\plan\script`，确认它位于预期 `plan` 根目录下，且新插件清单存在。
- `check-mashirobot.ps1 -PreCleanup`：通过；活动 Windows 任务、4 个 OpenClaw cron、Gateway、已安装微信适配器、操作入口和活动源码对旧根目录的引用均为 0。
- 正式 SQLite `PRAGMA integrity_check`：`ok`。
- 旧 `routine-state.json` 与 SQLite `night:2026-08-02` 逐字段一致；旧 `wakeup-state.json` 与 SQLite `wakeup:active` 逐字段一致。两个旧 JSON 均继续保留。
- 外部 ZIP 可读，SHA-256 重新计算为 `4FA679CBF50251C279D9CC71A4B418475C69B5CAED5CD9A1DD7812485A145FD3`，与 Task 1 完全一致；共 77 个条目，其中 `plan-script/` 下 58 个条目、计划任务 XML 12 个，两个包入口、cron、Gateway 和两个旧状态快照均存在。

### 实际删除范围

- 已删除整个 `D:\BaiduSyncdisk\Study\AI\codex\codex-study\plan\script` 旧树；删除后路径不存在。
- `plan\doc` 在清理前后均不存在，无需删除。
- 根目录 `README.md.bak.*` 在清理前后均不存在，无需删除。
- 没有删除 `plan\core`、`plan\plugin`、`plan\sqlite`、`plan\tests`、`plan\docs`、外部 `migration-backups` 或 `.openclaw` 中的旧状态 JSON。
- 执行环境拒绝了递归 `Remove-Item` 调用；在已完成精确绝对路径与边界校验后，改由同一 PowerShell 进程调用 .NET `Directory.Delete` 删除同一个已验证目标，没有跨 shell 传递路径。

### 删除后快速验证

- `check-mashirobot.ps1`：通过，失败项为 0。
- 插件发现与计划插件健康检查：通过；SQLite 完整性：`ok`。
- 已安装 OpenClaw 两个入口均为 `Canonical`、`no change`。
- 活动 Windows 任务、OpenClaw cron、Gateway、操作入口和活动源码对旧根目录的引用仍为 0。
- 帮助图片临时渲染：通过。
- `plugin-loader.test.mjs` 与 `readme-boundary.test.mjs`：28 项通过，0 项失败，耗时约 0.30 秒。
- 当前 OpenClaw Gateway 进程：PID `13928`，创建时间 `2026-08-03T14:51:11.505568+08:00`。

### 恢复与 Git 状态

删除内容仍可从 `D:\BaiduSyncdisk\Study\AI\codex\codex-study\migration-backups\plan-before-plugin-system-20260803-124659.zip` 恢复，校验哈希见上。Git 仍不可用；没有初始化、修复或重建 `.git`，最终修改只存在于当前工作目录，外部 ZIP 是旧系统恢复点。
