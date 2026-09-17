from __future__ import annotations

import argparse
import base64
import json
import os
import sys
from pathlib import Path

from database import PlannerDatabase
from chart import generate_chart
from english_skills_chart import generate_english_skills_chart


if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")


def payload(value: str | None):
    if not value:
        raise ValueError("--payload-base64 is required")
    return json.loads(base64.b64decode(value).decode("utf-8"))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", nargs="?", default="init")
    parser.add_argument("--payload-base64")
    parser.add_argument("--date")
    parser.add_argument("--from", dest="from_date")
    parser.add_argument("--to", dest="to_date")
    parser.add_argument("--granularity", default="day")
    parser.add_argument("--habit")
    parser.add_argument("--slept-at")
    parser.add_argument("--status")
    parser.add_argument("--error")
    parser.add_argument("--item-id")
    parser.add_argument("--reminder-id")
    parser.add_argument("--output")
    parser.add_argument("--plugin-id")
    parser.add_argument("--state-key")
    parser.add_argument("--period-key")
    parser.add_argument("--action")
    parser.add_argument("--category")
    parser.add_argument("--keyword")
    args = parser.parse_args()
    db = PlannerDatabase()
    try:
        command = args.command
        handlers = {
            "init": lambda: {"ok": True, "action": "init", "dbPath": str(db.db_path)},
            "save-plan": lambda: db.save_plan(payload(args.payload_base64)),
            "modify-item": lambda: db.modify_item(payload(args.payload_base64)),
            "record-completion": lambda: db.record_completion(payload(args.payload_base64)),
            "query-date": lambda: db.query_date(args.date or ""),
            "complete-expired": lambda: db.complete_expired(args.date or ""),
            "mark-habit": lambda: db.mark_habit(args.habit or "", args.date),
            "record-sleep": lambda: db.record_sleep(args.date or "", args.slept_at),
            "repair-sleep-routine-dates": db.repair_sleep_routine_dates,
            "query-sleep": lambda: db.query_sleep(args.from_date or "", args.to_date or ""),
            "save-daily-record": lambda: db.save_daily_record(payload(args.payload_base64)),
            "query-daily-record": lambda: db.query_daily_record(args.date or ""),
            "query-record-range": lambda: db.query_record_range(args.from_date or "", args.to_date or "", args.granularity),
            "query-english-skills": lambda: db.query_english_skills(args.from_date or "", args.to_date or "", args.granularity),
            "manage-english-keywords": lambda: db.manage_english_keywords(args.action or "", args.category, args.keyword),
            "claim-english-skill-delivery": lambda: db.claim_english_skill_delivery(payload(args.payload_base64)),
            "finish-english-skill-delivery": lambda: db.finish_english_skill_delivery(args.period_key or "", args.status or "", args.error),
            "prepare-habit": lambda: db.prepare_habit(args.habit or "", args.date),
            "finish-habit": lambda: db.finish_habit(args.habit or "", args.date or "", args.status or "", args.error),
            "prepare-item": lambda: db.prepare_item(args.item_id or ""),
            "finish-item": lambda: db.finish_item(args.item_id or "", args.status or "", args.error),
            "create-general-reminder": lambda: db.create_general_reminder(payload(args.payload_base64)),
            "query-general-reminder": lambda: db.query_general_reminder(args.reminder_id or ""),
            "prepare-general-reminder": lambda: db.prepare_general_reminder(args.reminder_id or ""),
            "finish-general-reminder": lambda: db.finish_general_reminder(args.reminder_id or "", args.status or "", args.error),
            "ack-latest-general-reminder": db.ack_latest_general_reminder,
            "get-plugin-state": lambda: db.get_plugin_state(args.plugin_id or "", args.state_key or ""),
            "set-plugin-state": lambda: db.set_plugin_state(
                args.plugin_id or "",
                args.state_key or "",
                payload(args.payload_base64),
            ),
            "delete-plugin-state": lambda: db.delete_plugin_state(args.plugin_id or "", args.state_key or ""),
            "chart": lambda: generate_chart(payload(args.payload_base64), args.output or ""),
            "english-skills-chart": lambda: generate_english_skills_chart(payload(args.payload_base64), args.output or ""),
        }
        if command not in handlers:
            raise ValueError(f"unknown command: {command}")
        result = handlers[command]()
        sys.stdout.write(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        sys.stderr.write(f"{error}\n")
        raise SystemExit(1)
