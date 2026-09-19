# Windows 换机脚本审计（2026-09-19）

## 已迁入仓库

- 原 `codex-study\focus-lock` 中的 18 个维护脚本、3 个测试/说明文件已迁入 `plan\focus-lock`。
- `FocusLock.ps1` 及四个已部署辅助脚本已用 `C:\ProgramData\CodexFocusLock` 当前运行版本校准。
- Bilibili/QQ 旧版兼容状态模板位于 `plugin\mashirobot-plugin-game-timer\block\powershell\bilibili-qq-expiry.default.json`，安装禁止名单 worker 时会一并部署。

## 项目外仍会出现、但不是源码唯一副本

这些目录是安装器生成的运行时副本或本机状态，不能直接搬回源码目录：

- `C:\ProgramData\MashiroBot\...`
- `C:\ProgramData\CodexFocusLock\...`
- `%LOCALAPPDATA%\MashiroBot\...`
- Windows 计划任务、注册表策略、hosts 和 Clash Verge 配置

对应源码已在 `plan` 内。换机时应从仓库重新运行安装器，而不是复制旧电脑的 ProgramData。

## 不应收入仓库的外部依赖

- PowerShell 7、Node.js、Python、OpenClaw：应在新电脑重新安装。
- 网易云、QQ、游戏及其可执行文件：属于本机软件，不是项目脚本。
- `sqlite\openclaw-planner.sqlite`：位于项目目录，但被 Git 忽略；百度同步盘可同步它，单靠 GitHub 克隆不会恢复数据库。

## 发现的失效旧引用

计划任务 `Codex-DST-ForceClose-20260731-221003` 指向已经不存在的 `codex-study\game-timer\StopGameAfterLimit.ps1`。没有可迁移源码，因此本次未伪造文件，也未擅自删除该任务。

`focus-lock\tests\Manage-AndroidInstallRestrictions.Tests.ps1` 引用的 `Manage-AndroidInstallRestrictions.ps1` 在旧目录和本机其他项目目录中均不存在。测试文件已作为历史证据迁入，但对应功能不能视为可恢复源码。

## 换机最低步骤

1. 同步/克隆 `plan`，并另行带上 `sqlite\openclaw-planner.sqlite`。
2. 安装 PowerShell 7、Node.js、Python 和 OpenClaw。
3. 从各插件的 `windows\install*.ps1` 或 `powershell\install*.ps1` 重新部署运行时与计划任务。
4. 以管理员身份运行 `focus-lock\FocusLock.ps1 -Mode Install`。
5. 运行项目健康检查，并重新登记新电脑上的游戏、QQ、网易云等软件路径。
