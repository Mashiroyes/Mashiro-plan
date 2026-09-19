# FocusLock 空兼容状态自愈实施计划

1. 在 worker 测试中加入损坏或 `null` 兼容状态必须安全恢复、且 QQ 默认不放行的断言，并先确认测试失败。
2. 在插件目录加入默认兼容状态模板，由安装器随 worker 部署；在 `BlockWorker.ps1` 中实现安全状态构造与读取，把 `Set-LegacyBilibiliDelegation` 改为使用该入口。
3. 运行 PowerShell 与 Node 测试，确认回归通过。
4. 备份并修复 ProgramData 下的损坏状态文件，部署新版 worker，触发 SYSTEM 重同步。
5. 核验同步状态、Bilibili 访问、QQ 禁止规则和到期恢复路径。
6. 提交并推送本次源码、测试与文档改动；保留用户已有的无关修改。
7. 审计项目外脚本引用，把 FocusLock 源码迁入仓库并记录不可随 Git 迁移的运行时、数据库和第三方依赖。
