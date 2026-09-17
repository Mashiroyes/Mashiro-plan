from __future__ import annotations

import json
import os
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterator

from report import build_record_range
from english_skills import CONFIG_PATH, CORE_SKILLS, build_summary, classify_title, duration_minutes, normalize_title

# The planner only schedules current/future China Standard Time, which is fixed UTC+8.
# Using a fixed offset also keeps the CLI self-contained on Windows installations
# that do not ship the optional IANA tzdata package.
SHANGHAI = timezone(timedelta(hours=8), "Asia/Shanghai")
PLAN_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_DB = PLAN_ROOT / "sqlite" / "openclaw-planner.sqlite"


def shanghai_now() -> datetime:
    return datetime.now(SHANGHAI)


def shanghai_iso() -> str:
    return shanghai_now().isoformat(timespec="seconds")


def sleep_routine_date(value: str | datetime) -> str:
    parsed = datetime.fromisoformat(value) if isinstance(value, str) else value
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError("sleptAt must include timezone")
    return (parsed.astimezone(SHANGHAI) - timedelta(hours=6)).date().isoformat()


def require_date(value: str) -> str:
    try:
        parsed = date.fromisoformat(str(value))
    except (TypeError, ValueError) as error:
        raise ValueError("date must use YYYY-MM-DD") from error
    if parsed.isoformat() != str(value):
        raise ValueError("date must use YYYY-MM-DD")
    return str(value)


def normalize_time(value: Any, field: str, required: bool = True) -> str | None:
    if (value is None or value == "") and not required:
        return None
    text = str(value or "")
    try:
        hour, minute = (int(part) for part in text.split(":"))
    except (ValueError, TypeError):
        raise ValueError(f"{field} must use HH:mm")
    if hour < 0 or hour > 23 or minute < 0 or minute > 59:
        raise ValueError(f"{field} must use HH:mm")
    return f"{hour:02d}:{minute:02d}"


def at_shanghai(plan_date: str, clock: str) -> datetime:
    return datetime.fromisoformat(f"{plan_date}T{clock}:00+08:00")


class PlannerDatabase:
    def __init__(self, db_path: str | Path | None = None):
        self.db_path = Path(db_path or os.environ.get("OPENCLAW_PLANNER_DB_PATH") or DEFAULT_DB)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.db_path, timeout=5.0)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.execute("PRAGMA busy_timeout=5000")
        self.initialize()

    def close(self) -> None:
        self.db.close()

    @contextmanager
    def transaction(self) -> Iterator[None]:
        self.db.execute("BEGIN IMMEDIATE")
        try:
            yield
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise

    def initialize(self) -> None:
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS plan_revisions (id TEXT PRIMARY KEY, plan_date TEXT NOT NULL, revision_no INTEGER NOT NULL, kind TEXT NOT NULL, raw_text TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(plan_date, revision_no));
        CREATE TABLE IF NOT EXISTS plan_items (id TEXT PRIMARY KEY, logical_key TEXT NOT NULL, plan_date TEXT NOT NULL, revision_id TEXT NOT NULL REFERENCES plan_revisions(id), start_time TEXT NOT NULL, end_time TEXT, title TEXT NOT NULL, item_status TEXT NOT NULL DEFAULT 'active', supersedes_item_id TEXT, actual_status TEXT NOT NULL DEFAULT 'unknown', actual_note TEXT, actual_updated_at TEXT, reminder_status TEXT NOT NULL DEFAULT 'pending', reminder_task_name TEXT, reminder_sent_at TEXT, reminder_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_plan_items_date_status ON plan_items(plan_date, item_status, start_time);
        CREATE TABLE IF NOT EXISTS completion_reports (id TEXT PRIMARY KEY, plan_date TEXT NOT NULL, raw_text TEXT NOT NULL, created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS habit_events (plan_date TEXT NOT NULL, habit TEXT NOT NULL, reminder_status TEXT NOT NULL DEFAULT 'pending', reminder_sent_at TEXT, reminder_error TEXT, completed_at TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(plan_date, habit));
        CREATE TABLE IF NOT EXISTS sleep_events (routine_date TEXT PRIMARY KEY, slept_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS idx_sleep_events_slept_at ON sleep_events(slept_at);
        CREATE TABLE IF NOT EXISTS daily_records (record_date TEXT PRIMARY KEY, study_minutes INTEGER NOT NULL DEFAULT 0, entertainment_minutes INTEGER NOT NULL DEFAULT 0, other_json TEXT NOT NULL DEFAULT '[]', reading_title TEXT NOT NULL DEFAULT '', reading_words INTEGER NOT NULL DEFAULT 0, reading_start_pos INTEGER, reading_end_pos INTEGER, raw_text TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS general_reminders (
          id TEXT PRIMARY KEY,
          content TEXT NOT NULL,
          scheduled_at TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          windows_task_name TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          last_sent_at TEXT,
          acknowledged_at TEXT,
          updated_at TEXT NOT NULL,
          last_error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_general_reminders_status_sent
        ON general_reminders(status, last_sent_at);
        CREATE TABLE IF NOT EXISTS plugin_runtime_state (
          plugin_id TEXT NOT NULL,
          state_key TEXT NOT NULL,
          value_json TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(plugin_id, state_key)
        );
        CREATE TABLE IF NOT EXISTS english_skill_plan_entries (
          plan_item_id TEXT PRIMARY KEY REFERENCES plan_items(id),
          plan_date TEXT NOT NULL,
          category TEXT NOT NULL CHECK(category IN ('listening','speaking','reading','writing','anki')),
          title TEXT NOT NULL,
          minutes INTEGER NOT NULL CHECK(minutes >= 0),
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_english_skill_entries_date_category
        ON english_skill_plan_entries(plan_date, category);
        CREATE TABLE IF NOT EXISTS english_skill_plan_overrides (
          plan_item_id TEXT PRIMARY KEY REFERENCES plan_items(id),
          category TEXT NOT NULL CHECK(category IN ('listening','speaking','reading','writing','anki')),
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS english_skill_deliveries (
          period_key TEXT PRIMARY KEY,
          period_type TEXT NOT NULL CHECK(period_type IN ('week','month','year')),
          from_date TEXT NOT NULL,
          to_date TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('sending','sent','failed')),
          sent_at TEXT,
          last_error TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS learned_english_reading_titles (
          normalized_title TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          first_seen_date TEXT NOT NULL,
          last_seen_date TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        """)
        columns = {row["name"] for row in self.db.execute("PRAGMA table_info(daily_records)")}
        for name, definition in {
            "reading_title": "TEXT NOT NULL DEFAULT ''",
            "reading_words": "INTEGER NOT NULL DEFAULT 0",
            "reading_start_pos": "INTEGER",
            "reading_end_pos": "INTEGER",
        }.items():
            if name not in columns:
                self.db.execute(f"ALTER TABLE daily_records ADD COLUMN {name} {definition}")
        for record in self.db.execute(
            """SELECT record_date,reading_title,updated_at FROM daily_records
            WHERE TRIM(reading_title)<>'' ORDER BY record_date"""
        ).fetchall():
            normalized = normalize_title(record["reading_title"])
            if not normalized:
                continue
            self.db.execute(
                """INSERT INTO learned_english_reading_titles
                (normalized_title,title,first_seen_date,last_seen_date,updated_at)
                VALUES(?,?,?,?,?)
                ON CONFLICT(normalized_title) DO UPDATE SET
                  title=excluded.title,
                  first_seen_date=MIN(first_seen_date,excluded.first_seen_date),
                  last_seen_date=MAX(last_seen_date,excluded.last_seen_date),
                  updated_at=excluded.updated_at""",
                (normalized, record["reading_title"], record["record_date"], record["record_date"], record["updated_at"]),
            )
        # Backfill and reconcile plans saved before the feature or before a book title was learned.
        self.rebuild_english_skill_entries()
        self.db.commit()

    @staticmethod
    def row(row: sqlite3.Row | None) -> dict[str, Any] | None:
        return dict(row) if row is not None else None

    def rows(self, sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        return [dict(row) for row in self.db.execute(sql, params).fetchall()]

    def learned_reading_titles(self) -> set[str]:
        return {
            str(row["normalized_title"])
            for row in self.db.execute("SELECT normalized_title FROM learned_english_reading_titles")
        }

    def classify_english_title(self, title: str) -> str | None:
        normalized = normalize_title(title)
        learned = self.learned_reading_titles()
        if normalized and normalized in learned:
            return "reading"
        category = classify_title(title)
        if category is not None:
            return category
        if normalized and any(book in normalized for book in learned):
            return "reading"
        return None

    def rebuild_english_skill_entries(self) -> dict[str, Any]:
        scanned = 0
        classified = 0
        removed = 0
        for item in self.db.execute(
            """SELECT p.id,p.plan_date,p.start_time,p.end_time,p.title,p.created_at,
                      o.category AS override_category
               FROM plan_items p
               LEFT JOIN english_skill_plan_overrides o ON o.plan_item_id=p.id"""
        ).fetchall():
            scanned += 1
            category = item["override_category"] or self.classify_english_title(item["title"])
            if category is None:
                removed += self.db.execute("DELETE FROM english_skill_plan_entries WHERE plan_item_id=?", (item["id"],)).rowcount
                continue
            classified += 1
            self.db.execute(
                """INSERT INTO english_skill_plan_entries
                (plan_item_id,plan_date,category,title,minutes,created_at)
                VALUES(?,?,?,?,?,?)
                ON CONFLICT(plan_item_id) DO UPDATE SET
                  plan_date=excluded.plan_date,category=excluded.category,title=excluded.title,
                  minutes=excluded.minutes""",
                (
                    item["id"], item["plan_date"], category, item["title"],
                    duration_minutes(item["start_time"], item["end_time"]), item["created_at"],
                ),
            )
        return {"completed": True, "scanned": scanned, "classified": classified, "removed": removed}

    @staticmethod
    def english_keyword_category(value: str) -> str:
        aliases = {
            "听": "listening", "听力": "listening",
            "说": "speaking", "口语": "speaking",
            "读": "reading", "阅读": "reading",
            "写": "writing", "写作": "writing",
        }
        category = aliases.get(str(value or "").strip().casefold())
        if category is None:
            raise ValueError("category must be 听力、口语、阅读或写作")
        return category

    @staticmethod
    def read_english_keyword_config() -> dict[str, Any]:
        config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        if not isinstance(config.get("keywords"), dict):
            raise ValueError("English keyword configuration is invalid")
        custom = config.setdefault("customKeywords", {})
        if not isinstance(custom, dict):
            raise ValueError("English keyword configuration is invalid")
        for category in CORE_SKILLS:
            if not isinstance(config["keywords"].get(category), list):
                raise ValueError("English keyword configuration is invalid")
            values = custom.setdefault(category, [])
            if not isinstance(values, list) or not all(isinstance(value, str) for value in values):
                raise ValueError("English keyword configuration is invalid")
        return config

    @staticmethod
    def write_english_keyword_config(config: dict[str, Any]) -> None:
        temporary = CONFIG_PATH.with_suffix(CONFIG_PATH.suffix + ".tmp")
        temporary.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(CONFIG_PATH)

    def manage_english_keywords(self, action: str, category_value: str | None = None, keyword_value: str | None = None) -> dict[str, Any]:
        normalized_action = str(action or "").strip().casefold()
        config = self.read_english_keyword_config()
        def keyword_view() -> dict[str, Any]:
            return {
                category: {
                    "builtIn": config["keywords"][category],
                    "custom": config["customKeywords"][category],
                }
                for category in CORE_SKILLS
            }
        if normalized_action == "list":
            return {
                "ok": True, "action": "list-english-keywords",
                "keywords": keyword_view(),
            }
        if normalized_action not in ("add", "remove"):
            raise ValueError("action must be list, add or remove")
        category = self.english_keyword_category(str(category_value or ""))
        keyword = " ".join(str(keyword_value or "").strip().split())
        if not keyword or len(keyword) > 80:
            raise ValueError("keyword must contain 1 to 80 non-whitespace characters")
        normalized = normalize_title(keyword)
        built_in = config["keywords"][category]
        custom = config["customKeywords"][category]
        if normalized in {normalize_title(value) for value in built_in}:
            if normalized_action == "remove":
                raise ValueError("内置关键词不能删除")
            return {"ok": True, "action": "add-english-keyword", "changed": False, "category": category, "keyword": keyword, "reason": "already-built-in", "keywords": keyword_view(), "rebuild": {"completed": False, "reason": "unchanged"}}
        custom_index = next((index for index, value in enumerate(custom) if normalize_title(value) == normalized), None)
        if normalized_action == "add":
            if custom_index is not None:
                return {"ok": True, "action": "add-english-keyword", "changed": False, "category": category, "keyword": keyword, "reason": "already-added", "keywords": keyword_view(), "rebuild": {"completed": False, "reason": "unchanged"}}
            custom.append(keyword)
        else:
            if custom_index is None:
                return {"ok": True, "action": "remove-english-keyword", "changed": False, "category": category, "keyword": keyword, "reason": "not-found", "keywords": keyword_view(), "rebuild": {"completed": False, "reason": "unchanged"}}
            custom.pop(custom_index)
        self.write_english_keyword_config(config)
        with self.transaction():
            rebuild = self.rebuild_english_skill_entries()
        return {"ok": True, "action": f"{normalized_action}-english-keyword", "changed": True, "category": category, "keyword": keyword, "keywords": keyword_view(), "rebuild": rebuild}

    @staticmethod
    def require_state_identifier(value: str, field: str) -> str:
        normalized = str(value or "").strip()
        if not normalized:
            raise ValueError(f"{field} is required")
        return normalized

    def get_plugin_state(self, plugin_id: str, state_key: str) -> dict[str, Any]:
        plugin_id = self.require_state_identifier(plugin_id, "plugin-id")
        state_key = self.require_state_identifier(state_key, "state-key")
        row = self.db.execute(
            "SELECT value_json,updated_at FROM plugin_runtime_state WHERE plugin_id=? AND state_key=?",
            (plugin_id, state_key),
        ).fetchone()
        if row is None:
            return {
                "ok": True,
                "action": "get-plugin-state",
                "pluginId": plugin_id,
                "stateKey": state_key,
                "found": False,
                "value": None,
                "updatedAt": None,
            }
        try:
            value = json.loads(row["value_json"])
        except (TypeError, json.JSONDecodeError) as error:
            raise ValueError("stored plugin state is invalid JSON") from error
        return {
            "ok": True,
            "action": "get-plugin-state",
            "pluginId": plugin_id,
            "stateKey": state_key,
            "found": True,
            "value": value,
            "updatedAt": row["updated_at"],
        }

    def set_plugin_state(self, plugin_id: str, state_key: str, value: Any) -> dict[str, Any]:
        plugin_id = self.require_state_identifier(plugin_id, "plugin-id")
        state_key = self.require_state_identifier(state_key, "state-key")
        try:
            value_json = json.dumps(
                value,
                ensure_ascii=False,
                separators=(",", ":"),
                allow_nan=False,
            )
            normalized_value = json.loads(value_json)
        except (TypeError, ValueError, json.JSONDecodeError) as error:
            raise ValueError("plugin state must be valid JSON") from error
        updated_at = shanghai_iso()
        with self.transaction():
            self.db.execute(
                """INSERT INTO plugin_runtime_state(plugin_id,state_key,value_json,updated_at)
                VALUES(?,?,?,?)
                ON CONFLICT(plugin_id,state_key) DO UPDATE SET
                  value_json=excluded.value_json,
                  updated_at=excluded.updated_at""",
                (plugin_id, state_key, value_json, updated_at),
            )
        return {
            "ok": True,
            "action": "set-plugin-state",
            "pluginId": plugin_id,
            "stateKey": state_key,
            "value": normalized_value,
            "updatedAt": updated_at,
        }

    def delete_plugin_state(self, plugin_id: str, state_key: str) -> dict[str, Any]:
        plugin_id = self.require_state_identifier(plugin_id, "plugin-id")
        state_key = self.require_state_identifier(state_key, "state-key")
        with self.transaction():
            cursor = self.db.execute(
                "DELETE FROM plugin_runtime_state WHERE plugin_id=? AND state_key=?",
                (plugin_id, state_key),
            )
        return {
            "ok": True,
            "action": "delete-plugin-state",
            "pluginId": plugin_id,
            "stateKey": state_key,
            "deleted": cursor.rowcount > 0,
        }

    @staticmethod
    def general_reminder(row: sqlite3.Row | None) -> dict[str, Any] | None:
        if row is None:
            return None
        return {
            "id": row["id"],
            "content": row["content"],
            "scheduledAt": row["scheduled_at"],
            "status": row["status"],
            "taskName": row["windows_task_name"],
            "createdAt": row["created_at"],
            "lastSentAt": row["last_sent_at"],
            "acknowledgedAt": row["acknowledged_at"],
            "updatedAt": row["updated_at"],
            "lastError": row["last_error"],
        }

    @staticmethod
    def general_now_iso() -> str:
        return shanghai_now().isoformat(timespec="microseconds")

    def create_general_reminder(self, payload: dict[str, Any]) -> dict[str, Any]:
        content = str(payload.get("content") or "").strip()
        if not content:
            raise ValueError("content is required")
        scheduled_text = str(payload.get("scheduledAt") or "").strip()
        if not scheduled_text:
            raise ValueError("scheduledAt is required")
        try:
            scheduled = datetime.fromisoformat(scheduled_text)
        except ValueError as error:
            raise ValueError("scheduledAt must be an ISO timestamp with timezone") from error
        if scheduled.tzinfo is None or scheduled.utcoffset() is None:
            raise ValueError("scheduledAt must be an ISO timestamp with timezone")
        if scheduled <= shanghai_now():
            raise ValueError("scheduledAt must be in the future")
        scheduled_at = scheduled.astimezone(SHANGHAI).isoformat(timespec="seconds")
        reminder_id = str(uuid.uuid4())
        task_name = f"OpenClaw-General-{scheduled.astimezone(SHANGHAI):%Y%m%d-%H%M%S}-{reminder_id[:8]}"
        now = self.general_now_iso()
        with self.transaction():
            self.db.execute(
                """INSERT INTO general_reminders
                (id,content,scheduled_at,status,windows_task_name,created_at,updated_at)
                VALUES (?,?,?,'active',?,?,?)""",
                (reminder_id, content, scheduled_at, task_name, now, now),
            )
            row = self.db.execute("SELECT * FROM general_reminders WHERE id=?", (reminder_id,)).fetchone()
        result = self.general_reminder(row)
        assert result is not None
        return result

    def query_general_reminder(self, reminder_id: str) -> dict[str, Any]:
        if not reminder_id:
            raise ValueError("reminder id is required")
        row = self.db.execute("SELECT * FROM general_reminders WHERE id=?", (reminder_id,)).fetchone()
        return {"ok": True, "found": row is not None, "reminder": self.general_reminder(row)}

    def prepare_general_reminder(self, reminder_id: str) -> dict[str, Any]:
        if not reminder_id:
            raise ValueError("reminder-id is required")
        now = self.general_now_iso()
        with self.transaction():
            row = self.db.execute("SELECT * FROM general_reminders WHERE id=?", (reminder_id,)).fetchone()
            if row is None:
                return {"ok": True, "shouldSend": False, "reason": "missing", "reminder": None}
            reminder = self.general_reminder(row)
            if row["status"] not in {"active", "failed"}:
                return {"ok": True, "shouldSend": False, "reason": row["status"], "reminder": reminder}
            self.db.execute(
                "UPDATE general_reminders SET status='sending',last_error=NULL,updated_at=? WHERE id=?",
                (now, reminder_id),
            )
            updated = self.db.execute("SELECT * FROM general_reminders WHERE id=?", (reminder_id,)).fetchone()
        return {"ok": True, "shouldSend": True, "reminder": self.general_reminder(updated)}

    def finish_general_reminder(self, reminder_id: str, status: str, error: str | None = None) -> dict[str, Any]:
        if not reminder_id:
            raise ValueError("reminder-id is required")
        if status not in {"sent", "failed"}:
            raise ValueError("invalid reminder status")
        now = self.general_now_iso()
        next_status = "active" if status == "sent" else "failed"
        with self.transaction():
            row = self.db.execute("SELECT * FROM general_reminders WHERE id=?", (reminder_id,)).fetchone()
            if row is None:
                raise ValueError("general reminder was not found")
            self.db.execute(
                """UPDATE general_reminders
                SET status=?,last_sent_at=CASE WHEN ?='sent' THEN ? ELSE last_sent_at END,
                    last_error=?,updated_at=?
                WHERE id=?""",
                (next_status, status, now, None if status == "sent" else error, now, reminder_id),
            )
            updated = self.db.execute("SELECT * FROM general_reminders WHERE id=?", (reminder_id,)).fetchone()
        return {
            "ok": True,
            "action": "finish-general-reminder",
            "id": reminder_id,
            "status": next_status,
            "deliveryStatus": status,
            "reminder": self.general_reminder(updated),
        }

    def ack_latest_general_reminder(self) -> dict[str, Any]:
        now = self.general_now_iso()
        with self.transaction():
            row = self.db.execute(
                """SELECT * FROM general_reminders
                WHERE status IN ('active','failed') AND last_sent_at IS NOT NULL
                ORDER BY last_sent_at DESC, created_at DESC
                LIMIT 1"""
            ).fetchone()
            if row is None:
                return {"ok": True, "found": False}
            self.db.execute(
                """UPDATE general_reminders
                SET status='acknowledged',acknowledged_at=?,updated_at=?
                WHERE id=? AND status IN ('active','failed')""",
                (now, now, row["id"]),
            )
        return {
            "ok": True,
            "found": True,
            "id": row["id"],
            "content": row["content"],
            "taskName": row["windows_task_name"],
        }

    def next_revision(self, plan_date: str) -> int:
        row = self.db.execute("SELECT COALESCE(MAX(revision_no),0) value FROM plan_revisions WHERE plan_date=?", (plan_date,)).fetchone()
        return int(row["value"]) + 1

    def classify_reminder(self, start_at: datetime, end_at: datetime | None, mode: str = "normal") -> str:
        now = shanghai_now()
        if start_at > now + timedelta(seconds=5):
            return "schedule"
        if mode == "modified":
            return "immediate"
        expires = end_at or start_at + timedelta(hours=2)
        return "immediate" if now <= expires else "skip"

    def make_item(self, plan_date: str, revision_id: str, value: dict[str, Any], supersedes: str | None = None, mode: str = "normal") -> dict[str, Any]:
        item_id = str(uuid.uuid4())
        start_time = normalize_time(value.get("startTime"), "startTime")
        end_time = normalize_time(value.get("endTime"), "endTime", False)
        title = str(value.get("title") or "").strip()
        if not title:
            raise ValueError("item title is required")
        start_at = at_shanghai(plan_date, start_time)
        end_at = at_shanghai(plan_date, end_time) if end_time else None
        delivery = self.classify_reminder(start_at, end_at, mode)
        completed = delivery == "skip"
        return {
            "id": item_id,
            "logicalKey": value.get("logicalKey") or item_id,
            "planDate": plan_date,
            "revisionId": revision_id,
            "startTime": start_time,
            "endTime": end_time,
            "title": title,
            "supersedesItemId": supersedes,
            "actualStatus": "completed" if completed else "unknown",
            "actualNote": "录入计划时该时间段已结束，按规则自动完成" if completed else None,
            "actualUpdatedAt": shanghai_iso() if completed else None,
            "reminderStatus": "completed" if completed else ("pending_immediate" if delivery == "immediate" else "pending"),
            "taskName": f"OpenClaw-Plan-{plan_date.replace('-', '')}-{item_id[:8]}",
            "startAt": start_at.isoformat(),
            "endAt": end_at.isoformat() if end_at else None,
            "deliveryMode": delivery,
        }

    def persist_item(self, item: dict[str, Any], now: str) -> None:
        self.db.execute("""INSERT INTO plan_items (id,logical_key,plan_date,revision_id,start_time,end_time,title,item_status,supersedes_item_id,actual_status,actual_note,actual_updated_at,reminder_status,reminder_task_name,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'active',?,?,?,?,?,?,?,?)""", (
            item["id"], item["logicalKey"], item["planDate"], item["revisionId"], item["startTime"], item["endTime"], item["title"], item["supersedesItemId"], item["actualStatus"], item["actualNote"], item["actualUpdatedAt"], item["reminderStatus"], item["taskName"], now, now,
        ))

    def persist_english_skill_item(self, item: dict[str, Any], now: str) -> None:
        category = self.classify_english_title(item["title"])
        if category is None:
            return
        minutes = duration_minutes(item["startTime"], item["endTime"])
        self.db.execute(
            """INSERT INTO english_skill_plan_entries
            (plan_item_id,plan_date,category,title,minutes,created_at)
            VALUES(?,?,?,?,?,?)""",
            (item["id"], item["planDate"], category, item["title"], minutes, now),
        )

    def save_plan(self, payload: dict[str, Any]) -> dict[str, Any]:
        plan_date = require_date(payload.get("date", ""))
        raw_text = str(payload.get("rawText") or "").strip()
        values = payload.get("items")
        if not raw_text: raise ValueError("rawText is required")
        if not isinstance(values, list) or not values: raise ValueError("items must be a non-empty array")
        now = shanghai_iso()
        with self.transaction():
            canceled = [row["reminder_task_name"] for row in self.db.execute("SELECT reminder_task_name FROM plan_items WHERE plan_date=? AND item_status='active' AND reminder_status IN ('pending','pending_immediate','sending')", (plan_date,)) if row["reminder_task_name"]]
            self.db.execute("UPDATE plan_items SET item_status='superseded',updated_at=? WHERE plan_date=? AND item_status='active'", (now, plan_date))
            revision_id = str(uuid.uuid4()); revision_no = self.next_revision(plan_date)
            self.db.execute("INSERT INTO plan_revisions VALUES (?,?,?,'full',?,?)", (revision_id, plan_date, revision_no, raw_text, now))
            items = [self.make_item(plan_date, revision_id, value) for value in values]
            for item in items:
                self.persist_item(item, now)
                self.persist_english_skill_item(item, now)
        return {"ok": True, "action": "save-plan", "planDate": plan_date, "revisionNo": revision_no, "canceledTasks": canceled, "items": items}

    def query_english_skills(self, from_date: str, to_date: str, granularity: str) -> dict[str, Any]:
        require_date(from_date)
        require_date(to_date)
        rows = self.rows(
            """SELECT e.plan_date,e.category,e.minutes,i.start_time,i.end_time
            FROM english_skill_plan_entries e
            JOIN plan_items i ON i.id=e.plan_item_id
            WHERE e.plan_date BETWEEN ? AND ? AND i.item_status='active'
            ORDER BY e.plan_date,e.category""",
            (from_date, to_date),
        )
        latest_rows = self.rows(
            """SELECT e.plan_date,e.category,e.minutes,i.start_time,i.end_time
            FROM english_skill_plan_entries e
            JOIN plan_items i ON i.id=e.plan_item_id
            WHERE i.item_status='active' AND e.category IN ('listening','speaking','reading','writing')
            ORDER BY e.plan_date,e.category"""
        )
        return build_summary(rows, from_date, to_date, granularity, latest_rows=latest_rows)

    def claim_english_skill_delivery(self, payload: dict[str, Any]) -> dict[str, Any]:
        period_key = str(payload.get("periodKey") or "").strip()
        period_type = str(payload.get("periodType") or "").strip()
        from_date = require_date(payload.get("fromDate", ""))
        to_date = require_date(payload.get("toDate", ""))
        if not period_key or period_type not in {"week", "month", "year"}:
            raise ValueError("invalid English skill delivery period")
        now = shanghai_iso()
        with self.transaction():
            row = self.db.execute(
                "SELECT status FROM english_skill_deliveries WHERE period_key=?",
                (period_key,),
            ).fetchone()
            if row is not None and row["status"] in {"sending", "sent"}:
                return {"ok": True, "shouldSend": False, "reason": row["status"], "periodKey": period_key}
            self.db.execute(
                """INSERT INTO english_skill_deliveries
                (period_key,period_type,from_date,to_date,status,updated_at)
                VALUES(?,?,?,?,'sending',?)
                ON CONFLICT(period_key) DO UPDATE SET status='sending',last_error=NULL,updated_at=excluded.updated_at""",
                (period_key, period_type, from_date, to_date, now),
            )
        return {"ok": True, "shouldSend": True, "periodKey": period_key, "periodType": period_type, "fromDate": from_date, "toDate": to_date}

    def finish_english_skill_delivery(self, period_key: str, status: str, error: str | None = None) -> dict[str, Any]:
        if not period_key or status not in {"sent", "failed"}:
            raise ValueError("invalid English skill delivery result")
        now = shanghai_iso()
        with self.transaction():
            cursor = self.db.execute(
                """UPDATE english_skill_deliveries
                SET status=?,sent_at=CASE WHEN ?='sent' THEN ? ELSE sent_at END,
                    last_error=?,updated_at=? WHERE period_key=?""",
                (status, status, now, None if status == "sent" else str(error or "unknown error")[:1000], now, period_key),
            )
            if cursor.rowcount != 1:
                raise ValueError("English skill delivery was not claimed")
        return {"ok": True, "periodKey": period_key, "status": status}

    def modify_item(self, payload: dict[str, Any]) -> dict[str, Any]:
        plan_date = require_date(payload.get("date", "")); target = str(payload.get("targetItemId") or ""); raw = str(payload.get("rawText") or "").strip()
        if not target: raise ValueError("targetItemId is required")
        if not raw: raise ValueError("rawText is required")
        now = shanghai_iso()
        with self.transaction():
            old = self.db.execute("SELECT * FROM plan_items WHERE id=? AND plan_date=? AND item_status='active'", (target, plan_date)).fetchone()
            if not old: raise ValueError("active target item was not found")
            revision_id = str(uuid.uuid4()); revision_no = self.next_revision(plan_date)
            self.db.execute("INSERT INTO plan_revisions VALUES (?,?,?,'modify',?,?)", (revision_id, plan_date, revision_no, raw, now))
            self.db.execute("UPDATE plan_items SET item_status='superseded',updated_at=? WHERE id=?", (now, old["id"]))
            value = {"logicalKey": old["logical_key"], "startTime": payload.get("startTime") or old["start_time"], "endTime": old["end_time"] if "endTime" not in payload else payload.get("endTime"), "title": payload.get("title") or old["title"]}
            replacement = self.make_item(plan_date, revision_id, value, old["id"], "modified")
            self.persist_item(replacement, now)
            self.persist_english_skill_item(replacement, now)
        return {"ok": True, "action": "modify-item", "planDate": plan_date, "revisionNo": revision_no, "canceledTasks": [old["reminder_task_name"]] if old["reminder_task_name"] else [], "items": [replacement]}

    def record_completion(self, payload: dict[str, Any]) -> dict[str, Any]:
        plan_date = require_date(payload.get("date", "")); raw = str(payload.get("rawText") or "").strip(); updates = payload.get("updates")
        if not raw: raise ValueError("rawText is required")
        if not isinstance(updates, list): raise ValueError("updates must be an array")
        allowed = {"completed", "partial", "not_completed", "unknown"}; now = shanghai_iso(); report_id = str(uuid.uuid4()); updated = 0
        with self.transaction():
            self.db.execute("INSERT INTO completion_reports VALUES (?,?,?,?)", (report_id, plan_date, raw, now))
            for value in updates:
                status = str(value.get("status") or "unknown")
                if status not in allowed: raise ValueError(f"unsupported actual status: {status}")
                cursor = self.db.execute("UPDATE plan_items SET actual_status=?,actual_note=?,actual_updated_at=?,updated_at=? WHERE id=? AND plan_date=? AND item_status='active'", (status, str(value.get("note")) if value.get("note") else None, now, now, value.get("itemId"), plan_date)); updated += cursor.rowcount
        return {"ok": True, "action": "record-completion", "planDate": plan_date, "reportId": report_id, "updated": updated}

    def query_date(self, plan_date: str) -> dict[str, Any]:
        require_date(plan_date)
        return {"ok": True, "action": "query-date", "planDate": plan_date,
            "revisions": self.rows("SELECT * FROM plan_revisions WHERE plan_date=? ORDER BY revision_no", (plan_date,)),
            "currentItems": self.rows("SELECT * FROM plan_items WHERE plan_date=? AND item_status='active' ORDER BY start_time,created_at", (plan_date,)),
            "itemHistory": self.rows("SELECT * FROM plan_items WHERE plan_date=? AND item_status<>'active' ORDER BY created_at", (plan_date,)),
            "completionReports": self.rows("SELECT * FROM completion_reports WHERE plan_date=? ORDER BY created_at", (plan_date,)),
            "habits": self.rows("SELECT * FROM habit_events WHERE plan_date=? ORDER BY habit", (plan_date,))}

    def complete_expired(self, plan_date: str) -> dict[str, Any]:
        require_date(plan_date); now = shanghai_iso(); completed: list[str] = []
        with self.transaction():
            for row in self.db.execute("SELECT id,start_time,end_time FROM plan_items WHERE plan_date=? AND item_status='active' AND reminder_status='missed'", (plan_date,)):
                end_at = at_shanghai(plan_date, row["end_time"]) if row["end_time"] else at_shanghai(plan_date, row["start_time"]) + timedelta(hours=2)
                if end_at >= shanghai_now(): continue
                self.db.execute("UPDATE plan_items SET actual_status='completed',actual_note='录入计划时该时间段已结束，按规则自动完成',actual_updated_at=?,reminder_status='completed',reminder_error=NULL,updated_at=? WHERE id=?", (now, now, row["id"])); completed.append(row["id"])
        return {"ok": True, "action": "complete-expired", "planDate": plan_date, "completedIds": completed}

    def mark_habit(self, habit: str, plan_date: str | None = None) -> dict[str, Any]:
        if habit not in {"water", "journal"}: raise ValueError("unsupported habit")
        plan_date = require_date(plan_date or shanghai_now().date().isoformat()); now = shanghai_iso()
        self.db.execute("INSERT INTO habit_events(plan_date,habit,completed_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(plan_date,habit) DO UPDATE SET completed_at=excluded.completed_at,updated_at=excluded.updated_at", (plan_date, habit, now, now)); self.db.commit()
        return {"ok": True, "action": "mark-habit", "date": plan_date, "habit": habit, "completedAt": now}

    def record_sleep(self, routine_date: str, slept_at: str | None = None) -> dict[str, Any]:
        require_date(routine_date); slept_at = slept_at or shanghai_iso(); routine_date = sleep_routine_date(slept_at); updated = shanghai_iso()
        self.db.execute("INSERT INTO sleep_events VALUES(?,?,?) ON CONFLICT(routine_date) DO UPDATE SET slept_at=excluded.slept_at,updated_at=excluded.updated_at", (routine_date, slept_at, updated)); self.db.commit()
        return {"ok": True, "action": "record-sleep", "routineDate": routine_date, "sleptAt": slept_at, "updatedAt": updated}

    def repair_sleep_routine_dates(self) -> dict[str, Any]:
        moved = 0
        conflicts = 0
        unchanged = 0
        with self.transaction():
            source_rows = self.rows(
                "SELECT routine_date,slept_at,updated_at FROM sleep_events ORDER BY routine_date"
            )
            groups: dict[str, list[dict[str, Any]]] = {}
            for row in source_rows:
                target_date = sleep_routine_date(row["slept_at"])
                row["target_date"] = target_date
                groups.setdefault(target_date, []).append(row)
                if row["routine_date"] != target_date:
                    moved += 1

            winners: list[dict[str, Any]] = []
            for target_date, candidates in groups.items():
                if len(candidates) == 1 and candidates[0]["routine_date"] == target_date:
                    unchanged += 1
                conflicts += len(candidates) - 1
                winner = max(
                    candidates,
                    key=lambda row: (
                        datetime.fromisoformat(row["slept_at"]).astimezone(timezone.utc),
                        row["updated_at"],
                        row["routine_date"],
                    ),
                )
                winners.append({
                    "routine_date": target_date,
                    "slept_at": winner["slept_at"],
                    "updated_at": winner["updated_at"],
                })

            if moved or conflicts:
                self.db.execute("DELETE FROM sleep_events")
                self.db.executemany(
                    "INSERT INTO sleep_events(routine_date,slept_at,updated_at) VALUES(?,?,?)",
                    [
                        (row["routine_date"], row["slept_at"], row["updated_at"])
                        for row in winners
                    ],
                )

            repaired_rows = self.rows(
                "SELECT routine_date,slept_at,updated_at FROM sleep_events ORDER BY routine_date"
            )
        return {
            "ok": True,
            "action": "repair-sleep-routine-dates",
            "moved": moved,
            "conflicts": conflicts,
            "unchanged": unchanged,
            "rows": repaired_rows,
        }

    def query_sleep(self, from_date: str, to_date: str) -> dict[str, Any]:
        require_date(from_date); require_date(to_date)
        if from_date > to_date: raise ValueError("from date must not be after to date")
        return {"ok": True, "action": "query-sleep", "fromDate": from_date, "toDate": to_date, "rows": self.rows("SELECT routine_date,slept_at,updated_at FROM sleep_events WHERE routine_date BETWEEN ? AND ? ORDER BY routine_date", (from_date, to_date))}

    def save_daily_record(self, payload: dict[str, Any]) -> dict[str, Any]:
        record_date = require_date(str(payload.get("date") or ""))
        study = self.non_negative_integer(payload.get("studyMinutes"), "studyMinutes")
        entertainment = self.non_negative_integer(payload.get("entertainmentMinutes"), "entertainmentMinutes")
        reading_words = self.non_negative_integer(payload.get("readingWords") or payload.get("harryPotterWords"), "readingWords")
        start = self.non_negative_integer(payload.get("readingStartPos"), "readingStartPos", nullable=True)
        end = self.non_negative_integer(payload.get("readingEndPos"), "readingEndPos", nullable=True)
        other = payload.get("other") if isinstance(payload.get("other"), list) else []
        title = str(payload.get("readingTitle") or "").strip()
        raw = str(payload.get("rawText") or "")
        updated = shanghai_iso()
        with self.transaction():
            self.db.execute("""INSERT INTO daily_records(record_date,study_minutes,entertainment_minutes,other_json,reading_title,reading_words,reading_start_pos,reading_end_pos,raw_text,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(record_date) DO UPDATE SET study_minutes=excluded.study_minutes,entertainment_minutes=excluded.entertainment_minutes,other_json=excluded.other_json,reading_title=excluded.reading_title,reading_words=excluded.reading_words,reading_start_pos=excluded.reading_start_pos,reading_end_pos=excluded.reading_end_pos,raw_text=excluded.raw_text,updated_at=excluded.updated_at""", (record_date, study, entertainment, json.dumps(other, ensure_ascii=False, separators=(",", ":")), title, reading_words, start, end, raw, updated))
            normalized = normalize_title(title)
            if normalized:
                self.db.execute(
                    """INSERT INTO learned_english_reading_titles
                    (normalized_title,title,first_seen_date,last_seen_date,updated_at)
                    VALUES(?,?,?,?,?)
                    ON CONFLICT(normalized_title) DO UPDATE SET
                      title=excluded.title,
                      first_seen_date=MIN(first_seen_date,excluded.first_seen_date),
                      last_seen_date=MAX(last_seen_date,excluded.last_seen_date),
                      updated_at=excluded.updated_at""",
                    (normalized, title, record_date, record_date, updated),
                )
                self.rebuild_english_skill_entries()
        sleep = self.row(self.db.execute("SELECT routine_date,slept_at,updated_at FROM sleep_events WHERE routine_date=?", (record_date,)).fetchone())
        return {"ok": True, "action": "save-daily-record", "date": record_date, "studyMinutes": study, "entertainmentMinutes": entertainment, "other": other, "readingTitle": title, "readingWords": reading_words, "readingStartPos": start, "readingEndPos": end, "sleep": sleep, "updatedAt": updated}

    @staticmethod
    def non_negative_integer(value: Any, field: str, nullable: bool = False) -> int | None:
        if value in (None, ""):
            return None if nullable else 0
        if isinstance(value, bool):
            raise ValueError(f"{field} must be a non-negative integer")
        try:
            number = float(value)
        except (TypeError, ValueError) as error:
            raise ValueError(f"{field} must be a non-negative integer") from error
        if not number.is_integer() or number < 0:
            raise ValueError(f"{field} must be a non-negative integer")
        return int(number)

    def query_daily_record(self, record_date: str) -> dict[str, Any]:
        require_date(record_date)
        return {"ok": True, "action": "query-daily-record", "date": record_date, "row": self.row(self.db.execute("SELECT * FROM daily_records WHERE record_date=?", (record_date,)).fetchone()), "sleep": self.row(self.db.execute("SELECT routine_date,slept_at,updated_at FROM sleep_events WHERE routine_date=?", (record_date,)).fetchone())}

    def query_record_range(self, from_date: str, to_date: str, granularity: str) -> dict[str, Any]:
        records = self.rows("SELECT * FROM daily_records WHERE record_date BETWEEN ? AND ? ORDER BY record_date", (from_date, to_date)); sleeps = self.rows("SELECT routine_date,slept_at,updated_at FROM sleep_events WHERE routine_date BETWEEN ? AND ? ORDER BY routine_date", (from_date, to_date))
        return build_record_range(records, sleeps, from_date, to_date, granularity)

    def prepare_habit(self, habit: str, plan_date: str | None = None) -> dict[str, Any]:
        if habit not in {"water", "journal"}: raise ValueError("unsupported habit")
        plan_date = require_date(plan_date or shanghai_now().date().isoformat()); now = shanghai_iso()
        with self.transaction():
            self.db.execute("INSERT INTO habit_events(plan_date,habit,reminder_status,updated_at) VALUES(?,?,'pending',?) ON CONFLICT(plan_date,habit) DO NOTHING", (plan_date, habit, now)); row = self.db.execute("SELECT * FROM habit_events WHERE plan_date=? AND habit=?", (plan_date, habit)).fetchone()
            if row["reminder_status"] not in {"pending", "failed"}: return {"ok": True, "shouldSend": False, "reason": row["reminder_status"], "date": plan_date, "habit": habit}
            self.db.execute("UPDATE habit_events SET reminder_status='sending',reminder_error=NULL,updated_at=? WHERE plan_date=? AND habit=?", (now, plan_date, habit))
        return {"ok": True, "shouldSend": True, "date": plan_date, "habit": habit}

    def finish_habit(self, habit: str, plan_date: str, status: str, error: str | None = None) -> dict[str, Any]:
        if status not in {"sent", "failed"}: raise ValueError("invalid reminder status")
        require_date(plan_date); now = shanghai_iso(); self.db.execute("UPDATE habit_events SET reminder_status=?,reminder_sent_at=?,reminder_error=?,updated_at=? WHERE plan_date=? AND habit=?", (status, now if status == "sent" else None, error, now, plan_date, habit)); self.db.commit(); return {"ok": True, "action": "finish-habit", "date": plan_date, "habit": habit, "status": status}

    def prepare_item(self, item_id: str) -> dict[str, Any]:
        now = shanghai_iso()
        with self.transaction():
            row = self.db.execute("SELECT * FROM plan_items WHERE id=?", (item_id,)).fetchone()
            if not row or row["item_status"] != "active": return {"ok": True, "shouldSend": False, "reason": "inactive-or-missing", "itemId": item_id}
            if row["reminder_status"] not in {"pending", "pending_immediate", "failed"}: return {"ok": True, "shouldSend": False, "reason": row["reminder_status"], "itemId": item_id}
            if row["reminder_status"] != "pending_immediate":
                expires = at_shanghai(row["plan_date"], row["end_time"]) if row["end_time"] else at_shanghai(row["plan_date"], row["start_time"]) + timedelta(hours=2)
                if shanghai_now() > expires:
                    self.db.execute("UPDATE plan_items SET reminder_status='missed',reminder_error='Reminder expired before delivery',updated_at=? WHERE id=?", (now, item_id)); return {"ok": True, "shouldSend": False, "reason": "expired", "itemId": item_id}
            self.db.execute("UPDATE plan_items SET reminder_status='sending',reminder_error=NULL,updated_at=? WHERE id=?", (now, item_id))
        return {"ok": True, "shouldSend": True, "item": dict(row)}

    def finish_item(self, item_id: str, status: str, error: str | None = None) -> dict[str, Any]:
        if status not in {"sent", "failed"}: raise ValueError("invalid reminder status")
        now = shanghai_iso(); self.db.execute("UPDATE plan_items SET reminder_status=?,reminder_sent_at=?,reminder_error=?,updated_at=? WHERE id=?", (status, now if status == "sent" else None, error, now, item_id)); self.db.commit(); return {"ok": True, "action": "finish-item", "itemId": item_id, "status": status}
