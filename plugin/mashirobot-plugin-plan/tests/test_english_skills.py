from __future__ import annotations

import base64
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
CLI = PLUGIN_ROOT / "planner" / "planner.py"
sys.path.insert(0, str(PLUGIN_ROOT / "planner"))
from english_skills import build_summary, classify_title, duration_minutes  # noqa: E402


def encoded(value):
    return base64.b64encode(json.dumps(value, ensure_ascii=False).encode("utf-8")).decode("ascii")


class EnglishSkillsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Path(self.temp.name) / "planner.sqlite"
        self.keyword_config = Path(self.temp.name) / "english-skill-keywords.json"
        shutil.copy2(PLUGIN_ROOT.parent / "mashirobot-plugin-language" / "config" / "english-skill-keywords.json", self.keyword_config)

    def tearDown(self):
        self.temp.cleanup()

    def cli(self, *args):
        env = {**os.environ, "OPENCLAW_PLANNER_DB_PATH": str(self.db), "OPENCLAW_ENGLISH_KEYWORDS_PATH": str(self.keyword_config), "PYTHONUTF8": "1"}
        result = subprocess.run([sys.executable, str(CLI), *args], env=env, text=True, encoding="utf-8", capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def save(self, plan_date, items):
        return self.cli("save-plan", "--payload-base64", encoded({"date": plan_date, "rawText": "计划", "items": items}))

    def test_keywords_precedence_case_and_cross_midnight(self):
        self.assertEqual(classify_title("英语听力复述"), "speaking")
        self.assertEqual(classify_title("THE BOOK OF THE NEW SUN"), "reading")
        self.assertEqual(classify_title("英语作文日志"), "writing")
        self.assertEqual(classify_title("AnKi"), "anki")
        self.assertIsNone(classify_title("吃饭"))
        self.assertEqual(duration_minutes("23:30", "00:20"), 50)

    def test_ai_conversation_and_chat_classification(self):
        writing_titles = (
            "和chatgpt对话",
            "跟 AI 对话",
            "与Gemini对话",
            "和Grok对话",
            "与 Claude 对话",
            "跟deepseek对话",
            "和元宝对话",
        )
        speaking_titles = (
            "和chatgpt聊天",
            "跟 AI 聊天",
            "与Gemini聊天",
            "和Grok聊天",
            "与 Claude 聊天",
            "跟deepseek聊天",
            "和元宝聊天",
        )
        for title in writing_titles:
            with self.subTest(title=title):
                self.assertEqual(classify_title(title), "writing")
        for title in speaking_titles:
            with self.subTest(title=title):
                self.assertEqual(classify_title(title), "speaking")
        self.assertEqual(classify_title("英语对话"), "writing")

        items = [
            {"startTime": "09:00", "endTime": "09:10", "title": title}
            for title in (*writing_titles, *speaking_titles)
        ]
        self.save("2099-01-05", items)
        result = self.cli("query-english-skills", "--from", "2099-01-05", "--to", "2099-01-05", "--granularity", "day")
        self.assertEqual(result["totals"]["writing"], 70)
        self.assertEqual(result["totals"]["speaking"], 70)
        self.assertEqual(result["percentages"]["writing"], 50.0)
        self.assertEqual(result["percentages"]["speaking"], 50.0)

    def test_dialogue_is_writing_and_chat_is_speaking(self):
        for title in ("对话", "英语对话", "英文对话", "和 chatgpt 英文对话"):
            with self.subTest(title=title):
                self.assertEqual(classify_title(title), "writing")
        self.assertEqual(classify_title("英文聊天"), "speaking")
        self.assertIsNone(classify_title("聊天"))

        self.save("2099-01-07", [
            {"startTime": "09:00", "endTime": "09:50", "title": "和 chatgpt 英文对话"},
            {"startTime": "10:00", "endTime": "10:50", "title": "英文聊天"},
        ])
        result = self.cli("query-english-skills", "--from", "2099-01-07", "--to", "2099-01-07", "--granularity", "day")
        self.assertEqual(result["totals"]["writing"], 50)
        self.assertEqual(result["totals"]["speaking"], 50)

    def test_revision_replacement_and_percentages(self):
        self.save("2099-01-01", [{"startTime": "09:00", "endTime": "10:00", "title": "哈利波特"}])
        self.save("2099-01-01", [{"startTime": "09:00", "endTime": "10:30", "title": "英语听力"}])
        result = self.cli("query-english-skills", "--from", "2099-01-01", "--to", "2099-01-02", "--granularity", "day")
        self.assertEqual(result["totals"]["reading"], 0)
        self.assertEqual(result["totals"]["listening"], 90)
        self.assertEqual(result["percentages"]["listening"], 100.0)

    def test_item_override_survives_rebuild_without_changing_keywords(self):
        title = "和chatgpt交流"
        self.assertIsNone(classify_title(title))
        self.save("2099-01-06", [{"startTime": "16:00", "endTime": "18:00", "title": title}])
        connection = sqlite3.connect(self.db)
        try:
            item_id = connection.execute(
                "SELECT id FROM plan_items WHERE plan_date=? AND title=? AND item_status='active'",
                ("2099-01-06", title),
            ).fetchone()[0]
            connection.execute(
                "INSERT INTO english_skill_plan_overrides(plan_item_id,category,created_at) VALUES(?,?,?)",
                (item_id, "writing", "2099-01-06T18:00:00+08:00"),
            )
            connection.commit()
        finally:
            connection.close()

        first = self.cli("query-english-skills", "--from", "2099-01-06", "--to", "2099-01-06", "--granularity", "day")
        second = self.cli("query-english-skills", "--from", "2099-01-06", "--to", "2099-01-06", "--granularity", "day")
        self.assertEqual(first["totals"]["writing"], 120)
        self.assertEqual(second["totals"]["writing"], 120)
        self.assertIsNone(classify_title(title))

    def test_warning_and_zero_state(self):
        rows = []
        for day in range(1, 4):
            rows.extend([
                {"plan_date": f"2026-08-0{day}", "category": "reading", "minutes": 60},
                {"plan_date": f"2026-08-0{day}", "category": "anki", "minutes": 30},
            ])
        summary = build_summary(rows, "2026-08-01", "2026-08-03", "day")
        self.assertIsNone(summary["warning"])
        anki_heavy = build_summary([
            {"plan_date": "2026-08-01", "category": "anki", "minutes": 300},
            {"plan_date": "2026-08-02", "category": "anki", "minutes": 300},
            {"plan_date": "2026-08-03", "category": "reading", "minutes": 60},
        ], "2026-08-01", "2026-08-03", "day")
        self.assertEqual(anki_heavy["fiveSkillsMinutes"], 660)
        self.assertAlmostEqual(anki_heavy["percentages"]["anki"], 600 / 660 * 100)
        self.assertIn("Anki", anki_heavy["warning"])
        empty = build_summary([], "2026-08-01", "2026-08-03", "day")
        self.assertEqual(empty["fourSkillsMinutes"], 0)
        self.assertEqual(len(empty["points"]), 3)

    def test_inactivity_reminders_use_latest_end_time_and_cross_midnight(self):
        rows = [
            {"plan_date": "2026-08-15", "category": "listening", "minutes": 60, "start_time": "21:00", "end_time": "22:00"},
            {"plan_date": "2026-08-16", "category": "speaking", "minutes": 60, "start_time": "23:30", "end_time": "00:20"},
            {"plan_date": "2026-08-16", "category": "reading", "minutes": 60, "start_time": "10:00", "end_time": "11:00"},
        ]
        now = datetime.fromisoformat("2026-08-17T01:00:00+08:00")
        summary = build_summary(rows, "2026-08-15", "2026-08-16", "day", latest_rows=rows, now=now)
        reminders = {item["category"]: item for item in summary["inactivityReminders"]}
        self.assertEqual(reminders["listening"]["inactiveMinutes"], 1620)
        self.assertNotIn("speaking", reminders)
        self.assertIn("writing", reminders)
        self.assertIsNone(reminders["writing"]["lastTrainingAt"])
        self.assertIn("听力上次训练 8月15日 22:00，已 1天3小时 未练。", summary["inactivityWarning"])
        self.assertIn("不必一开始就坚持一小时，先开始十分钟，也是在进步。", summary["inactivityWarning"])

    def test_daily_record_learns_book_and_reclassifies_existing_and_future_plans(self):
        self.save("2099-01-03", [{"startTime": "09:00", "endTime": "10:00", "title": "Hyperion"}])
        before = self.cli("query-english-skills", "--from", "2099-01-03", "--to", "2099-01-03", "--granularity", "day")
        self.assertEqual(before["totals"]["reading"], 0)
        self.cli("save-daily-record", "--payload-base64", encoded({
            "date": "2099-01-03", "readingTitle": "Hyperion", "readingWords": 1200, "rawText": "今日记录",
        }))
        retroactive = self.cli("query-english-skills", "--from", "2099-01-03", "--to", "2099-01-03", "--granularity", "day")
        self.assertEqual(retroactive["totals"]["reading"], 60)
        self.save("2099-01-04", [{"startTime": "10:00", "endTime": "11:30", "title": "hyperion"}])
        future = self.cli("query-english-skills", "--from", "2099-01-04", "--to", "2099-01-04", "--granularity", "day")
        self.assertEqual(future["totals"]["reading"], 90)

    def test_custom_keyword_add_list_remove_reclassifies_existing_plans(self):
        self.save("2099-01-03", [{"startTime": "09:00", "endTime": "10:30", "title": "上古卷轴5wiki"}])
        before = self.cli("query-english-skills", "--from", "2099-01-03", "--to", "2099-01-03", "--granularity", "day")
        self.assertEqual(before["totals"]["reading"], 0)
        added = self.cli("manage-english-keywords", "--action", "add", "--category", "阅读", "--keyword", "上古卷轴5wiki")
        self.assertTrue(added["changed"])
        after_add = self.cli("query-english-skills", "--from", "2099-01-03", "--to", "2099-01-03", "--granularity", "day")
        self.assertEqual(after_add["totals"]["reading"], 90)
        listed = self.cli("manage-english-keywords", "--action", "list")
        self.assertIn("上古卷轴5wiki", listed["keywords"]["reading"]["custom"])
        removed = self.cli("manage-english-keywords", "--action", "remove", "--category", "阅读", "--keyword", "上古卷轴5wiki")
        self.assertTrue(removed["changed"])
        after_remove = self.cli("query-english-skills", "--from", "2099-01-03", "--to", "2099-01-03", "--granularity", "day")
        self.assertEqual(after_remove["totals"]["reading"], 0)

    def test_delivery_claim_is_idempotent_and_failed_can_retry(self):
        payload = {"periodKey": "week:2026-08-03", "periodType": "week", "fromDate": "2026-08-03", "toDate": "2026-08-09"}
        first = self.cli("claim-english-skill-delivery", "--payload-base64", encoded(payload))
        second = self.cli("claim-english-skill-delivery", "--payload-base64", encoded(payload))
        self.assertTrue(first["shouldSend"])
        self.assertFalse(second["shouldSend"])
        self.cli("finish-english-skill-delivery", "--period-key", payload["periodKey"], "--status", "failed", "--error", "network")
        retry = self.cli("claim-english-skill-delivery", "--payload-base64", encoded(payload))
        self.assertTrue(retry["shouldSend"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
