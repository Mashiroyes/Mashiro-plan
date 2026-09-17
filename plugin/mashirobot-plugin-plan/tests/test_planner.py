from __future__ import annotations

import base64
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from typing import Any


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
NEW_CLI = PLUGIN_ROOT / "planner" / "planner.py"
OLD_CLI = Path(__file__).resolve().parents[3] / "script" / "planner" / "planner.py"


def encode_payload(value: Any) -> str:
    raw = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return base64.b64encode(raw).decode("ascii")


def run_json(
    cli: Path,
    command: list[str],
    db_path: Path,
    *,
    expect_ok: bool = True,
) -> dict[str, Any] | subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    env["OPENCLAW_PLANNER_DB_PATH"] = str(db_path)
    result = subprocess.run(
        [sys.executable, str(cli), *command],
        env=env,
        text=True,
        encoding="utf-8",
        capture_output=True,
        check=False,
    )
    if not expect_ok:
        return result
    if result.returncode != 0:
        raise AssertionError(f"command failed ({result.returncode}): {result.stderr}\n{result.stdout}")
    return json.loads(result.stdout)


class PluginPlannerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.db = self.root / "planner.sqlite"

    def tearDown(self) -> None:
        self.temp.cleanup()

    def cli(self, *args: str, expect_ok: bool = True):
        return run_json(NEW_CLI, list(args), self.db, expect_ok=expect_ok)

    def test_past_items_are_completed_and_future_items_are_scheduled(self) -> None:
        past = {
            "date": "2020-01-01",
            "rawText": "计划\n00:00 - 01:00 睡觉",
            "items": [{"startTime": "00:00", "endTime": "01:00", "title": "睡觉"}],
        }
        past_result = self.cli("save-plan", "--payload-base64", encode_payload(past))
        self.assertEqual(past_result["items"][0]["actualStatus"], "completed")
        self.assertEqual(past_result["items"][0]["reminderStatus"], "completed")
        self.assertEqual(past_result["items"][0]["deliveryMode"], "skip")

        future = {
            "date": "2099-01-01",
            "rawText": "计划\n09:00 - 10:00 背单词",
            "items": [{"startTime": "09:00", "endTime": "10:00", "title": "背单词"}],
        }
        future_result = self.cli("save-plan", "--payload-base64", encode_payload(future))
        self.assertEqual(future_result["items"][0]["actualStatus"], "unknown")
        self.assertEqual(future_result["items"][0]["reminderStatus"], "pending")
        self.assertEqual(future_result["items"][0]["deliveryMode"], "schedule")

    def test_sleep_routine_date_uses_six_am_boundary_and_last_value(self) -> None:
        first = self.cli(
            "record-sleep",
            "--date", "2026-08-01",
            "--slept-at", "2026-08-03T02:10:18+08:00",
        )
        self.assertEqual(first["routineDate"], "2026-08-02")

        replacement = self.cli(
            "record-sleep",
            "--date", "2026-07-01",
            "--slept-at", "2026-08-03T05:59:59+08:00",
        )
        self.assertEqual(replacement["routineDate"], "2026-08-02")

        morning = self.cli(
            "record-sleep",
            "--date", "2026-07-01",
            "--slept-at", "2026-08-03T06:00:00+08:00",
        )
        self.assertEqual(morning["routineDate"], "2026-08-03")

        rows = self.cli("query-sleep", "--from", "2026-08-02", "--to", "2026-08-03")
        self.assertEqual(
            [(row["routine_date"], row["slept_at"]) for row in rows["rows"]],
            [
                ("2026-08-02", "2026-08-03T05:59:59+08:00"),
                ("2026-08-03", "2026-08-03T06:00:00+08:00"),
            ],
        )

    def test_repair_sleep_routine_dates_keeps_latest_conflicting_sleep(self) -> None:
        self.cli("init")
        with closing(sqlite3.connect(self.db)) as db:
            with db:
                db.executemany(
                    "INSERT INTO sleep_events(routine_date,slept_at,updated_at) VALUES(?,?,?)",
                    [
                        ("2026-08-01", "2026-08-03T02:10:18+08:00", "2026-08-03T02:10:18+08:00"),
                        ("2026-08-02", "2026-08-02T22:00:00+08:00", "2026-08-02T22:00:00+08:00"),
                        ("2026-08-03", "2026-08-03T22:10:00+08:00", "2026-08-03T22:10:00+08:00"),
                    ],
                )
        repaired = self.cli("repair-sleep-routine-dates")
        self.assertEqual(repaired["moved"], 1)
        self.assertEqual(repaired["conflicts"], 1)
        self.assertEqual(repaired["unchanged"], 1)
        self.assertEqual(
            [(row["routine_date"], row["slept_at"]) for row in repaired["rows"]],
            [
                ("2026-08-02", "2026-08-03T02:10:18+08:00"),
                ("2026-08-03", "2026-08-03T22:10:00+08:00"),
            ],
        )

    def test_daily_record_overwrites_and_rejects_invalid_values(self) -> None:
        first = {
            "date": "2026-08-01",
            "studyMinutes": 60,
            "entertainmentMinutes": 30,
            "other": [{"name": "ChatGPT", "minutes": 15}],
            "readingTitle": "哈利波特",
            "readingWords": 1000,
            "rawText": "第一次",
        }
        second = {
            **first,
            "studyMinutes": 90,
            "readingTitle": "The Book of the New Sun",
            "readingWords": 1500,
            "rawText": "覆盖",
        }
        self.cli("save-daily-record", "--payload-base64", encode_payload(first))
        self.cli("save-daily-record", "--payload-base64", encode_payload(second))
        result = self.cli("query-daily-record", "--date", "2026-08-01")
        self.assertEqual(result["row"]["study_minutes"], 90)
        self.assertEqual(result["row"]["reading_title"], "The Book of the New Sun")

        for field, value in (
            ("studyMinutes", 1.5),
            ("entertainmentMinutes", -1),
            ("readingStartPos", -3),
        ):
            invalid = self.cli(
                "save-daily-record",
                "--payload-base64", encode_payload({"date": "2026-08-01", field: value}),
                expect_ok=False,
            )
            self.assertNotEqual(invalid.returncode, 0)
            self.assertIn("non-negative integer", invalid.stderr)

    def test_daily_record_aggregation_preserves_day_and_month_shapes(self) -> None:
        records = [
            {
                "date": "2026-07-31",
                "studyMinutes": 120,
                "entertainmentMinutes": 60,
                "other": [{"name": "ChatGPT", "minutes": "30"}],
                "readingTitle": "哈利波特",
                "readingWords": 1200,
                "rawText": "记录一",
            },
            {
                "date": "2026-08-01",
                "studyMinutes": 90,
                "entertainmentMinutes": 45,
                "other": [{"name": "杂事", "minutes": 15.5}],
                "readingTitle": "The Book of the New Sun",
                "readingWords": 800,
                "rawText": "记录二",
            },
        ]
        for record in records:
            self.cli("save-daily-record", "--payload-base64", encode_payload(record))
        self.cli("record-sleep", "--date", "2026-07-31", "--slept-at", "2026-08-01T01:30:00+08:00")
        self.cli("record-sleep", "--date", "2026-08-01", "--slept-at", "2026-08-02T02:15:00+08:00")

        daily = self.cli(
            "query-record-range",
            "--from", "2026-07-30",
            "--to", "2026-08-02",
            "--granularity", "day",
        )
        self.assertEqual(
            daily["totals"],
            {
                "studyMinutes": 210,
                "entertainmentMinutes": 105,
                "otherMinutes": 45.5,
                "readingWords": 2000,
            },
        )
        self.assertEqual(daily["recordedDays"], 2)
        self.assertEqual(daily["sleepDays"], 2)
        self.assertEqual(len(daily["points"]), 4)

        monthly = self.cli(
            "query-record-range",
            "--from", "2026-07-30",
            "--to", "2026-08-02",
            "--granularity", "month",
        )
        self.assertEqual([point["label"] for point in monthly["points"]], ["2026-07", "2026-08"])
        self.assertEqual(monthly["totals"], daily["totals"])

    def test_general_reminder_lifecycle_remains_compatible(self) -> None:
        created = self.cli(
            "create-general-reminder",
            "--payload-base64",
            encode_payload({"content": "开会", "scheduledAt": "2099-08-03T12:05:00+08:00"}),
        )
        self.assertEqual(created["status"], "active")
        prepared = self.cli("prepare-general-reminder", "--reminder-id", created["id"])
        self.assertTrue(prepared["shouldSend"])
        finished = self.cli(
            "finish-general-reminder",
            "--reminder-id", created["id"],
            "--status", "sent",
        )
        self.assertEqual(finished["status"], "active")
        acknowledged = self.cli("ack-latest-general-reminder")
        self.assertTrue(acknowledged["found"])
        self.assertEqual(acknowledged["id"], created["id"])

    def test_old_and_new_read_only_queries_match_on_copied_database(self) -> None:
        if not OLD_CLI.exists():
            self.skipTest("legacy planner CLI was removed after the verified cutover")
        source = self.root / "source.sqlite"
        plan = {
            "date": "2099-08-01",
            "rawText": "计划\n09:00 - 10:00 背单词",
            "items": [{"startTime": "09:00", "endTime": "10:00", "title": "背单词"}],
        }
        record = {
            "date": "2026-08-01",
            "studyMinutes": 90,
            "entertainmentMinutes": 45,
            "other": [{"name": "杂事", "minutes": 15}],
            "readingTitle": "The Book of the New Sun",
            "readingWords": 800,
            "rawText": "记录",
        }
        run_json(OLD_CLI, ["save-plan", "--payload-base64", encode_payload(plan)], source)
        run_json(OLD_CLI, ["save-daily-record", "--payload-base64", encode_payload(record)], source)
        run_json(
            OLD_CLI,
            ["record-sleep", "--date", "2026-08-01", "--slept-at", "2026-08-02T02:15:00+08:00"],
            source,
        )

        old_db = self.root / "old.sqlite"
        new_db = self.root / "new.sqlite"
        with closing(sqlite3.connect(source)) as source_db:
            with closing(sqlite3.connect(old_db)) as target:
                source_db.backup(target)
            with closing(sqlite3.connect(new_db)) as target:
                source_db.backup(target)

        commands = [
            ["query-date", "--date", "2099-08-01"],
            ["query-sleep", "--from", "2026-08-01", "--to", "2026-08-02"],
            ["query-record-range", "--from", "2026-08-01", "--to", "2026-08-02", "--granularity", "day"],
        ]
        for command in commands:
            with self.subTest(command=command[0]):
                old = run_json(OLD_CLI, command, old_db)
                new = run_json(NEW_CLI, command, new_db)
                self.assertEqual(old, new)

        with closing(sqlite3.connect(new_db)) as db:
            table = db.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name='plugin_runtime_state'"
            ).fetchone()
        self.assertIsNotNone(table)


if __name__ == "__main__":
    unittest.main(verbosity=2)
