# English Four-Skills Dashboard Design

## Goal

Extend `mashirobot-plugin-plan` so saved plans become a persistent planned-time dashboard for listening, speaking, reading, and writing. Manual queries and scheduled reports return a Python-rendered PNG containing a duration-share pie chart and one time-series panel for each skill.

## Classification and accounting

- Classify every active plan item independently from its title and derive its duration from `start_time` and `end_time`. Cross-midnight ranges are supported.
- A title belongs to at most one skill. Precedence is writing, speaking, listening, reading, so phrases such as `英语听力复述` are treated as speaking rather than double-counted.
- Default keywords:
  - listening: `听力`, `精听`, `泛听`, `听写`, `播客`, `podcast`
  - speaking: `口语`, `跟读`, `朗读`, `复述`, `对话`, `英语聊天`, `影子跟读`, `shadowing`
  - reading: `阅读`, `英文小说`, `哈利波特`, `harry potter`, `the new sun`, `the book of the new sun`
  - writing: `英语作文`, `英文作文`, `作文`, `日志`, `写作`, `日记`, `journal`, `essay`
  - Anki detection only: `anki`, `背单词`, `单词复习`
- Keywords live in a small JSON configuration file so later book names can be added without changing parser code.
- Every non-empty book name saved after `英文小说：` in a daily record is also persisted in `learned_english_reading_titles`. Learned names classify exact or embedded plan titles as reading, and migration backfills both names and matching historical plans.
- Anki minutes are not included in the four-skill pie denominator. They are retained in range summaries solely for imbalance detection.
- Saving a replacement plan revision must replace that day's effective classification rather than double-counting old revisions. The authoritative query joins skill entries to active `plan_items`.

## Persistence and queries

Add `english_skill_plan_entries`, keyed by `plan_item_id`, with the plan date, normalized skill, title, and duration. `save_plan` synchronizes it in the same SQLite transaction that activates the new revision and supersedes the old one.

Add a range query that returns:

- inclusive `fromDate` and `toDate`;
- day points for week/month reports and month points for year reports;
- totals for all four skills plus Anki;
- four-skill percentages (zero when no classified time exists);
- recorded English-plan day count;
- an imbalance warning when there are at least three English-plan days and reading plus Anki is at least 80% of all classified four-skill plus Anki minutes.

Manual commands accepted after whitespace normalization:

- `本周英语学习统计图` / `本周英语统计图`
- `这个月英语学习统计图` / `这个月英语统计图`
- `今年英语学习统计图` / `今年英语统计图`

The current period ends at today. The same parser also supports `上周`, `上个月`, and `去年` for scheduled-report reuse and diagnostics.

## Chart

Python and Pillow render one 1600 px-wide PNG. The top section contains a four-color pie chart, legend, exact duration, and percentage. Four stacked line panels show listening, speaking, reading, and writing over the period. Missing dates/months appear as zero so absence is visible. The footer shows the Anki total and, when triggered, a direct imbalance warning.

If chart generation fails, manual queries still return a textual total and the failure reason. Empty periods still render a valid zero-state chart.

## Automatic delivery

A hidden Windows worker runs every day at 11:00 Asia/Shanghai and determines all reports due that day:

- Monday: previous Monday through Sunday;
- first day of a month: previous calendar month;
- January 1: previous calendar year.

When dates coincide, all due reports are sent. A SQLite delivery table with a unique period key provides claim/send/fail state and prevents duplicate successful sends. Failed deliveries may be retried by the next worker run; successful deliveries are never sent twice.

The worker renders the chart, then uses the configured OpenClaw Weixin account and target to send a concise message with `--media`. Installation copies an immutable runtime under `%LOCALAPPDATA%\MashiroBot\english-skills\runtime-v1`, backs up the SQLite set before migration, registers one current-user scheduled task, and verifies the task XML, runtime hashes, database integrity, and a dry-run delivery.

## Testing and acceptance

- Unit tests cover keyword precedence, case-insensitive book matching, cross-midnight duration, plan revision replacement, week/month/year aggregation, percentages, zero-state data, and the 80% warning.
- Route tests prove both requested command variants return a real PNG.
- Chart tests inspect dimensions and all four series colors.
- Windows tests verify daily 11:00 registration, hidden launcher, `--media`, dry-run delivery, and idempotent claims.
- Existing plan, record, sleep, reminder, and wakeup suites remain green.
