from __future__ import annotations

import base64
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from PIL import Image


SCRIPT_ROOT = Path(__file__).resolve().parents[1]
PYTHON = Path(r"C:\Users\Mashiroyes\AppData\Local\Python\pythoncore-3.14-64\python.exe")
CLI = SCRIPT_ROOT / "planner" / "planner.py"
EXPECTED_COLORS = {"#2563EB", "#F97316", "#9333EA", "#16A34A", "#DC2626"}


class ChartTests(unittest.TestCase):
    def test_chart_dimensions_and_series_colors(self) -> None:
        payload = {
            "fromDate": "2026-07-27",
            "toDate": "2026-08-02",
            "points": [
                {"label": "2026-07-27", "studyMinutes": 120, "entertainmentMinutes": 30, "otherMinutes": 15, "readingWords": 1000, "sleepMinutes": 1510},
                {"label": "2026-07-28", "studyMinutes": 180, "entertainmentMinutes": 60, "otherMinutes": 45, "readingWords": 2500, "sleepMinutes": 1570},
                {"label": "2026-07-29", "studyMinutes": 90, "entertainmentMinutes": 300, "otherMinutes": 0, "readingWords": 0, "sleepMinutes": None},
            ],
        }
        encoded = base64.b64encode(json.dumps(payload, ensure_ascii=False).encode("utf-8")).decode("ascii")
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "chart.png"
            env = os.environ.copy()
            env["OPENCLAW_PLANNER_DB_PATH"] = str(Path(temp) / "planner.sqlite")
            result = subprocess.run([str(PYTHON), str(CLI), "chart", "--payload-base64", encoded, "--output", str(output)], env=env, text=True, encoding="utf-8", capture_output=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            response = json.loads(result.stdout)
            self.assertEqual((response["width"], response["height"]), (1600, 1880))
            with Image.open(output) as image:
                self.assertEqual(image.size, (1600, 1880))
                colors = {"#%02X%02X%02X" % pixel for count, pixel in image.getcolors(maxcolors=5_000_000)}
            self.assertTrue(EXPECTED_COLORS.issubset(colors), EXPECTED_COLORS - colors)


if __name__ == "__main__":
    unittest.main(verbosity=2)
