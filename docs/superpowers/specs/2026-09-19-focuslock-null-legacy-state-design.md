# FocusLock 空兼容状态自愈设计

## 问题

禁止名单 worker 在同步 Bilibili 临时解除时，会更新旧版 FocusLock 兼容状态文件。该文件目前被 NUL 字节填满，解析结果为 `$null`，随后 `Add-Member` 因 `InputObject` 为空而失败。数据库中的临时解除记录已保存，但系统规则没有同步。

## 边界

- 只修复旧版 FocusLock 兼容状态读取和本次损坏文件。
- Bilibili 临时解除按数据库记录同步。
- QQ 保持禁止；损坏状态恢复时采用 `QQReleased = false` 的安全默认值。
- 不改变 Clash 控制器、计划任务或其他站点的策略。

## 方案

worker 增加兼容状态构造与安全读取函数。文件缺失、空白、JSON 损坏或根对象为 `null` 时，重建一个可写的安全状态对象；随后沿用既有原子写入流程。修复现场文件前保留原始损坏副本，再部署 worker 并触发 SYSTEM 同步。

## 验证

- PowerShell worker 回归测试和 Node 禁止名单测试通过。
- SYSTEM 计划任务返回 0，`LastSync.ok = true` 且无待同步标记。
- Bilibili 临时解除生效并可经本机代理访问。
- QQ 的 hosts/Clash 禁止规则仍存在。
- 到期后由现有扫描任务恢复 Bilibili 禁止规则。
