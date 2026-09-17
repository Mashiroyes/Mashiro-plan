# 财报任务低频调度与隐藏启动 Implementation Plan

**Goal:** 降低财报任务检查频率并消除计划任务闪窗。

1. 添加通用 run-worker.vbs，接收 PowerShell、worker、runtime、SQLite 和课程类型参数，隐藏等待 worker 完成。
2. 修改安装器：三个任务改用 wscript.exe；财报使用每日 12:30、18:30 两个无重复触发器；点评使用 30 分钟重复；招股书保留周二、周五 18:10。
3. 更新 Windows 边界和隔离安装测试。
4. 正式安装，手动运行无待处理的点评任务，并核对 SQLite、任务动作、触发器和 source/runtime 哈希。
