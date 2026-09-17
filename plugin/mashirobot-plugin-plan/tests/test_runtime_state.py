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
CLI = PLUGIN_ROOT / "planner" / "planner.py"
PLUGIN_ID = "mashirobot-plugin-plan"


def encode_payload(value: Any) -> str:
    raw = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return base64.b64encode(raw).decode("ascii")


class RuntimeStateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.db = Path(self.temp.name) / "planner.sqlite"

    def tearDown(self) -> None:
        self.temp.cleanup()

    def cli(self, *args: str, expect_ok: bool = True):
        env = os.environ.copy()
        env["OPENCLAW_PLANNER_DB_PATH"] = str(self.db)
        result = subprocess.run(
            [sys.executable, str(CLI), *args],
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

    def test_round_trip_update_and_delete_state_json(self) -> None:
        initial = {"phase": "sleep", "routineDate": "2026-08-02", "attempts": 2}
        saved = self.cli(
            "set-plugin-state",
            "--plugin-id", PLUGIN_ID,
            "--state-key", "night:2026-08-02",
            "--payload-base64", encode_payload(initial),
        )
        self.assertEqual(saved["value"], initial)

        read = self.cli(
            "get-plugin-state",
            "--plugin-id", PLUGIN_ID,
            "--state-key", "night:2026-08-02",
        )
        self.assertTrue(read["found"])
        self.assertEqual(read["value"], initial)

        replacement = {"phase": "done", "routineDate": "2026-08-02", "attempts": 3}
        updated = self.cli(
            "set-plugin-state",
            "--plugin-id", PLUGIN_ID,
            "--state-key", "night:2026-08-02",
            "--payload-base64", encode_payload(replacement),
        )
        self.assertEqual(updated["value"], replacement)

        deleted = self.cli(
            "delete-plugin-state",
            "--plugin-id", PLUGIN_ID,
            "--state-key", "night:2026-08-02",
        )
        self.assertTrue(deleted["deleted"])
        missing = self.cli(
            "get-plugin-state",
            "--plugin-id", PLUGIN_ID,
            "--state-key", "night:2026-08-02",
        )
        self.assertFalse(missing["found"])
        self.assertIsNone(missing["value"])

    def test_wakeup_and_disk_keys_are_stored_without_special_files(self) -> None:
        values = {
            "wakeup:active": {"scheduledAt": "2026-08-04T07:00:00+08:00", "active": True},
            "disk-space:20gb": {"notified": ["C:"]},
        }
        for state_key, value in values.items():
            self.cli(
                "set-plugin-state",
                "--plugin-id", PLUGIN_ID,
                "--state-key", state_key,
                "--payload-base64", encode_payload(value),
            )

        with closing(sqlite3.connect(self.db)) as db:
            rows = db.execute(
                "SELECT plugin_id,state_key,value_json FROM plugin_runtime_state ORDER BY state_key"
            ).fetchall()
            columns = [
                (row[1], row[2], row[3], row[5])
                for row in db.execute("PRAGMA table_info(plugin_runtime_state)")
            ]
        self.assertEqual([row[1] for row in rows], ["disk-space:20gb", "wakeup:active"])
        self.assertTrue(all(row[0] == PLUGIN_ID for row in rows))
        self.assertEqual({row[1]: json.loads(row[2]) for row in rows}, values)
        self.assertEqual(
            columns,
            [
                ("plugin_id", "TEXT", 1, 1),
                ("state_key", "TEXT", 1, 2),
                ("value_json", "TEXT", 1, 0),
                ("updated_at", "TEXT", 1, 0),
            ],
        )

    def test_malformed_json_and_missing_identifiers_are_rejected(self) -> None:
        malformed = base64.b64encode(b'{"active":').decode("ascii")
        result = self.cli(
            "set-plugin-state",
            "--plugin-id", PLUGIN_ID,
            "--state-key", "wakeup:active",
            "--payload-base64", malformed,
            expect_ok=False,
        )
        self.assertNotEqual(result.returncode, 0)

        missing_plugin = self.cli(
            "get-plugin-state",
            "--plugin-id", "",
            "--state-key", "wakeup:active",
            expect_ok=False,
        )
        self.assertNotEqual(missing_plugin.returncode, 0)
        self.assertIn("plugin-id is required", missing_plugin.stderr)

        missing_key = self.cli(
            "get-plugin-state",
            "--plugin-id", PLUGIN_ID,
            "--state-key", "",
            expect_ok=False,
        )
        self.assertNotEqual(missing_key.returncode, 0)
        self.assertIn("state-key is required", missing_key.stderr)


if __name__ == "__main__":
    unittest.main(verbosity=2)
