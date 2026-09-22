# MashiroBot Safety, Undo, and Diagnostics Design

## Scope

This design implements recommendations 10 through 15 on top of the shared control plane. Recommendation 9 was explicitly withdrawn in full on 2026-09-22. Existing credential fields, database storage, configuration locations, logging behavior, and cross-computer migration workflow remain unchanged.

## Architecture

Add focused core services rather than duplicating policy in plugins: an undo journal for explicitly reversible operations, a risk-policy helper, and an aggregate status/diagnostics service. Plugins register reversible actions and status providers but keep ownership of their business tables and recovery logic. Credentials remain wholly outside this change.

`撤销上一操作` selects the latest unexpired, unconsumed reversible operation in the current account/conversation scope. Initial adapters cover newly created plan versions, general reminders, English keywords, and active game timers. Deletes, force-closes, file moves, policy/Hosts/Clash changes, and other externally consequential actions are never labeled fully undoable; their replies direct the user to the existing recovery flow.

Habit reminders gain a per-day dismissal. Loot reminders run only at 21:15 and 21:50. Sleep reminders accept `今晚不再提醒` and `延迟30分钟`; wake-up alarms remain separate and cannot be dismissed through the sleep command.

Disk alerts use the most severe threshold crossed: ordinary below 20 GB, serious below 10 GB, and urgent below 5 GB. A more severe level bypasses the same-day suppression. Messages include free and total capacity plus percentage.

`自检` aggregates SQLite integrity/backups, gateway health, managed scheduled tasks, Hosts writability, browser policy accessibility, Clash configuration, protected-directory residue, pending executable recovery, orphan managed tasks, and credential hygiene. It reports `正常`, `异常`, or `未核验` per check and gives a concrete repair action without printing secrets or full sensitive paths.

Plugin-scoped aliases (`提醒帮助`, `游戏帮助`, `禁止帮助`, `英语帮助`) use the existing help renderer. `当前任务` aggregates today's plan, active reminders, active game timers, temporary releases, and tonight's sleep state, clearly marking unavailable providers instead of inventing data.

Risk policy has three levels: low risk executes directly; medium risk executes and registers an undo entry when a true inverse exists; high risk creates an action-bound, ten-minute confirmation with impact text. Permanent/broad blocking, destructive rule deletion, and executable-moving protection are high risk. Temporary narrow site blocking is low risk.

## Safety and compatibility

- Diagnostics must avoid unrestricted local paths.
- Undo is transactional and single-use; a failed inverse remains retryable with a sanitized error.
- Existing commands remain valid.
- Tests must not send WeChat messages, terminate applications, edit real policy/Hosts/Clash files, move real executables, or alter live credentials.

## Verification

Unit tests cover undo selection/expiry/single-use, risk classification, reminder dismissal, disk escalation, diagnostics output, help aliases, and aggregate current-task rendering. Regression tests cover the full Node suite and PowerShell dry runs. Deployment verification reads back task triggers, checks SQLite integrity, runs `自检`, and invokes command routes with side effects stubbed.
