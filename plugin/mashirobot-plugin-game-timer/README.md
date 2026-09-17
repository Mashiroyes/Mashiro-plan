# 游戏计时与禁止名单插件

本插件固定菜单编号为 **2**，在微信消息进入 GPT 前处理游戏限时任务和禁止名单。计时从命令收到时立即开始，不等待游戏启动。

## 指令

```text
玩饥荒联机版15分钟，提醒后5分钟强退
玩艾尔登法环1小时
查看游戏
删除游戏2，4，6
确认删除
```

加入本机游戏时，第一行写 `加入游戏`，第二行粘贴完整路径：

```text
加入游戏
D:\Games\Eden-v0.0.4-win\eden.exe
```

路径必须真实存在、为绝对路径并以 `.exe` 结尾。显示名默认取程序所在文件夹名；第一个 `-` 及其后部分会被当作版本信息去掉，因此 `Eden-v0.0.4-win` 保存为 `Eden`。成功后微信会回复游戏名和进程名，重复路径不会重复写入。

## 计时规则

- 到达游戏时长时发送一次微信提醒。
- 再经过指定宽限时间仍在运行时，先向游戏主窗口发送正常关闭请求。
- 最多等待 3 秒；只有精确路径匹配的游戏进程仍未退出时，才执行强制关闭。
- 未指定宽限时间时默认 10 分钟。
- 同一可执行文件在“游戏时长 + 宽限时间 + 10 分钟”内不能覆盖或重新设置。
- 游戏提前退出不会提前解除锁。
- 微信端没有取消指令。

正常关闭和强制关闭都只处理同时满足“进程名相同”和“完整程序路径相同”的 PID，不关闭 Steam。同名但路径不同的程序不会被关闭。微信会区分“已正常关闭”和“已强制退出”。

只有插件实际执行强制关闭时，才会把该游戏的 EXE 随机改名并移入受保护目录。所有游戏统一保护 2 小时；提前自行退出、收到正常关闭请求后自行关闭、路径不匹配或未找到进程时均不保护。恢复前会校验哈希，原路径被占用时不会覆盖。

## 游戏配置

配置文件为 `core\games.json`。每个条目包含：

- `key`：内部唯一标识。
- `displayName`：微信中使用的游戏名。
- `aliases`：可选别名。
- `processName`：实际进程文件名。
- `executablePath`：完整 `.exe` 路径。
- `steamId`：可选 Steam App ID。

当前配置包含本机已安装的 Steam 游戏以及 Eden。Steam 公共运行库没有加入游戏清单。

## 数据与 Windows 任务

计时和锁保存在 `plan\sqlite\openclaw-planner.sqlite` 的 `game_timer_tasks` 表。提醒和强退分别使用一次性 Windows 任务：

- `OpenClaw-GameTimer-Reminder-*`
- `OpenClaw-GameTimer-Force-*`

不可变 worker 安装在 `%LOCALAPPDATA%\MashiroBot\game-timer\workers`。计划任务保存当前 PowerShell 7 的完整程序路径，避免 Windows 任务环境找不到 `pwsh.exe`；Node 与 worker 之间使用 Base64 UTF-8 传递中文数据，微信发送直接调用 PowerShell 入口，避免控制台或 CMD 转码产生乱码。任务允许唤醒电脑，并在错过运行时间后尽快执行；电脑完全关机时无法准时提醒。

## 验证

```powershell
node --test plan/plugin/mashirobot-plugin-game-timer/tests/*.test.mjs
pwsh -NoProfile -File plan/plugin/mashirobot-plugin-game-timer/tests/test-worker.ps1
```

隔离进程测试不会启动真实游戏，也不会发送微信。

## 禁止名单

原独立禁止名单插件已经作为本插件的 `block` 子模块运行。原有自然语言指令、正式数据库 `block_rules` 表、ProgramData worker 和 Windows 任务名称保持不变：

```text
禁止下载QQ7天
禁止访问bilibili.com永久
解除bilibili10分钟
解除10分钟
立即恢复bilibili
查询禁止名单
删除禁止规则2，4，6
确认删除
```

软件规则可阻止预配置软件的启动、安装包和官方下载域名；网站规则接受域名或 http/https URL，并同时写入 Hosts、Chrome/Edge 策略和当前 Clash 规则。临时解除不会删除永久规则，到期后自动恢复。`解除N分钟` 默认使用 `bilibili.com`；当天明确指定过网站后，默认值改为当天最近一次明确指定的网站，次日重置。

禁止名单子模块测试：

```powershell
node --test plan/plugin/mashirobot-plugin-game-timer/block/tests/*.test.mjs
pwsh -NoProfile -File plan/plugin/mashirobot-plugin-game-timer/block/tests/test-worker.ps1
```
