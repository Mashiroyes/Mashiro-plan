from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
import sys

from PIL import Image


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PLUGIN_ROOT / "planner"))
from english_skills_chart import COLORS, generate_english_skills_chart, heat_strength  # noqa: E402


class EnglishSkillsChartTests(unittest.TestCase):
    def test_heatmap_uses_fixed_daily_intensity_thresholds(self):
        self.assertLess(heat_strength(60), 0.30)
        self.assertAlmostEqual(heat_strength(90), 0.45)
        self.assertLess(heat_strength(419), 1.0)
        self.assertAlmostEqual(heat_strength(420), 1.0)
        self.assertAlmostEqual(heat_strength(720), 1.0)

    def test_chart_has_expected_size_and_colors(self):
        payload = {
            "fromDate": "2026-08-03", "toDate": "2026-08-09",
            "totals": {"listening": 60, "speaking": 40, "reading": 120, "writing": 30, "anki": 60},
            "percentages": {"listening": 19.3, "speaking": 12.9, "reading": 38.7, "writing": 9.7, "anki": 19.3},
            "warning": None,
            "inactivityWarning": "间隔提醒：口语上次训练 8月3日 10:00，已 2天 未练。 不必一开始就坚持一小时，先开始十分钟，也是在进步。",
            "points": [{"label": "2026-08-03", "listening": 60, "speaking": 40, "reading": 120, "writing": 30}],
        }
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "chart.png"
            result = generate_english_skills_chart(payload, output)
            self.assertEqual(result["width"], 1600)
            self.assertEqual(result["height"], 1460)
            with Image.open(output) as image:
                colors = {"#%02X%02X%02X" % pixel for _, pixel in image.getcolors(maxcolors=5_000_000)}
            self.assertTrue(set(COLORS.values()).issubset(colors))

    def test_zero_state_renders(self):
        payload = {"fromDate": "2026-08-03", "toDate": "2026-08-09", "totals": {}, "percentages": {}, "points": [{"label": "2026-08-03", "listening": 0, "speaking": 0, "reading": 0, "writing": 0}]}
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / "zero.png"
            generate_english_skills_chart(payload, output)
            self.assertTrue(output.exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
