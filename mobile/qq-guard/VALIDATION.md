# 验收要求

当前版本的验收标准：

1. 电脑与手机端隔离测试全部通过。
2. 真机仍能列出 `com.tencent.mobileqq`，证明未卸载。
3. 主用户 QQ 处于 disabled，QQ 进程不存在。
4. 执行 `玩QQ1分钟` 或 root `play 1` 返回永久封禁错误，之后仍为 disabled 且无 QQ 进程。
5. 旧的 playing/cooldown 状态会被清除为 ready，且不会产生放行。
6. `doctor` 报告 `permanent_block=true`、`daemon_healthy=true`、`qq_disabled=true`、`website_block=true`。
7. Root 守护进程、监督进程和 `/data/adb/service.d/plan-qq-guard.sh` 开机入口存在。

电脑模拟测试不能替代上述真机检查。部署后应保留升级日志、测试日志和 doctor 输出作为证据。

