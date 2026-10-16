from __future__ import annotations

import sys
import unittest
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "planner"))
from caldav_sync import QQCalDAVClient, ical_escape, render_event


class CalDAVSyncTests(unittest.TestCase):
    def test_render_event_escapes_and_uses_two_hour_default(self):
        raw = render_event({
            "plan_item_id": "abc", "plan_date": "2026-10-16", "start_time": "09:30",
            "end_time": None, "title": "听力,复习;A\\B\n第二行",
        }, "mashirobot-plan-abc@example")
        text = raw.decode("utf-8")
        self.assertIn("DTSTART;TZID=Asia/Shanghai:20261016T093000", text)
        self.assertIn("DTEND;TZID=Asia/Shanghai:20261016T113000", text)
        self.assertIn(r"SUMMARY:听力\,复习\;A\\B\n第二行", text)
        self.assertIn("UID:mashirobot-plan-abc@example", text)
        self.assertTrue(text.endswith("\r\n"))

    def test_render_event_replaces_legacy_unpaired_surrogates(self):
        text = render_event({
            "plan_item_id": "legacy", "plan_date": "2026-10-16", "start_time": "09:30",
            "end_time": "10:00", "title": "旧数据\udcaf",
        }, "legacy@example").decode("utf-8")
        self.assertIn("SUMMARY:旧数据?", text)

    def test_overnight_end_rolls_to_next_day(self):
        text = render_event({
            "plan_item_id": "night", "plan_date": "2026-10-16", "start_time": "23:30",
            "end_time": "00:30", "title": "夜间任务",
        }, "night@example").decode("utf-8")
        self.assertIn("DTEND;TZID=Asia/Shanghai:20261017T003000", text)

    def test_resource_url_is_deterministic(self):
        a = QQCalDAVClient.resource_url("https://dav.qq.com/calendar/x/", "uid-1")
        b = QQCalDAVClient.resource_url("https://dav.qq.com/calendar/x/", "uid-1")
        self.assertEqual(a, b)
        self.assertTrue(a.endswith(".ics"))

    def test_discovery_creates_dedicated_calendar_when_missing(self):
        client = QQCalDAVClient("https://dav.example/", "person@example.com", "secret")
        calls = []
        multistatus = b'''<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/calendar/existing/</d:href><d:propstat><d:prop><d:displayname>Existing</d:displayname><d:resourcetype><d:collection/><c:calendar/></d:resourcetype></d:prop></d:propstat></d:response></d:multistatus>'''

        def request(method, url, body=None, headers=None):
            calls.append((method, url))
            return (201, {}, b"") if method == "MKCALENDAR" else (207, {}, multistatus)

        client.request = request
        result = client.discover_calendar("Plan 计划")
        self.assertTrue(result.startswith("https://dav.example/calendar/mashirobot-plan-"))
        self.assertTrue(result.endswith("/"))
        self.assertIn("MKCALENDAR", [method for method, _ in calls])


if __name__ == "__main__":
    unittest.main(verbosity=2)
