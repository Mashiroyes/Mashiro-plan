# English Skills Calendar Triggers Design

## Goal

Replace the English dashboard's daily 11:00 polling task with three direct Windows calendar triggers. No process should start on ordinary days merely to discover that no report is due.

## Selected design

Register three current-user scheduled tasks, all at 11:00 Asia/Shanghai:

- `MashiroBot English Skills Weekly`: every Monday, passing `-PeriodType week`;
- `MashiroBot English Skills Monthly`: day 1 of every month, passing `-PeriodType month`;
- `MashiroBot English Skills Yearly`: January 1 every year, passing `-PeriodType year`.

The worker calculates the most recently completed matching period from the execution date. This makes `StartWhenAvailable` safe: a missed Monday task that starts Tuesday still calculates the previous Monday-Sunday; a delayed monthly or yearly task still calculates the previous calendar month or year.

The existing SQLite delivery keys remain unchanged, so reinstalling tasks cannot resend a successfully delivered period. When several triggers coincide, their distinct period keys allow all required charts to be sent.

## Migration and rollback

Installation first registers and validates all three new tasks. Only after all three pass verification does it unregister the legacy `MashiroBot English Skills Dashboard` daily task. `Inspect` reports the three tasks and whether the legacy task remains. `Uninstall` removes the three calendar tasks and the legacy daily task while preserving the runtime and SQLite data.

## Verification

- Worker tests cover Monday and Tuesday catch-up for a weekly period, day-1 and day-2 catch-up for a monthly period, and January 1/2 catch-up for a yearly period.
- Installer tests inspect native trigger classes and exact action arguments: weekly, monthly-all-months, yearly-January, each at 11:00 and each with its own `-PeriodType`.
- A formal install must prove the old daily task is absent, all new tasks are `Ready`, manual starts return result 0, the installed runtime matches source, and SQLite integrity remains `ok`.

