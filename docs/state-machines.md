# MashiroBot 状态机

## Managed reminder

```text
pending -> sending -> sent -> acknowledged
                   -> acknowledged  (无需确认)
        -> cancelled
sending -> failed -> pending        (显式重试或重复提醒)
sent    -> pending                   (需要持续提醒且再次到期)
```

只有 `pending` 且已到期的提醒可被领取。暂停和静默阻止普通提醒领取，但不阻止 wakeup。短编号只用于仍等待确认的提醒。确认先更新核心提醒状态，再调用来源插件的确认处理器清理其业务记录和 Windows Task；清理失败返回 `cleanupPending`，不伪装成功。

## Managed job

```text
desired -> running -> completed
                   -> failed
running -> desired                  (周期任务成功或过期 claim 恢复)
desired/running/failed -> cancelled (version + 1)
```

Worker 只有在 `job_id + version` 完全匹配且状态为 `desired` 时才能 claim。旧版本、已取消或已完成任务不得产生副作用。SQLite 保存 desired state；Windows Task 只是 observed projection。

## Reconciliation

```text
desired + missing task  -> create/update attempt
desired + drifted task  -> recreate attempt
no desired + managed task -> delete attempt
matching task           -> no-op
failed projection       -> keep desired state and retry later
```

`Inspect` 只比较状态，不恢复 claim、不创建、不更新、不删除。`Apply` 才允许恢复过期 claim 和修复投影。对相同状态连续运行两次时，第二次不得产生额外修改。

## Plan reminder

计划项目保存后生成新 revision 和对应 item。任务版本由 managed job 固定；计划更新或取消使旧版本失效。Worker 先 claim managed job，再读取当前计划项目，发送成功后 complete；数据库或发送失败记录 failed，不能把失败当作已发送。

## Wake-up reminder

```text
scheduled -> active -> acknowledged
                    -> failed -> active (下次重试)
active -> cancelled
```

起床提醒允许唤醒电脑，并持续到“已起床”。音乐、音量或微信某一步失败必须记录，但不能绕过 job version 或伪造整体成功。系统睡眠或网关离线后的触发由 `StartWhenAvailable`、周期重试和 managed job claim 共同去重。

## Game timer

```text
pending -> reminded -> force_due -> closed
        -> cancelled (version + 1)
        -> failed
```

提醒和强退任务携带同一业务任务 ID、各自 managed job ID 和当前 version。提前退出不等于插件强退；只有实际完成强退和文件保护后才能记录对应副作用。取消或延长计时必须增加 version，使旧 Windows Task 自动失效。

## 版本与补跑原则

- 创建逻辑任务从 version 1 开始；修改、取消或重新计划时增加 version。
- Windows 睡眠恢复后的补跑仍必须先 claim 当前 version。
- 网关离线导致的发送失败保留可重试状态；一次具体 delivery 成功后不得因 Worker 重启再次产生同一副作用。
- 所有终态必须来源于可验证的数据库或执行结果，不能根据模型回复推断。
