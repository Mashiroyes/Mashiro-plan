# MashiroBot 本地插件系统

`plan` 是 MashiroBot 的系统根目录。OpenClaw 收到微信文字后，先由这里的本地插件判断并处理；只有没有插件匹配的消息才继续交给 GPT。

## 新电脑环境与依赖

本项目按 Windows 11 x64 编写，只支持 Windows。以下版本是当前旧电脑已实际运行的版本，不代表理论最低版本：

| 环境 | 当前验证版本 | 用途 | 是否必需 |
|---|---:|---|---|
| Git for Windows | 2.54.0 | 克隆和更新仓库 | 必需 |
| PowerShell 7 | 7.6.6 | Windows worker、安装器、计划任务和健康检查 | 必需 |
| Node.js | 26.5.1 | 插件路由、测试和 `node:sqlite` 数据访问 | 必需；必须包含 `node:sqlite` |
| Python 64 位 | 3.14.6 | 计划数据库、图表和状态图片 | 必需 |
| Pillow | 12.1.1 | Python 图片渲染 | 必需 |
| OpenClaw | 以 `openclaw` 命令可用为准 | 微信收发、Gateway 和定时消息 | 必需 |
| .NET 8 SDK/Desktop Runtime | SDK 8.0.423 | 构建并运行使用审计 worker | 使用“使用审计”时必需 |
| Clash Verge Rev / Mihomo | 本机安装 | 网站禁止、临时解除和 Google 代理检测 | 使用网站禁止功能时必需 |
| NVIDIA 显卡驱动 | 提供 `nvidia-smi` | NVIDIA 显卡信息 | 仅 NVIDIA 设备需要 |

Node 端只使用 Node.js 内置模块，仓库目前没有 `package.json`，因此不需要执行 `npm install`。Python 端唯一的第三方包是 Pillow：

```powershell
python -m pip install --upgrade pip
python -m pip install Pillow==12.1.1
```

安装后确认命令均可用：

```powershell
git --version
pwsh --version
node --version
node -e "const { DatabaseSync } = require('node:sqlite'); console.log(typeof DatabaseSync === 'function')"
python --version
python -c "from PIL import Image; print(Image.__version__)"
dotnet --version
openclaw --version
```

### OpenClaw 与微信配置

GitHub 仓库不包含 OpenClaw 的账号、令牌、微信连接和 Gateway 配置。新电脑需要单独完成：

1. 安装 OpenClaw，确保 `Get-Command openclaw` 能找到命令。
2. 安装并登录当前使用的 Tencent Weixin OpenClaw 包。
3. 恢复 `%USERPROFILE%\.openclaw` 中必要的账号和 Gateway 配置，确认 `gateway.vbs`、`gateway.cmd` 和微信账号可用。
4. 当前部分 worker 仍引用 `D:\Program\nodejs\npm_global24\openclaw.ps1` 或 `.cmd`。新电脑应把 OpenClaw 安装到相同位置，或在部署前修改这些脚本中的路径；仅加入 `PATH` 不能覆盖这些硬编码引用。

不得把令牌、账号凭据或 `%USERPROFILE%\.openclaw` 整个目录提交到 GitHub。

### Python 路径

项目优先读取 `OPENCLAW_PYTHON_PATH` 或 `MASHIROBOT_PYTHON`，部分旧 worker 仍使用 `%LOCALAPPDATA%\Python\pythoncore-3.14-64\python.exe`。推荐把 Python 3.14 安装到该位置，并同时设置用户环境变量：

```powershell
[Environment]::SetEnvironmentVariable('MASHIROBOT_PYTHON', (Get-Command python.exe).Source, 'User')
[Environment]::SetEnvironmentVariable('OPENCLAW_PYTHON_PATH', (Get-Command python.exe).Source, 'User')
```

设置后重新打开终端和 OpenClaw Gateway。

### 数据库与本机状态

正式数据库是 `sqlite\openclaw-planner.sqlite`。它被 `.gitignore` 排除，**不会随 GitHub 克隆恢复**。换电脑前应停止 Gateway 和相关 worker，执行 WAL checkpoint 后，把数据库复制到新仓库的同一相对位置：

```powershell
python -c "import sqlite3; p=r'.\sqlite\openclaw-planner.sqlite'; c=sqlite3.connect(p); print(c.execute('PRAGMA wal_checkpoint(FULL)').fetchall()); print(c.execute('PRAGMA integrity_check').fetchone()); c.close()"
```

如果复制时仍存在 `openclaw-planner.sqlite-wal` 和 `openclaw-planner.sqlite-shm`，三个文件必须作为同一组一起复制。百度同步盘可以同步这些文件；只从 GitHub 克隆不行。

以下内容同样不会由 GitHub 自动恢复，应在新电脑重新部署或重新配置：

- `%LOCALAPPDATA%\MashiroBot` 和 `C:\ProgramData\MashiroBot` 下的运行时副本、缓存及状态。
- `C:\ProgramData\CodexFocusLock`、Windows 计划任务、hosts、注册表策略和隔离区。
- QQ、游戏、网易云、Clash Verge Rev 等软件的安装路径。
- OpenClaw/微信凭据，以及项目外的第三方运行库。

### 新电脑不迁移温度监控

新电脑明确不迁移 LibreHardwareMonitor、PawnIO、`C:\ProgramData\MashiroBot\TemperatureMonitor` 和 `MashiroBot Temperature Monitor` 计划任务，也不需要从旧电脑复制相关 DLL。状态插件的系统、CPU、内存、磁盘、进程和网络信息仍可使用；温度项显示“未检测到”属于预期结果。

Clash Verge Rev 需要在新电脑启用 Mihomo，并保持本机代理端口 `127.0.0.1:7897`。禁止名单 worker 的核心重载使用仅本机可访问的控制器 `127.0.0.1:9097`；迁移后应重新检查 Clash 配置，不能直接假定旧电脑配置已生效。

## 新电脑部署顺序

以下命令均在仓库根目录执行。涉及 ProgramData、系统策略或计划任务的步骤使用“以管理员身份运行”的 PowerShell 7。

1. 克隆仓库并恢复数据库。

```powershell
git clone https://github.com/Mashiroyes/Mashiro-plan.git plan
Set-Location .\plan
Test-Path .\sqlite\openclaw-planner.sqlite
```

2. 安装基础环境和 Pillow，完成 OpenClaw/微信配置，然后先运行健康检查。

```powershell
pwsh -NoProfile -File .\core\health\check-mashirobot.ps1 -PreStart
```

3. 修复微信薄适配入口并安装 Gateway 看门狗。

```powershell
pwsh -NoProfile -File .\core\adapter\repair-openclaw-adapter.ps1 -WhatIfReport
pwsh -NoProfile -File .\core\adapter\repair-openclaw-adapter.ps1
pwsh -NoProfile -File .\core\health\install-openclaw-gateway-watchdog.ps1
```

4. 在管理员 PowerShell 7 中部署 FocusLock 和游戏/禁止名单后台 worker。

```powershell
$db = (Resolve-Path .\sqlite\openclaw-planner.sqlite).Path
pwsh -NoProfile -ExecutionPolicy Bypass -File .\focus-lock\FocusLock.ps1 -Mode Install
pwsh -NoProfile -ExecutionPolicy Bypass -File .\plugin\mashirobot-plugin-game-timer\block\powershell\install-block.ps1 -Mode Install -SqlitePath $db
pwsh -NoProfile -ExecutionPolicy Bypass -File .\plugin\mashirobot-plugin-game-timer\game-locker\powershell\install-game-locker.ps1 -Mode Install -SqlitePath $db
pwsh -NoProfile -ExecutionPolicy Bypass -File .\plugin\mashirobot-plugin-game-timer\qq\powershell\install-qq-session.ps1 -Mode Install -SqlitePath $db
```

游戏计时器的单次提醒/强退任务由插件在创建计时时自动注册，不需要预先手工调用 `install-game-timer.ps1`。

5. 按需要安装其余后台功能。

```powershell
$db = (Resolve-Path .\sqlite\openclaw-planner.sqlite).Path
pwsh -NoProfile -ExecutionPolicy Bypass -File .\plugin\mashirobot-plugin-loot\windows\install.ps1 -Action Install -SqlitePath $db
pwsh -NoProfile -ExecutionPolicy Bypass -File .\plugin\mashirobot-plugin-plan\windows\install-english-skills.ps1 -Action Install -SqlitePath $db
pwsh -NoProfile -ExecutionPolicy Bypass -File .\plugin\mashirobot-plugin-financial-report\windows\install-financial-report.ps1 -Action Install -SqlitePath $db
# 使用审计是可选功能；先准备新电脑的 targets.json，再执行：
# pwsh -NoProfile -ExecutionPolicy Bypass -File .\plugin\mashirobot-plugin-game-timer\audit\powershell\install-audit.ps1 -Mode Install -SqlitePath $db -TargetsPath 'C:\path\to\targets.json'
```

6. 重启 Gateway，运行最终健康检查和核心测试。

```powershell
pwsh -NoProfile -File .\core\adapter\start-openclaw-gateway.ps1
pwsh -NoProfile -File .\core\health\check-mashirobot.ps1
node --test .\tests\*.test.mjs
pwsh -NoProfile -File .\plugin\mashirobot-plugin-game-timer\block\tests\test-worker.ps1
```

健康检查通过只证明文件、运行时和主要入口可用；仍需从微信实际发送 `help`、`状态`、`查看计划`，并分别检查图片、数据库读取和回复投递。

## 架构

```text
微信消息
  → OpenClaw 薄适配入口
  → plan\core 插件加载与路由
  → plan\plugin 中匹配的本地插件
  → 未匹配时才进入 GPT
```

插件返回统一的文字和图片结果。已匹配的插件即使执行失败，也只返回本地错误，不会把同一条消息交给 GPT 重试。

## 目录

```text
plan/
├─ README.md   # 系统级说明与插件索引
├─ core/       # 插件加载、路由、帮助菜单、桥接、日志和健康检查
├─ plugin/     # 本机可信插件
├─ sqlite/     # 正式数据库及数据库安全备份
├─ tests/      # 插件核心与系统级回归测试
└─ docs/       # 插件契约、迁移记录和开发说明
```

根目录不保存长期 `state`、`cache` 或 `logs`：

- 35 秒菜单状态只在网关进程内存中保存。
- 插件需要持久化的状态由插件写入 SQLite。
- 帮助图片缓存位于 `%TEMP%\MashiroBot\help`，微信发送使用独立临时副本。
- 系统和插件日志统一写入 `%USERPROFILE%\.openclaw\logs\mashirobot.log`。

## 插件发现

网关启动时扫描 `plan\plugin` 的直接子目录，只加载名称匹配 `mashirobot-plugin-*` 的文件夹。每个插件至少需要：

- `plugin.json`：ID、名称、版本、固定菜单编号、优先级和精确指令。
- `index.mjs`：`match`、`handle`、`healthCheck` 和 `getHelp` 四个同步导出。
- `README.md`：该插件完整的用户与维护说明。

加载器会拒绝损坏清单、目录名与 ID 不一致、入口越界、缺少说明、重复菜单编号、重复精确指令以及占用全局保留指令的插件。新增、删除或修改插件后需要重启网关；系统不支持热加载。

插件由本机用户手动放入并视为可信代码。结构校验用于提高稳定性，不是安全沙箱；系统不会从网络自动安装或更新插件。

详细清单和接口规范见 [插件契约](docs/plugin-contract.md)。

## 全局帮助菜单

以下消息去除首尾空格后完全匹配时打开图片主菜单：

- `help`
- `/help`
- `帮助`

主菜单发送后，当前微信账号和会话拥有 35 秒菜单状态。期间回复大于 0 的纯整数可按固定菜单编号打开插件详情；无效编号由本地提示且不延长倒计时，成功选择后立即清除状态。不同账号和会话互不影响，网关重启后状态自然丢失。

## OpenClaw 适配与自修复

`core\adapter\fast-routine.adapter.js` 是微信包薄入口的唯一正式模板；已安装包只把消息和会话上下文交给 `core\index.mjs`，不再保存计划业务代码。`repair-openclaw-adapter.ps1` 只接受已知旧布局或已安装的标准布局，修改前同时备份两个入口文件，修改后运行 Node.js 语法检查，失败时恢复原文件；`-WhatIfReport` 可只显示目标和替换范围。

`start-openclaw-gateway.ps1` 依次执行入口修复、启动前健康检查和现有 `gateway.vbs`。只有健康检查脚本存在并通过后，Windows Gateway 任务才可切换到该包装器，避免开机时进入不可恢复的失败循环。

`core\health\watch-openclaw-gateway.ps1` 只在网关健康检查失败时才启动既有的 `OpenClaw Gateway` 任务；`install-openclaw-gateway-watchdog.ps1` 注册登录后和每六小时一次的检查任务。根目录的 `启动OpenClaw网关.cmd` 可双击执行同样的检查和恢复，所有结果记录在 `%USERPROFILE%\.openclaw\logs\gateway-watchdog.log`。

## 已安装插件

| 菜单编号 | 插件目录 | 功能 | 详细说明 |
|---:|---|---|---|
| 1 | `plugin\mashirobot-plugin-plan` | 计划、每日记录、作息、起床、通用提醒和磁盘空间提醒 | [计划插件 README](plugin/mashirobot-plugin-plan/README.md) |
| 2 | `plugin\mashirobot-plugin-game-timer` | 游戏限时提醒、超时强退，以及按期限禁止软件和网站 | [游戏计时与禁止名单插件 README](plugin/mashirobot-plugin-game-timer/README.md) |
| 3 | `plugin\mashirobot-plugin-status` | Windows 系统状态与硬件信息图片 | [状态插件 README](plugin/mashirobot-plugin-status/README.md) |
| 4 | `plugin\mashirobot-plugin-loot` | 记录当天最后一次爽点并在次日回放 | [战利品插件 README](plugin/mashirobot-plugin-loot/README.md) |
| 5 | `plugin\mashirobot-plugin-financial-report` | 零基础财报、招股书课程与聊天模式点评 | [财报与招股书插件 README](plugin/mashirobot-plugin-financial-report/README.md) |

## 维护规则

新增插件或修改 Windows worker 前，必须先阅读 [插件开发经验与教训](插件开发经验与教训.md)，尤其是时间、编码、任务计划、路径安全和隔离测试部分。

1. 系统级加载、路由、菜单或适配逻辑放在 `core`；业务能力放在独立插件中。
2. 插件不得在自身保存全局菜单状态，也不得自行决定是否继续调用 GPT。
3. 修改插件清单、指令、目录、数据库结构、任务或调用关系时，必须同步更新该插件自己的 `README.md`。
4. 根 README 只维护系统架构、公共约定和插件索引，不复制插件的完整指令或内部表结构。
5. 系统变更至少运行 `node --test plan/tests/*.test.mjs`；插件还要运行其独立 README 中列出的测试。
6. 正式 SQLite 发生结构迁移前必须先执行 WAL checkpoint、完整性检查和可恢复备份，不得重建或清空现有表。

## 功能实现选型

按功能选择更合适的运行时，不要求所有插件只使用一种脚本：

| 功能 | 优先实现 | 原因 |
| --- | --- | --- |
| Windows 硬件、进程、磁盘、运行时间及本地网络采集 | PowerShell 7 | 可直接使用 CIM、系统进程、`nvidia-smi` 和本机服务接口。 |
| 图片、头像裁切、渐变、中文自动换行和动态高度布局 | Python + Pillow | 对透明图层、字体渲染和像素级测试更稳定。 |
| 微信指令路由、插件结果和媒体发送 | Node.js | 与 MashiroBot 插件契约一致。 |

新增功能时，采集数据优先放入 PowerShell，视觉展示优先放入 Python 渲染器；不使用 PowerShell 的 GDI+/System.Drawing 处理复杂图片排版，避免网关环境中的字体和透明度差异。

旧 `script` 代码树已在插件切换和微信验证通过后删除；迁移证据及外部恢复点见 [迁移记录](docs/migration-report.md)。
# 计划与插件

旧电脑的状态插件曾使用 LibreHardwareMonitor/PawnIO 和 `MashiroBot Temperature Monitor` 计划任务读取温度；该能力不列入新电脑迁移范围。新电脑不安装相关 DLL、驱动或任务，温度显示“未检测到”属于预期结果。
