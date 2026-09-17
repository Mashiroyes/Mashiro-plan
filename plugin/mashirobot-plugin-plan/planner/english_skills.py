from __future__ import annotations

import json
import os
from calendar import monthrange
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Any


CONFIG_PATH = Path(os.environ.get("OPENCLAW_ENGLISH_KEYWORDS_PATH") or Path(__file__).resolve().parents[2] / "mashirobot-plugin-language" / "config" / "english-skill-keywords.json")
CORE_SKILLS = ("listening", "speaking", "reading", "writing")
SKILLS = (*CORE_SKILLS, "anki")
LABELS = {"listening": "听力", "speaking": "口语", "reading": "阅读", "writing": "写作", "anki": "Anki"}
SHANGHAI = timezone(timedelta(hours=8), "Asia/Shanghai")


def load_config() -> dict[str, Any]:
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    custom = config.get("customKeywords", {})
    if not isinstance(custom, dict):
        raise ValueError("customKeywords must be an object")
    keywords = config.get("keywords")
    if not isinstance(keywords, dict):
        raise ValueError("keywords must be an object")
    for category in SKILLS:
        values = keywords.get(category)
        if not isinstance(values, list) or not all(isinstance(value, str) for value in values):
            raise ValueError(f"keywords.{category} must be a string array")
        extras = custom.get(category, [])
        if not isinstance(extras, list) or not all(isinstance(value, str) for value in extras):
            raise ValueError(f"customKeywords.{category} must be a string array")
        keywords[category] = list(dict.fromkeys([*values, *extras]))
    return config


def normalize_title(title: str) -> str:
    return " ".join(str(title or "").casefold().split())


def classify_title(title: str, config: dict[str, Any] | None = None) -> str | None:
    source = normalize_title(title)
    compact_source = "".join(source.split())
    selected = config or load_config()
    for category in selected["precedence"]:
        if any(
            (normalized_keyword := normalize_title(keyword)) in source
            or "".join(normalized_keyword.split()) in compact_source
            for keyword in selected["keywords"][category]
        ):
            return category
    return None


def duration_minutes(start_time: str, end_time: str | None) -> int:
    if not end_time:
        return 0
    start_hour, start_minute = (int(value) for value in start_time.split(":"))
    end_hour, end_minute = (int(value) for value in end_time.split(":"))
    start = start_hour * 60 + start_minute
    end = end_hour * 60 + end_minute
    if end < start:
        end += 24 * 60
    return max(0, end - start)


def date_labels(from_date: str, to_date: str, granularity: str) -> list[str]:
    start = date.fromisoformat(from_date)
    end = date.fromisoformat(to_date)
    if start > end:
        raise ValueError("from date must not be after to date")
    if granularity == "month":
        labels = []
        cursor = start.replace(day=1)
        while cursor <= end:
            labels.append(cursor.strftime("%Y-%m"))
            days = monthrange(cursor.year, cursor.month)[1]
            cursor = (cursor + timedelta(days=days)).replace(day=1)
        return labels
    if granularity != "day":
        raise ValueError("granularity must be day or month")
    return [(start + timedelta(days=offset)).isoformat() for offset in range((end - start).days + 1)]


def training_end_at(row: dict[str, Any]) -> datetime | None:
    start_text = str(row.get("start_time") or "")
    end_text = str(row.get("end_time") or "")
    if not start_text or not end_text:
        return None
    try:
        start_value = time.fromisoformat(start_text)
        end_value = time.fromisoformat(end_text)
        end_at = datetime.combine(date.fromisoformat(str(row["plan_date"])), end_value, tzinfo=SHANGHAI)
    except (KeyError, TypeError, ValueError):
        return None
    if end_value < start_value:
        end_at += timedelta(days=1)
    return end_at


def format_idle_minutes(minutes: int) -> str:
    days, remaining = divmod(max(0, minutes), 24 * 60)
    hours, rest = divmod(remaining, 60)
    parts = ([f"{days}天"] if days else []) + ([f"{hours}小时"] if hours else []) + ([f"{rest}分钟"] if rest else [])
    return "".join(parts) or "0分钟"


def build_inactivity_reminders(rows: list[dict[str, Any]], now: datetime) -> list[dict[str, Any]]:
    latest: dict[str, datetime] = {}
    for row in rows:
        category = str(row.get("category") or "")
        if category not in CORE_SKILLS:
            continue
        end_at = training_end_at(row)
        if end_at and (category not in latest or end_at > latest[category]):
            latest[category] = end_at
    reminders = []
    for category in CORE_SKILLS:
        end_at = latest.get(category)
        if not end_at:
            reminders.append({"category": category, "lastTrainingAt": None, "inactiveMinutes": None})
            continue
        inactive_minutes = max(0, int((now - end_at).total_seconds() // 60))
        if inactive_minutes > 24 * 60:
            reminders.append({"category": category, "lastTrainingAt": end_at.isoformat(), "inactiveMinutes": inactive_minutes})
    return reminders


def format_inactivity_warning(reminders: list[dict[str, Any]]) -> str | None:
    if not reminders:
        return None
    lines = []
    for reminder in reminders:
        label = LABELS[str(reminder["category"])]
        last = reminder.get("lastTrainingAt")
        if not last:
            lines.append(f"{label}暂无训练记录。")
            continue
        last_at = datetime.fromisoformat(str(last)).astimezone(SHANGHAI)
        lines.append(f"{label}上次训练 {last_at.month}月{last_at.day}日 {last_at:%H:%M}，已 {format_idle_minutes(int(reminder['inactiveMinutes']))} 未练。")
    return "间隔提醒：" + " ".join(lines) + " 不必一开始就坚持一小时，先开始十分钟，也是在进步。"


def build_summary(rows: list[dict[str, Any]], from_date: str, to_date: str, granularity: str, latest_rows: list[dict[str, Any]] | None = None, now: datetime | None = None) -> dict[str, Any]:
    labels = date_labels(from_date, to_date, granularity)
    points = [{"label": label, **{skill: 0 for skill in SKILLS}} for label in labels]
    by_label = {point["label"]: point for point in points}
    totals = {skill: 0 for skill in SKILLS}
    recorded_dates = set()
    for row in rows:
        category = str(row["category"])
        if category not in totals:
            continue
        minutes = max(0, int(row["minutes"] or 0))
        totals[category] += minutes
        recorded_dates.add(str(row["plan_date"]))
        if category in SKILLS:
            label = str(row["plan_date"])[:7] if granularity == "month" else str(row["plan_date"])
            if label in by_label:
                by_label[label][category] += minutes
    four_total = sum(totals[skill] for skill in CORE_SKILLS)
    five_total = sum(totals[skill] for skill in SKILLS)
    percentages = {
        skill: (totals[skill] * 100 / five_total if five_total else 0.0)
        for skill in SKILLS
    }
    all_english = five_total
    warning = None
    if len(recorded_dates) >= 3 and all_english > 0:
        dominant_skill = max(SKILLS, key=lambda skill: totals[skill])
        if percentages[dominant_skill] >= 80:
            warning = f"偏科提醒：{LABELS[dominant_skill]} 已占英语计划时间的 {percentages[dominant_skill]:.1f}%，请补充其余训练。"
    current = now or datetime.now(SHANGHAI)
    if current.tzinfo is None:
        current = current.replace(tzinfo=SHANGHAI)
    reminders = build_inactivity_reminders(latest_rows if latest_rows is not None else rows, current.astimezone(SHANGHAI))
    return {
        "ok": True,
        "action": "query-english-skills",
        "fromDate": from_date,
        "toDate": to_date,
        "granularity": granularity,
        "totals": totals,
        "percentages": percentages,
        "fourSkillsMinutes": four_total,
        "fiveSkillsMinutes": five_total,
        "englishMinutesWithAnki": all_english,
        "recordedDays": len(recorded_dates),
        "warning": warning,
        "inactivityReminders": reminders,
        "inactivityWarning": format_inactivity_warning(reminders),
        "points": points,
    }
