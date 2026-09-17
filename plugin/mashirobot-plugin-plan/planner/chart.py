from __future__ import annotations

import math
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont


WIDTH = 1600
HEIGHT = 1880
COLORS = {
    "studyMinutes": "#2563EB",
    "entertainmentMinutes": "#F97316",
    "otherMinutes": "#9333EA",
    "readingWords": "#16A34A",
    "sleepMinutes": "#DC2626",
}
FONT_REGULAR = Path(r"C:\Windows\Fonts\msyh.ttc")
FONT_BOLD = Path(r"C:\Windows\Fonts\msyhbd.ttc")


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    selected = FONT_BOLD if bold and FONT_BOLD.exists() else FONT_REGULAR
    return ImageFont.truetype(str(selected), size)


def label_step(count: int) -> int:
    if count <= 12:
        return 1
    if count <= 20:
        return 2
    return 4


def short_label(value: str) -> str:
    return value[5:] if len(value) >= 10 else value


def sleep_tick(minutes: float) -> str:
    rounded = math.floor(minutes + 0.5)
    wrapped = rounded % 1440
    hour, minute = divmod(wrapped, 60)
    prefix = "次日" if rounded >= 1440 else ""
    return f"{prefix}{hour:02d}:{minute:02d}"


def panel(draw: ImageDraw.ImageDraw, bounds: tuple[int, int, int, int], title: str) -> tuple[int, int, int, int]:
    x1, y1, x2, y2 = bounds
    draw.rectangle(bounds, fill="#F8FAFC", outline="#CBD5E1", width=1)
    draw.text((x1 + 18, y1 + 12), title, font=font(28, True), fill="#1E293B")
    return x1 + 105, y1 + 62, x2 - 25, y2 - 48


def draw_axes(draw: ImageDraw.ImageDraw, plot: tuple[int, int, int, int]) -> None:
    left, top, right, bottom = plot
    draw.line((left, top, left, bottom), fill="#64748B", width=2)
    draw.line((left, bottom, right, bottom), fill="#64748B", width=2)


def draw_bar_panel(
    draw: ImageDraw.ImageDraw,
    bounds: tuple[int, int, int, int],
    title: str,
    points: list[dict[str, Any]],
    field: str,
    color: str,
    hours: bool,
) -> None:
    plot = panel(draw, bounds, title)
    left, top, right, bottom = plot
    plot_width, plot_height = right - left, bottom - top
    values = [float(point.get(field) or 0) for point in points]
    maximum = max(values, default=0) or 1
    axis_font = font(16)
    for grid in range(5):
        ratio = grid / 4
        y = round(bottom - plot_height * ratio)
        draw.line((left, y, right, y), fill="#CBD5E1", width=1)
        tick = maximum * ratio
        text = f"{tick / 60:.1f}".rstrip("0").rstrip(".") + "h" if hours else f"{tick:,.0f}"
        draw.text((bounds[0] + 10, y - 10), text, font=axis_font, fill="#1E293B")
    draw_axes(draw, plot)
    count = max(1, len(points))
    slot = plot_width / count
    bar_width = max(5, min(42, slot * 0.62))
    step = label_step(len(points))
    for index, point in enumerate(points):
        value = values[index]
        height = max(2, plot_height * value / maximum) if value > 0 else 0
        x = left + slot * index + (slot - bar_width) / 2
        y = bottom - height
        if height:
            draw.rectangle((round(x), round(y), round(x + bar_width), bottom), fill=color)
        if index % step == 0 or index == len(points) - 1:
            draw.text((round(x - 10), bottom + 8), short_label(str(point.get("label", ""))), font=axis_font, fill="#1E293B")


def draw_sleep_panel(draw: ImageDraw.ImageDraw, bounds: tuple[int, int, int, int], points: list[dict[str, Any]]) -> None:
    plot = panel(draw, bounds, "睡觉时间趋势")
    left, top, right, bottom = plot
    plot_width, plot_height = right - left, bottom - top
    samples = [float(point["sleepMinutes"]) for point in points if point.get("sleepMinutes") is not None]
    if not samples:
        draw.text((left + 30, top + plot_height / 2), "暂无睡觉记录", font=font(28, True), fill="#1E293B")
        return
    minimum = max(0, min(samples) - 60)
    maximum = max(samples) + 60
    if maximum - minimum < 180:
        maximum = minimum + 180
    axis_font = font(16)
    for grid in range(5):
        ratio = grid / 4
        y = round(bottom - plot_height * ratio)
        draw.line((left, y, right, y), fill="#CBD5E1", width=1)
        draw.text((bounds[0] + 5, y - 10), sleep_tick(minimum + (maximum - minimum) * ratio), font=axis_font, fill="#1E293B")
    draw_axes(draw, plot)
    count = max(1, len(points))
    slot = plot_width / count
    step = label_step(len(points))
    previous: tuple[float, float] | None = None
    for index, point in enumerate(points):
        x = left + slot * index + slot / 2
        value = point.get("sleepMinutes")
        if value is None:
            previous = None
        else:
            y = bottom - plot_height * ((float(value) - minimum) / (maximum - minimum))
            if previous:
                draw.line((*previous, x, y), fill=COLORS["sleepMinutes"], width=4)
            draw.ellipse((x - 5, y - 5, x + 5, y + 5), fill=COLORS["sleepMinutes"])
            previous = (x, y)
        if index % step == 0 or index == len(points) - 1:
            draw.text((round(x - 24), bottom + 8), short_label(str(point.get("label", ""))), font=axis_font, fill="#1E293B")


def generate_chart(payload: dict[str, Any], output_path: str | Path) -> dict[str, Any]:
    points = payload.get("points")
    if not isinstance(points, list) or not points:
        raise ValueError("图表数据为空。")
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    image = Image.new("RGB", (WIDTH, HEIGHT), "#FFFFFF")
    draw = ImageDraw.Draw(image)
    draw.text((44, 24), "学习与作息记录", font=font(42, True), fill="#1E293B")
    draw.text((46, 78), f"{payload.get('fromDate', '')} 至 {payload.get('toDate', '')}", font=font(28, True), fill="#1E293B")
    panel_height, panel_gap, panel_top = 325, 20, 125
    bounds = [(40, panel_top + index * (panel_height + panel_gap), WIDTH - 40, panel_top + index * (panel_height + panel_gap) + panel_height) for index in range(5)]
    draw_bar_panel(draw, bounds[0], "学习时间", points, "studyMinutes", COLORS["studyMinutes"], True)
    draw_bar_panel(draw, bounds[1], "娱乐时间", points, "entertainmentMinutes", COLORS["entertainmentMinutes"], True)
    draw_bar_panel(draw, bounds[2], "其他时间", points, "otherMinutes", COLORS["otherMinutes"], True)
    draw_bar_panel(draw, bounds[3], "英文小说阅读字数", points, "readingWords", COLORS["readingWords"], False)
    draw_sleep_panel(draw, bounds[4], points)
    image.save(output, format="PNG", optimize=True)
    return {"ok": True, "outputPath": str(output), "pointCount": len(points), "width": WIDTH, "height": HEIGHT}
