# Plan 手机端工具

## QQ / TIM 永久封禁

源码位于 [`qq-guard`](qq-guard/README.md)。当前策略是：保留应用和数据，但始终停用 QQ、TIM、已识别变体及多用户/双开副本；守护进程会纠正手动启用，并维护 QQ 官网 hosts 封禁及下载目录 APK 清理。

旧的 `玩QQN分钟` 入口仍保留，用于返回明确的永久封禁提示；它不会启用或启动 QQ。只有显式执行 `qq-phone uninstall` 才会停止本工具并按安装前记录恢复应用启用状态。

## 部署文件

- `plan-mobile-qq-guard.zip`：由 `qq-guard/package.py` 从当前源码生成的复现包。
- `deploy-phone.sh`：首次安装。
- `upgrade-phone.sh`：保留手机状态并升级现有安装。
- `test-phone.sh`：手机端隔离测试。
- `run-verify-phone.sh` / `verify-phone.py`：真机验收。

电脑侧修改后必须先运行完整测试并重新生成 ZIP，再通过升级脚本部署。不要把手机上的运行副本反向覆盖项目源码。

