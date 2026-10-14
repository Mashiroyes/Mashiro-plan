"""Phone-only clock/state policy; no Android or filesystem side effects."""
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import math
import re

COOLDOWN_SECONDS = 3 * 3600
SHANGHAI = timezone(timedelta(hours=8), "Asia/Shanghai")
PERMANENT_BLOCK_MESSAGE = "手机 QQ 已永久禁止访问，不能临时启用"


def local_time(clock):
    return datetime.fromtimestamp(clock.wall, SHANGHAI)


def forbidden(clock):
    hour = local_time(clock).hour
    return hour < 12 or hour >= 22


def seconds_to_cutoff(clock):
    now = local_time(clock)
    cutoff = now.replace(hour=22, minute=0, second=0, microsecond=0)
    return max(0, (cutoff - now).total_seconds())


def parse_play(text):
    match = re.fullmatch(r"玩\s*QQ\s*([0-9]+)\s*分钟", text.strip(), re.IGNORECASE)
    if not match:
        return None
    minutes = int(match[1])
    if minutes < 1:
        raise ValueError("游玩分钟数必须是正整数")
    return minutes


@dataclass(frozen=True)
class Clock:
    boot: str
    elapsed: float
    wall: float


def idle(clock):
    return {"schema": 1, "phase": "ready", "boot": clock.boot,
            "play_end": 0, "cooldown_end": 0, "last_elapsed": clock.elapsed}


def validate(state):
    if not isinstance(state, dict) or state.get("schema") != 1:
        raise ValueError("状态文件版本或格式错误")
    if state.get("phase") not in {"ready", "playing", "cooldown"}:
        raise ValueError("状态阶段错误")
    if not isinstance(state.get("boot"), str) or not state["boot"]:
        raise ValueError("启动标识错误")
    for key in ("play_end", "cooldown_end", "last_elapsed"):
        value = state.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
            raise ValueError("状态期限错误")
    if state["phase"] == "playing" and state["cooldown_end"] != state["play_end"] + COOLDOWN_SECONDS:
        raise ValueError("游玩期限与冷却期限不一致")
    return state


def recover(clock):
    return idle(clock)


def reconcile(state, clock):
    validate(state)
    # Permanent policy invalidates every legacy authorization immediately.
    # "ready" now means that permanent blocking is active, not that play is allowed.
    return idle(clock)


def begin(state, clock, minutes):
    if isinstance(minutes, bool) or not isinstance(minutes, int) or minutes < 1:
        raise ValueError("游玩分钟数必须是正整数")
    raise ValueError(PERMANENT_BLOCK_MESSAGE)


def remaining(state, clock):
    state = reconcile(state, clock)
    key = "play_end" if state["phase"] == "playing" else "cooldown_end"
    return 0 if state["phase"] == "ready" else max(0, math.ceil(state[key] - clock.elapsed))
