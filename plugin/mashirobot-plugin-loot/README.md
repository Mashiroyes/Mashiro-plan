# MashiroBot 战利品插件

`mashirobot-plugin-loot` 固定使用菜单编号 **4**，只负责保存每天最后一次「爽点」并在次日回放。

## 微信输入

```text
爽点
今天真实完成的内容，可以自由换行。
```

首行必须精确等于 `爽点`。正文不能为空；同一上海自然日多次发送时，最后一次完整内容覆盖前一次。

## 提醒

- 21:00 至 22:00：当天尚未记录时每 10 分钟提醒一次，22:00 后停止。
- 次日 10:00：前一天有记录时发送固定前缀、日期和原始正文；没有记录时静默。

插件不提供固定任务类别、通用笔记、积分、等级、排行榜或 AI 改写。

## 数据与运行

数据表为 `loot_entries`，位于 `plan/sqlite/openclaw-planner.sqlite`。计划任务使用 `%LOCALAPPDATA%\MashiroBot\loot\runtime-v1` 的稳定运行副本。

## 测试

```powershell
node --test plan/plugin/mashirobot-plugin-loot/tests/*.test.mjs
pwsh -NoProfile -File plan/plugin/mashirobot-plugin-loot/tests/test-windows.ps1
```
