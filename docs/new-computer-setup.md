# 新电脑部署指南

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
3. 优先在新电脑重新登录。如果选择迁移，至少安全复制 `openclaw.json`、`gateway.vbs`、`gateway.cmd`、`identity`、`devices` 和 `openclaw-weixin\accounts`；不要复制日志、缓存和旧备份。
4. 确认 `openclaw channels status --json` 能看到 `openclaw-weixin`。项目通过本机配置自动使用当前 OpenClaw 命令，不要求保持旧电脑安装路径。

不得把令牌、账号凭据或 `%USERPROFILE%\.openclaw` 整个目录提交到 GitHub。

### Python 路径

所有 worker 统一调用系统 `python.exe`。安装 Python 后把它加入 `PATH`，并确认 `python --version` 和 `python -c "from PIL import Image"` 成功即可；不需要设置项目专用 Python 环境变量，也不使用用户目录中的固定 Python 路径。安装或修改 `PATH` 后，重新打开终端和 OpenClaw Gateway。

### 本机配置

账号、目标会话和软件路径统一保存在：

```text
%LOCALAPPDATA%\MashiroBot\config\machine.json
```

该文件不在 Git 仓库中，也不得上传。首次部署使用微信目标会话 ID 初始化；OpenClaw 命令和默认微信账号会自动发现：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\core\config\initialize-machine-config.ps1 `
  -WeixinTarget '<你的微信目标会话ID>'
```

如果网易云或游戏不在仓库默认路径，编辑 `machine.json` 中的 `cloudMusicPath` 和 `gameExecutableOverrides`。游戏覆盖项使用 `games.json` 内的游戏 `key`，例如：

```json
{
  "gameExecutableOverrides": {
    "elden-ring": "E:\\SteamLibrary\\steamapps\\common\\ELDEN RING\\Game\\eldenring.exe"
  }
}
```

仓库可以放在任意目录；OpenClaw 适配器会在部署时根据当前仓库位置生成。

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

2. 安装基础环境和 Pillow，完成 OpenClaw/微信配置，再初始化本机配置。

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\core\config\initialize-machine-config.ps1 -WeixinTarget '<你的微信目标会话ID>'
```

3. 推荐在管理员 PowerShell 7 中执行统一安装。它会修复微信适配器、部署 Gateway 看门狗、FocusLock、禁止名单、游戏锁、QQ、战利品和英语统计；不会安装温度监控。

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\core\config\install-new-computer.ps1 `
  -Action Install `
  -WeixinTarget '<你的微信目标会话ID>'
```

4. 如果不使用统一安装器，才按以下命令分别部署 FocusLock 和游戏/禁止名单后台 worker。

```powershell
$db = (Resolve-Path .\sqlite\openclaw-planner.sqlite).Path
pwsh -NoProfile -ExecutionPolicy Bypass -File .\focus-lock\FocusLock.ps1 -Mode Install
pwsh -NoProfile -ExecutionPolicy Bypass -File .\plugin\mashirobot-plugin-game-timer\block\powershell\install-block.ps1 -Mode Install -SqlitePath $db
pwsh -NoProfile -ExecutionPolicy Bypass -File .\plugin\mashirobot-plugin-game-timer\game-locker\powershell\install-game-locker.ps1 -Mode Install -SqlitePath $db
pwsh -NoProfile -ExecutionPolicy Bypass -File .\plugin\mashirobot-plugin-game-timer\qq\powershell\install-qq-session.ps1 -Mode Install -SqlitePath $db
```

游戏计时器的单次提醒/强退任务由插件在创建计时时自动注册，不需要预先手工调用 `install-game-timer.ps1`。

5. 分步部署时，按需要安装其余后台功能。财报插件默认关闭；只有启用该插件时才安装财报 worker。

```powershell
$db = (Resolve-Path .\sqlite\openclaw-planner.sqlite).Path
pwsh -NoProfile -ExecutionPolicy Bypass -File .\plugin\mashirobot-plugin-loot\windows\install.ps1 -Action Install -SqlitePath $db
pwsh -NoProfile -ExecutionPolicy Bypass -File .\plugin\mashirobot-plugin-plan\windows\install-english-skills.ps1 -Action Install -SqlitePath $db
pwsh -NoProfile -ExecutionPolicy Bypass -File .\plugin\mashirobot-plugin-financial-report\windows\install-financial-report.ps1 -Action Install -SqlitePath $db
# 使用审计是可选功能；先准备新电脑的 targets.json，再执行：
# pwsh -NoProfile -ExecutionPolicy Bypass -File .\plugin\mashirobot-plugin-game-timer\audit\powershell\install-audit.ps1 -Mode Install -SqlitePath $db -TargetsPath 'C:\path\to\targets.json'
```

6. 统一安装器会重启 Gateway 并运行健康检查。分步安装时手动执行以下命令：

```powershell
pwsh -NoProfile -File .\core\adapter\start-openclaw-gateway.ps1
pwsh -NoProfile -File .\core\health\check-mashirobot.ps1
node --test .\tests\*.test.mjs
pwsh -NoProfile -File .\plugin\mashirobot-plugin-game-timer\block\tests\test-worker.ps1
```

健康检查通过只证明文件、运行时和主要入口可用；仍需从微信实际发送 `help`、`状态`、`查看计划`，并分别检查图片、数据库读取和回复投递。
