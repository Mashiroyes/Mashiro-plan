from __future__ import annotations

import json
import math
from datetime import date, timedelta
from typing import Any


def enumerate_dates(from_date: str, to_date: str) -> list[str]:
    start = date.fromisoformat(from_date)
    end = date.fromisoformat(to_date)
    if start > end:
        raise ValueError("from date must not be after to date")
    result: list[str] = []
    cursor = start
    while cursor <= end:
        result.append(cursor.isoformat())
        cursor += timedelta(days=1)
    return result


def parse_other_minutes(raw_json: str, warnings: list[str], record_date: str) -> int:
    try:
        value = json.loads(raw_json or "[]")
        if not isinstance(value, list):
            raise ValueError("other_json is not an array")
        total = 0
        for item in value:
            if not isinstance(item, dict):
                continue
            try:
                minutes = float(item.get("minutes") or 0)
            except (TypeError, ValueError):
                continue
            if math.isfinite(minutes) and minutes > 0:
                total += minutes
        return int(total) if total.is_integer() else total
    except (ValueError, TypeError, json.JSONDecodeError):
        warnings.append(f"{record_date} 的其他时间数据损坏，已按 0 处理")
        return 0


def sleep_clock_minutes(timestamp: str | None) -> int | None:
    if not timestamp or "T" not in timestamp:
        return None
    try:
        clock = timestamp.split("T", 1)[1][:5]
        hour, minute = (int(value) for value in clock.split(":"))
    except (ValueError, IndexError):
        return None
    if hour > 23 or minute > 59:
        return None
    return ((hour + 24) if hour < 6 else hour) * 60 + minute


def rounded_average(values: list[int]) -> int | None:
    # JavaScript Math.round parity: positive .5 values round upward.
    return math.floor(sum(values) / len(values) + 0.5) if values else None


def build_record_range(
    records: list[dict[str, Any]],
    sleeps: list[dict[str, Any]],
    from_date: str,
    to_date: str,
    granularity: str,
) -> dict[str, Any]:
    if granularity not in {"day", "month"}:
        raise ValueError("granularity must be day or month")
    dates = enumerate_dates(from_date, to_date)
    record_map = {row["record_date"]: row for row in records}
    sleep_map = {row["routine_date"]: row for row in sleeps}
    warnings: list[str] = []
    daily_points: list[dict[str, Any]] = []
    for current in dates:
        row = record_map.get(current)
        sleep = sleep_map.get(current)
        daily_points.append({
            "label": current,
            "studyMinutes": int(row["study_minutes"] if row else 0),
            "entertainmentMinutes": int(row["entertainment_minutes"] if row else 0),
            "otherMinutes": parse_other_minutes(row["other_json"], warnings, current) if row else 0,
            "readingWords": int(row["reading_words"] if row else 0),
            "sleepMinutes": sleep_clock_minutes(sleep["slept_at"]) if sleep else None,
            "hasRecord": bool(row),
            "hasSleep": bool(sleep),
        })

    points = daily_points
    if granularity == "month":
        grouped: dict[str, dict[str, Any]] = {}
        for point in daily_points:
            key = point["label"][:7]
            target = grouped.setdefault(key, {
                "label": key,
                "studyMinutes": 0,
                "entertainmentMinutes": 0,
                "otherMinutes": 0,
                "readingWords": 0,
                "sleepSamples": [],
                "hasRecord": False,
                "hasSleep": False,
            })
            for field in ("studyMinutes", "entertainmentMinutes", "otherMinutes", "readingWords"):
                target[field] += point[field]
            target["hasRecord"] = target["hasRecord"] or point["hasRecord"]
            target["hasSleep"] = target["hasSleep"] or point["hasSleep"]
            if point["sleepMinutes"] is not None:
                target["sleepSamples"].append(point["sleepMinutes"])
        points = []
        for target in grouped.values():
            samples = target.pop("sleepSamples")
            target["sleepMinutes"] = rounded_average(samples)
            points.append(target)

    totals = {
        field: sum(point[field] for point in daily_points)
        for field in ("studyMinutes", "entertainmentMinutes", "otherMinutes", "readingWords")
    }
    sleep_samples = [point["sleepMinutes"] for point in daily_points if point["sleepMinutes"] is not None]
    return {
        "ok": True,
        "action": "query-record-range",
        "fromDate": from_date,
        "toDate": to_date,
        "granularity": granularity,
        "totals": totals,
        "averageSleepMinutes": rounded_average(sleep_samples),
        "recordedDays": len(records),
        "sleepDays": len(sleep_samples),
        "warnings": warnings,
        "points": points,
    }
