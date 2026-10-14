# Plan 手机 QQ 永久封禁

该工具运行在 Root Android + Termux 上。它保留 QQ 安装和应用数据，但始终停用 QQ、TIM、已识别变体以及多用户/双开副本。

## 当前行为

| 项目 | 行为 |
|---|---|
| QQ / TIM | 始终停用并强制停止 |
| `玩QQN分钟` | 保留兼容入口，但固定拒绝，不启用、不启动 |
| 手动重新启用 | 后台约 30 秒内再次停用；状态/自检会立即处理 |
| QQ 官网 | hosts 封禁持续维护 |
| 下载目录安装包 | 约每 60 秒扫描已识别的 QQ/TIM 安装包 |
| 重启 | Magisk/Root 开机服务重新启动监督与守护进程 |
| 卸载限制 | 仅显式 `qq-phone uninstall`，按安装前记录恢复 |

`ready` 状态表示“永久封禁运行正常”，不是“可以临时启用”。旧版本留下的游玩或冷却状态在首次对账时立即失效。

## 常用命令

```bash
qq-phone status
qq-phone doctor
qq-phone start
qq-phone recover
```

旧命令仍可输入，但只会收到拒绝提示：

```bash
玩QQ10分钟
# 手机 QQ 已永久禁止访问，不能临时启用
```

如确实要完全撤销本工具：

```bash
qq-phone uninstall
```

这会停止后台、撤销本工具的 hosts 挂载，并根据安装时记录恢复 QQ/TIM 的启用状态；不会卸载 QQ 或删除应用数据。

## 新手机首次部署

1. 手机安装 Termux、Python，并取得可用 Root。
2. 将 `plan-mobile-qq-guard.zip` 与 `deploy-phone.sh` 放入 `/sdcard/Download/`。
3. 在 Termux 中执行：

```bash
bash /sdcard/Download/deploy-phone.sh
```

4. 执行 `qq-phone doctor`，确认后台、QQ 停用和官网封禁均正常。

## 已安装手机升级

把最新 ZIP、部署脚本、测试和验收文件推送到 `/sdcard/Download/`，然后执行：

```bash
bash /sdcard/Download/plan-qq-upgrade.sh
```

升级脚本会停止本工具旧进程、安装新副本、运行手机测试并重新启动守护进程。项目目录是源码真相源，不要用手机运行副本覆盖项目。

## 文件说明

| 文件 | 用途 |
|---|---|
| `model.py` | 状态校验、旧命令解析和永久拒绝策略 |
| `guard.py` | Root 控制器、守护循环、状态与自检 |
| `android.py` | Android 包停用、进程停止、hosts 和唤醒锁适配 |
| `policy.py` | QQ/TIM 包名识别 |
| `apk.py` | 下载目录安装包识别与清理 |
| `cli.py` | Termux 命令入口 |
| `install.sh` / `root-entry.sh` | 安装及固定 Root 入口 |
| `tests/test_guard.py` | 隔离回归测试 |

## 验证

电脑侧：

```powershell
python -B -m unittest discover -s mobile/qq-guard/tests -v
python -B mobile/qq-guard/package.py
```

部署后必须在真机确认：QQ 仍安装但处于 disabled、无 QQ 进程、旧游玩命令拒绝后仍 disabled、doctor 全部健康、开机服务入口存在。具体清单见 [`VALIDATION.md`](VALIDATION.md)。

