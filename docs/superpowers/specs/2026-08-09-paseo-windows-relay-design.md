# Paseo Windows 外网手机连接设计

## 目标

修复 Paseo 在 Windows 上因默认端口冲突不断重启 Node worker、反复弹出 CMD 窗口的问题，并通过 Paseo 官方端到端加密 relay，让手机离开家庭网络后仍能控制本机 Codex。

本次只配置 Paseo、Codex provider、手机配对和后台自启动，不修改 MashiroBot/OpenClaw 微信机器人。

## 已确认现状

- 已安装 `@getpaseo/cli@0.3.0`。
- 已安装 `codex-cli 0.146.0`，命令位于现有用户 PATH。
- Paseo 配置位于 `C:\Users\Mashiroyes\.paseo\config.json`。
- 默认监听地址为 `127.0.0.1:6767`。
- Windows 将 TCP 端口段 `6755-6854` 标记为排除范围，因此 Paseo 监听 6767 时返回 `EACCES`。
- Paseo daemon runner 会在 worker 监听失败后持续重启，造成 CMD 窗口反复出现。

## 方案

### 本地监听

将 `daemon.listen` 改为 `127.0.0.1:6867`。修改前再次确认 6867 不在 Windows 排除端口范围内且没有进程监听。

daemon 继续仅绑定回环地址，不监听 `0.0.0.0`，不创建公网端口映射，也不增加 Windows 防火墙入站规则。

### 外网连接

将 `daemon.relay.enabled` 设置为 `true`。Paseo daemon 主动连接官方 relay，手机通过一次性配对二维码或链接建立端到端加密连接。

配对二维码和链接视同密码，只在本机交互窗口中展示，不写入项目文件、日志、聊天回复或截图。

### Codex provider

Paseo 复用当前用户 PATH 中的 Codex CLI 以及现有 Codex 登录状态，不复制、不导出 `auth.json`，也不把令牌写入 Paseo 配置。

先执行只读 provider 检查，再运行一个无文件写入的最小 Codex 回答测试。只有该测试成功，才认为 Paseo 到 Codex 的调用链已建立。

### 自动启动

在交互启动、配对和 Codex 测试都通过后，创建一个当前用户登录时触发的 Windows 计划任务：

- 使用当前用户身份运行，以便读取该用户的 Codex 登录和 PATH。
- 隐藏窗口启动 Paseo daemon，避免 CMD 弹窗。
- 不使用 SYSTEM 身份。
- 不重复创建同名任务；已有同名任务时先核对动作和目标，再更新。

## 实施顺序

1. 确认故障重启父进程已经退出；若仍存在，只停止命令行明确指向 Paseo daemon 的进程。
2. 备份现有 `config.json`，保留密钥、客户端 ID 和其他 Paseo 状态。
3. 检查 6867 的占用和排除范围。
4. 修改监听端口并启用 relay。
5. 启动 daemon，确认进程稳定且日志不再出现 `EACCES` 或重启循环。
6. 检查 daemon 状态和 Codex provider。
7. 运行最小 Codex 任务并核对实际回复。
8. 在本机打开配对命令，由用户用 Paseo 手机 App 扫码。
9. 创建隐藏的登录自启动任务。
10. 重启 daemon 后复验本机连接。
11. 用户关闭手机 Wi-Fi，使用移动网络发起测试任务，确认外网端到端可用。

## 错误处理与恢复

- 配置修改失败：恢复备份，不启动 daemon。
- 6867 不可用：重新选择一个不在排除范围、未被监听的高位端口，并同步更新设计记录。
- daemon 仍崩溃：停止精确匹配 Paseo 的 runner，保留日志，避免再次进入无限重启。
- Codex provider 不可用：保持 Paseo daemon 可运行，但不重新登录或替换 Codex 凭据；先检查 PATH 和现有 Codex 登录。
- relay 配对失败：不改为公网开放端口，保留 localhost 监听并检查网络/relay 日志。
- 自动启动失败：删除或禁用本次创建的计划任务，不影响手动启动方式。

## 验收标准

- Paseo daemon 在 `127.0.0.1:6867` 稳定运行至少 30 秒。
- 日志中不再新增 `listen EACCES`、worker crash/restart 循环。
- 启动过程不反复弹出 CMD 窗口。
- Paseo 能识别并调用本机 Codex CLI，最小测试获得预期回复。
- 手机 App 完成 relay 配对。
- 手机关闭 Wi-Fi、仅使用移动网络时，仍能发送任务并收到回复。
- 重新登录 Windows 后，Paseo 以当前用户身份隐藏启动且上述能力仍可用。

