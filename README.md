# MashiroBot 本地插件系统

`plan` 是 MashiroBot 的系统根目录。OpenClaw 收到微信文字后，先由这里的本地插件判断并处理；只有没有插件匹配的消息才继续交给 GPT。

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

状态插件的温度图片使用 LibreHardwareMonitor/PawnIO 读取 CPU、显卡核心、磁盘和主板温度；高权限读取由已注册的 `MashiroBot Temperature Monitor` 计划任务完成，Gateway 本身无需提权，也不会在微信命令触发时弹出 UAC。磁盘温度筛选实际温度传感器并排除 Warning/Critical 阈值，无法读取的项目显示“未检测到”。
