# FocusLock 源码

本目录保存 FocusLock 的可迁移源码。`C:\ProgramData\CodexFocusLock` 只是本机运行时副本和状态目录，不是唯一源码。

主要文件：

- `FocusLock.ps1`：安装、重应用、扫描、移除和状态检查。
- `Release-BilibiliTemporarily.ps1`、`Restore-BilibiliBlock.ps1`：旧版 Bilibili 临时解除兼容入口。
- `Release-BilibiliQQ.ps1`、`Restore-QQWebsiteBlock.ps1`：旧版联合/QQ 恢复入口。
- 其他脚本：HAnime 与浏览器策略的维护工具。

换电脑后，在管理员 PowerShell 7 中从仓库根目录执行：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\focus-lock\FocusLock.ps1 -Mode Install
```

安装后检查：

```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File .\focus-lock\FocusLock.ps1 -Mode Status
```

MashiroBot 的禁止名单插件会把自己的 worker 部署到 ProgramData，并通过插件内的 `bilibili-qq-expiry.default.json` 恢复旧版兼容状态。运行时状态、隔离区、计划任务和本机软件路径不能直接由 Git 恢复，需在新电脑重新安装并重新选择软件路径。
