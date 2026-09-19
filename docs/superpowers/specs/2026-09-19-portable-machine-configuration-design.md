# Plan 项目新电脑可移植配置设计

日期：2026-09-19

## 目标

新电脑可以把仓库克隆到任意目录，通过一个本机配置入口完成部署。生产代码不得依赖旧电脑的用户名、仓库绝对路径、`D:\Program\nodejs\npm_global24`、固定微信账号或固定软件安装路径。安装后，计划、提醒、英语统计、战利品、游戏计时、游戏锁和可选财报 worker 使用同一套本机配置。

不迁移温度监控。SQLite 数据库和 OpenClaw 凭据仍属于项目外数据，不进入 Git。

## 配置边界

新增本机配置文件：

```text
%LOCALAPPDATA%\MashiroBot\config\machine.json
```

仓库提供不含用户数据的示例和 JSON Schema，但不保存真实配置。配置结构：

```json
{
  "schemaVersion": 1,
  "openClawCommand": "",
  "weixinAccount": "",
  "weixinTarget": "",
  "cloudMusicPath": "",
  "gameExecutableOverrides": {
    "dont-starve-together": "",
    "eden": ""
  }
}
```

- `openClawCommand` 为空时使用 `Get-Command openclaw`；填写时必须是现存文件。
- `weixinAccount` 为空时从 `openclaw channels status --json` 的默认微信账号读取。
- `weixinTarget` 优先从配置读取。初始化器可在只有一个可识别的微信直接会话时自动选择；无法唯一确定时要求通过参数明确提供，禁止猜测。
- `cloudMusicPath` 为空时尝试从已安装应用和 PATH 发现；仍找不到时只禁用相关播放动作。
- `gameExecutableOverrides` 只覆盖仓库 `games.json` 的机器相关路径，游戏名称、别名、进程名和 Steam ID 仍由仓库管理。

本机配置不得包含 OpenClaw 令牌或账户密钥。OpenClaw 凭据继续由 `%USERPROFILE%\.openclaw` 管理。

## 统一读取接口

新增 PowerShell 公共模块和 Node.js 公共模块：

- PowerShell：读取、校验本机配置，解析 OpenClaw 命令、微信账号、目标会话和软件路径。
- Node.js：读取同一文件并把游戏路径覆盖合并到仓库配置。

解析顺序固定为：显式命令参数 > `machine.json` > 安全自动发现 > 报出缺失项。生产 worker 不再各自保存一份账号或路径常量。

错误必须指出具体字段、配置文件位置和修复命令。可选软件缺失不得让整个插件加载失败；数据库、OpenClaw 命令、微信目标等当前功能必需项缺失时必须停止对应安装或发送动作。

## 仓库路径与 OpenClaw 适配器

`core/adapter/fast-routine.adapter.js` 不再保存仓库绝对路径。修复脚本在部署时根据自身位置生成安装到 OpenClaw 包中的适配文件，生成内容引用当前仓库的 `core/index.mjs` 文件 URI。

适配器修复后必须验证：

1. 生成 URI 指向当前仓库；
2. 目标文件存在；
3. 安装后的 OpenClaw 文件包含该 URI；
4. Gateway 重启后健康检查成功。

## Worker 改造

以下组件改为统一读取本机配置：

- 计划提醒、起床提醒、固定作息和英语统计；
- 战利品早晚任务；
- 游戏计时提醒和游戏锁通知；
- 财报投递和反馈；
- 游戏配置加载。

计划任务部署到 `%LOCALAPPDATA%` 或 `%ProgramData%` 的运行副本时，必须同时复制公共配置读取模块，或者只传递稳定的本机配置路径。计划任务不得继续指向仓库外的旧机器绝对路径。

FocusLock 主安装路径继续从当前脚本位置部署。带旧仓库绝对路径的历史手工修复脚本不进入新电脑标准部署链；迁移文档明确标记为旧版诊断工具。旧版兼容状态模板继续从仓库部署，新电脑不复制旧 `C:\ProgramData\CodexFocusLock` 状态。

## 初始化和安装流程

新增初始化脚本，负责：

1. 创建 `%LOCALAPPDATA%\MashiroBot\config`；
2. 发现 OpenClaw 命令和默认微信账号；
3. 接受或唯一识别微信目标会话；
4. 发现网易云和已安装游戏路径；
5. 原子写入 `machine.json`；
6. 输出仍需人工填写的字段，但不打印令牌。

总安装入口先校验基础环境、数据库和本机配置，再调用现有各安装器。现有安装器保持可以单独运行，但缺失必需配置时给出同样的明确错误。

## 数据迁移

必须单独迁移：

- `sqlite\openclaw-planner.sqlite`；复制前执行 WAL checkpoint，存在 `-wal`、`-shm` 时作为同一组复制。
- OpenClaw 登录和微信配置；优先在新电脑重新登录，也允许安全复制必要的 `.openclaw` 配置，但不得提交 Git。

按需重建：

- 使用审计的 `targets.json`；
- Clash 订阅、Mihomo 控制器和代理端口配置；
- 本机游戏、QQ、网易云安装路径。

不迁移 `%LOCALAPPDATA%\MashiroBot` 和 `%ProgramData%\MashiroBot` 的 worker 副本、缓存、日志、隔离区或计划任务；安装器重新生成这些内容。不迁移任何温度监控文件和任务。

## 健康检查

健康检查新增以下证据：

- 本机配置文件存在且符合 schema；
- OpenClaw 命令可执行；
- 微信账号与目标会话均已解析；
- 安装后的适配器引用当前仓库；
- 数据库完整性通过；
- 已启用功能需要的软件路径存在；
- 所有相关计划任务不含旧仓库、旧用户目录或 `npm_global24` 固定路径。

最终运行验证必须从微信实际执行 `help`、`状态`、`查看计划`，并对提醒、英语统计或战利品 worker 至少进行一次不会重复投递的 dry-run。

## 测试

- 配置解析单元测试：缺失文件、损坏 JSON、字段优先级、自动发现、可选字段。
- 适配器测试：包含空格和非 ASCII 字符的任意仓库路径能生成正确文件 URI。
- Worker 静态策略测试：生产文件不得包含旧用户名、旧仓库绝对路径、固定 `npm_global24`、固定微信账号或目标会话。
- 安装器隔离测试：临时运行目录中生成的任务动作只引用新运行副本和本机配置。
- 现有 Node、Python 和 PowerShell 测试继续通过；与本次改动无关的既有失败单独记录，不得用来掩盖新增回归。

## 文档交付

`docs/new-computer-setup.md` 改为以下顺序：基础环境、数据库/OpenClaw 数据迁移、本机配置初始化、统一安装、Gateway 重启、健康检查、微信实测。文档列出哪些数据必须迁移、哪些只需重建、哪些明确不迁移，并提供每一步的验证命令。
