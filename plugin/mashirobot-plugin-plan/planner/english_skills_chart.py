from __future__ import annotations

import math
from pathlib import Path
from typing import Any

from PIL import Image, ImageColor, ImageDraw, ImageFont


WIDTH = 1600
HEIGHT = 1460
SKILLS = ("listening", "speaking", "reading", "writing", "anki")
LABELS = {"listening": "听", "speaking": "说", "reading": "读", "writing": "写", "anki": "Anki"}
COLORS = {
    "listening": "#2563EB",
    "speaking": "#F97316",
    "reading": "#16A34A",
    "writing": "#9333EA",
    "anki": "#0EA5E9",
}
FONT_REGULAR = Path(r"C:\Windows\Fonts\msyh.ttc")
FONT_BOLD = Path(r"C:\Windows\Fonts\msyhbd.ttc")


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    selected = FONT_BOLD if bold and FONT_BOLD.exists() else FONT_REGULAR
    return ImageFont.truetype(str(selected), size)


def duration_text(minutes: float) -> str:
    value = max(0, round(float(minutes)))
    hours, rest = divmod(value, 60)
    if not hours:
        return f"{rest} 分钟"
    return f"{hours} 小时" + (f" {rest} 分钟" if rest else "")


def draw_pie(draw: ImageDraw.ImageDraw, payload: dict[str, Any]) -> None:
    totals = payload.get("totals") or {}
    values = [max(0, float(totals.get(skill) or 0)) for skill in SKILLS]
    total = sum(values)
    bounds = (75, 160, 585, 670)
    if total <= 0:
        draw.ellipse(bounds, fill="#E2E8F0", outline="#CBD5E1", width=3)
        draw.text((205, 380), "暂无五项记录", font=font(30, True), fill="#475569")
    else:
        start = -90.0
        for skill, value in zip(SKILLS, values):
            sweep = value / total * 360.0
            if sweep > 0:
                draw.pieslice(bounds, start=start, end=start + sweep, fill=COLORS[skill], outline="#FFFFFF", width=3)
            start += sweep
    draw.text((680, 155), "五项学习占比", font=font(34, True), fill="#0F172A")
    percentages = payload.get("percentages") or {}
    for index, skill in enumerate(SKILLS):
        y = 225 + index * 100
        draw.rounded_rectangle((685, y, 745, y + 60), radius=10, fill=COLORS[skill])
        draw.text((775, y - 2), LABELS[skill], font=font(30, True), fill="#0F172A")
        draw.text((850, y), duration_text(values[index]), font=font(27), fill="#334155")
        draw.text((1195, y), f"{float(percentages.get(skill) or 0):.1f}%", font=font(30, True), fill=COLORS[skill])


def label_step(count: int) -> int:
    if count <= 12:
        return 1
    if count <= 31:
        return max(1, math.ceil(count / 10))
    return max(1, math.ceil(count / 12))


def mixed_color(color: str, strength: float) -> tuple[int, int, int]:
    red, green, blue = ImageColor.getrgb(color)
    amount = min(1.0, max(0.0, strength))
    return tuple(round(255 + (value - 255) * amount) for value in (red, green, blue))


def heat_text(minutes: float, show_values: bool) -> str:
    if minutes <= 0 or not show_values:
        return ""
    rounded = round(minutes)
    hours, remainder = divmod(rounded, 60)
    if hours and remainder:
        return f"{hours}h{remainder}m"
    if hours:
        return f"{hours}h"
    return f"{remainder}m"


def heat_strength(minutes: float) -> float:
    """Use a fixed daily scale: 0-1h shallow, 1.5h medium, 7h darkest."""
    value = max(0.0, float(minutes))
    if value <= 60:
        return 0.10 + 0.18 * (value / 60)
    if value <= 90:
        return 0.28 + 0.17 * ((value - 60) / 30)
    return 0.45 + 0.55 * min((value - 90) / 330, 1.0)


def draw_heatmap(draw: ImageDraw.ImageDraw, points: list[dict[str, Any]]) -> None:
    x1, y1, x2, y2 = 45, 735, WIDTH - 45, 1355
    draw.rounded_rectangle((x1, y1, x2, y2), radius=18, fill="#F8FAFC", outline="#CBD5E1", width=2)
    draw.text((x1 + 24, y1 + 16), "每日学习热力格", font=font(30, True), fill="#0F172A")
    draw.text((x1 + 255, y1 + 21), "0–1小时浅色，1.5小时起为中等深度，7小时及以上最深；空格表示未记录", font=font(18), fill="#64748B")
    left, right = x1 + 135, x2 - 22
    header_y, grid_top, row_height = y1 + 92, y1 + 125, 82
    count = max(1, len(points))
    cell_width = (right - left) / count
    label_font = font(14)
    value_font = font(16, True)
    step = label_step(len(points))
    for index, point in enumerate(points):
        cell_left = left + index * cell_width
        if index % step == 0 or index == len(points) - 1:
            label = str(point.get("label") or "")
            label = label[5:] if len(label) == 10 else label
            text_box = draw.textbbox((0, 0), label, font=label_font)
            draw.text((cell_left + (cell_width - (text_box[2] - text_box[0])) / 2, header_y), label, font=label_font, fill="#475569")
    for row, skill in enumerate(SKILLS):
        top = grid_top + row * row_height
        draw.text((x1 + 24, top + 23), LABELS[skill], font=font(23, True), fill=COLORS[skill])
        for index, point in enumerate(points):
            value = max(0.0, float(point.get(skill) or 0))
            cell_left = left + index * cell_width + 3
            cell_right = left + (index + 1) * cell_width - 3
            strength = heat_strength(value) if value else 0.0
            fill = mixed_color(COLORS[skill], strength) if value else "#E2E8F0"
            draw.rounded_rectangle((cell_left, top, cell_right, top + 58), radius=8, fill=fill)
            text = heat_text(value, len(points) <= 17)
            if text:
                box = draw.textbbox((0, 0), text, font=value_font)
                draw.text((cell_left + (cell_right - cell_left - (box[2] - box[0])) / 2, top + 18), text, font=value_font, fill="#0F172A")


def generate_english_skills_chart(payload: dict[str, Any], output_path: str | Path) -> dict[str, Any]:
    points = payload.get("points")
    if not isinstance(points, list) or not points:
        raise ValueError("英语能力图表数据为空")
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    image = Image.new("RGB", (WIDTH, HEIGHT), "#FFFFFF")
    draw = ImageDraw.Draw(image)
    draw.text((54, 35), "英语五项学习仪表盘", font=font(44, True), fill="#0F172A")
    draw.text((58, 98), f"{payload.get('fromDate', '')} 至 {payload.get('toDate', '')} · 计划时长", font=font(25), fill="#475569")
    draw_pie(draw, payload)
    draw_heatmap(draw, points)
    footer_y = 1390
    warning = str(payload.get("warning") or "")
    if warning:
        draw.text((55, footer_y), warning, font=font(22, True), fill="#DC2626")
    image.save(output, format="PNG", optimize=True)
    return {"ok": True, "outputPath": str(output), "width": WIDTH, "height": HEIGHT, "pointCount": len(points)}
