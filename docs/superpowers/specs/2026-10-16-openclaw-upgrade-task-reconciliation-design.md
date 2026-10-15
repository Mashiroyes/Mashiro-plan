# OpenClaw 升级后任务同步兼容修复设计

## 目标

修复 OpenClaw 与微信插件升级后 MashiroBot 启动时的 Windows 任务同步异常，使本地指令继续可用，且启动状态不再因为旧任务数据或英语统计任务的隐藏启动器而错误降级。

## 已确认的问题

1. `job-reconcile.ps1` 在严格模式下直接访问可选的 `payload.reconcile`。旧格式计划任务没有该字段，Apply 模式因此抛错。
2. 英语周报和年报实际通过 `wscript.exe + run-hidden-worker.vbs` 启动，但数据库的 `payload.execution` 记录为直接调用 `pwsh.exe`。同步器永久把正常任务判定为漂移。
3. 一个 2026-09-22 的一次性计划提醒仍处于 `desired`，虽然执行时间早已过去且任务已不存在，启动同步仍尝试重建它。

## 方案

### 旧字段兼容

在 PowerShell 中通过 `PSObject.Properties` 判断 `payload.reconcile` 是否存在且非空。存在时调用专用安装器；不存在时继续使用通用 `payload.execution` 分支。不得修改历史任务 JSON 才能读取。

### 动作一致性

英语统计安装器写入 `managed_jobs.payload.execution` 时，记录与实际计划任务完全一致的动作：`wscript.exe` 及隐藏启动器参数。`payload.reconcile` 继续保留，用于真正缺失或漂移时重建完整的日、周、月、年任务组。

同步器比较动作时沿用精确比较，不为英语插件加入特殊例外。数据源和实际任务一致后，其他插件仍能从漂移检查中获益。

### 过期一次性任务

在任务管理层区分周期任务和一次性任务。列表同步前，把执行时间已过、仍为 `desired`/`running`、且没有 recurrence 的一次性任务标记为失败或取消，不再投影到 Windows 计划任务。周期任务不受影响。

已有的 stale-running 恢复仍先执行；过期判断使用当前时间并保留错误说明，避免静默删除历史证据。

## 数据与部署

- 修改代码后先备份 SQLite。
- 运行一次受控清理，将已过期的一次性任务退出 `desired` 状态。
- 将英语统计任务的期望动作更新为当前已验证的隐藏启动器动作；不重建当前运行正常的计划任务。
- 不改动用户现有的 QQ、FocusLock 或其他未提交修改。

## 验证

1. 新增旧 payload 无 `reconcile` 时 Apply 不崩溃的回归测试。
2. 新增隐藏启动器动作写入和无误报漂移测试。
3. 新增过期一次性任务不参与同步、周期任务仍参与同步的测试。
4. 运行相关 Node 与 PowerShell 测试。
5. 实机 Inspect 必须得到 `missing=[]`、`drifted=[]`、`failed=[]`。
6. 重启网关后 MashiroBot 启动状态必须为 `ready`，网关健康检查为 OK。
7. 微信端验证至少覆盖：纯本地帮助、Python 查询、PowerShell 提醒、状态图片，并确认返回成功而非 `The local process exited unsuccessfully`。

## 错误处理与回滚

- 数据修复前生成数据库备份；失败时恢复备份，不删除历史记录。
- 代码兼容路径对新旧 payload 都有效。
- 英语任务只更新数据库期望动作；若实际任务与已读取的动作不一致，则停止并报告，不猜测覆盖。
- 微信端验证前保持网关健康；任何一类命令失败都视为未完成。
