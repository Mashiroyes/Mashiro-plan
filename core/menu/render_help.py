"""Deterministic Pillow renderer for MashiroBot help images."""

from __future__ import annotations

import argparse
import base64
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from PIL.PngImagePlugin import PngInfo


TEMPLATE_VERSION = 3
BACKGROUND_LEFT = (238, 222, 255)
BACKGROUND_RIGHT = (198, 226, 255)
TEXT_COLOR = (30, 35, 48)
MUTED_COLOR = (112, 118, 132)
CARD_FILL = (255, 255, 255, 210)
CARD_OUTLINE = (255, 255, 255, 235)
PAGE_HEIGHT = 1680
CONTENT_BOTTOM = 1550
AVATAR_PATH = Path(__file__).resolve().parent / "assets" / "mashiro-avatar.jpg"


def _font(size: int, *, italic: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = []
    if italic:
        candidates.extend(
            [
                Path("C:/Windows/Fonts/ariali.ttf"),
                Path("C:/Windows/Fonts/segoeuii.ttf"),
            ]
        )
    candidates.extend(
        [
            Path("C:/Windows/Fonts/msyh.ttc"),
            Path("C:/Windows/Fonts/simhei.ttf"),
            Path("C:/Windows/Fonts/segoeui.ttf"),
        ]
    )
    for candidate in candidates:
        if candidate.is_file():
            return ImageFont.truetype(str(candidate), size=size)
    return ImageFont.load_default(size=size)


def _gradient(width: int, height: int) -> Image.Image:
    image = Image.new("RGB", (width, height), BACKGROUND_LEFT)
    pixels = image.load()
    denominator = max(width - 1, 1)
    for x in range(width):
        ratio = x / denominator
        color = tuple(
            round(BACKGROUND_LEFT[channel] * (1 - ratio) + BACKGROUND_RIGHT[channel] * ratio)
            for channel in range(3)
        )
        for y in range(height):
            pixels[x, y] = color
    return image


def _rounded_card(image: Image.Image, box: tuple[int, int, int, int], radius: int = 28) -> None:
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    draw.rounded_rectangle(box, radius=radius, fill=CARD_FILL, outline=CARD_OUTLINE, width=2)
    image.paste(overlay, (0, 0), overlay)


def _wrap_text(draw: ImageDraw.ImageDraw, text: str, font, max_width: int) -> list[str]:
    lines = []
    for paragraph in str(text).splitlines() or [""]:
        if not paragraph:
            lines.append("")
            continue
        current = ""
        for character in paragraph:
            candidate = current + character
            if current and draw.textlength(candidate, font=font) > max_width:
                lines.append(current)
                current = character
            else:
                current = candidate
        if current:
            lines.append(current)
    return lines


def _draw_wrapped(
    draw: ImageDraw.ImageDraw,
    position: tuple[int, int],
    text: str,
    font,
    fill,
    max_width: int,
    line_gap: int = 8,
) -> int:
    x, y = position
    line_height = font.size + line_gap if hasattr(font, "size") else 32
    for line in _wrap_text(draw, text, font, max_width):
        draw.text((x, y), line, font=font, fill=fill)
        y += line_height
    return y


def _record_visible_text(image: Image.Image, values: list[str]) -> None:
    image.info["mashirobot-template-version"] = str(TEMPLATE_VERSION)
    image.info["mashirobot-text"] = "\n".join(str(value) for value in values)


def _avatar_circle(size: int = 224) -> Image.Image | None:
    try:
        source = Image.open(AVATAR_PATH).convert("RGB")
        side = min(source.size)
        left = (source.width - side) // 2
        top = (source.height - side) // 2
        avatar = source.crop((left, top, left + side, top + side)).resize((size, size), Image.Resampling.LANCZOS).convert("RGBA")
        mask = Image.new("L", avatar.size, 0)
        ImageDraw.Draw(mask).ellipse((4, 4, size - 5, size - 5), fill=255)
        avatar.putalpha(mask)
        return avatar
    except (OSError, ValueError):
        return None


def render_main_menu(
    plugins: list[dict],
    width: int = 1200,
    columns: int = 2,
    unavailable_plugin_count: int = 0,
) -> Image.Image:
    if columns != 2:
        raise ValueError("MashiroBot main menu uses exactly two columns")
    rows = max(1, math.ceil(len(plugins) / columns))
    header_height = 330
    card_height = 245
    row_gap = 28
    footer_height = 85
    height = header_height + rows * card_height + max(rows - 1, 0) * row_gap + footer_height
    image = _gradient(width, height)
    draw = ImageDraw.Draw(image)
    title_font = _font(66)
    subtitle_font = _font(31)
    card_title_font = _font(40)
    body_font = _font(28)
    number_font = _font(42, italic=True)

    avatar = _avatar_circle()
    title_x = 55
    if avatar:
        image.paste(avatar, (55, 40), avatar)
        draw = ImageDraw.Draw(image)
        draw.ellipse((55, 40, 279, 264), outline=(255, 255, 255), width=5)
        title_x = 320
    draw.text((title_x, 64), "MashiroBot", font=title_font, fill=TEXT_COLOR)
    draw.text((title_x, 148), "帮助菜单 · 回复插件序号，35 秒内有效", font=subtitle_font, fill=TEXT_COLOR)
    draw.text((title_x, 202), "发送 /计划 可直接查看计划插件", font=body_font, fill=MUTED_COLOR)

    margin = 42
    column_gap = 28
    card_width = (width - margin * 2 - column_gap) // 2
    visible_text = ["MashiroBot", "帮助菜单", "回复插件序号，35 秒内有效"]
    for index, plugin in enumerate(plugins):
        row = index // columns
        column = index % columns
        left = margin + column * (card_width + column_gap)
        top = header_height + row * (card_height + row_gap)
        right = left + card_width
        bottom = top + card_height
        _rounded_card(image, (left, top, right, bottom))
        draw = ImageDraw.Draw(image)
        name = str(plugin.get("name", "未命名插件"))
        description = str(plugin.get("description", ""))
        menu_index = int(plugin.get("menuIndex", index + 1))
        number = f"No.{menu_index}"
        draw.text((left + 28, top + 24), name, font=card_title_font, fill=TEXT_COLOR)
        _draw_wrapped(
            draw,
            (left + 28, top + 90),
            description,
            body_font,
            TEXT_COLOR,
            card_width - 56,
        )
        number_width = draw.textlength(number, font=number_font)
        draw.text(
            (right - number_width - 27, bottom - 60),
            number,
            font=number_font,
            fill=(145, 149, 160),
        )
        visible_text.extend([name, description, number])

    if unavailable_plugin_count:
        unavailable = f"另有 {unavailable_plugin_count} 个插件不可用，请检查本地日志"
        draw.text((margin, height - 55), unavailable, font=body_font, fill=MUTED_COLOR)
        visible_text.append(unavailable)

    _record_visible_text(image, visible_text)
    return image


def _normalize_groups(payload: dict) -> list[dict]:
    groups = payload.get("groups") or []
    normalized = []
    for group in groups:
        if not isinstance(group, dict):
            continue
        title = str(group.get("title", "功能"))
        items = [str(item) for item in group.get("items", [])]
        if not items:
            items = ["暂无说明"]
        for offset in range(0, len(items), 8):
            chunk = items[offset : offset + 8]
            chunk_title = title if offset == 0 else f"{title}（续）"
            normalized.append({"title": chunk_title, "items": chunk})
    return normalized


def _group_height(group: dict) -> int:
    # A conservative Chinese-width estimate keeps wrapped commands inside a
    # bounded card before the actual draw pass performs pixel-based wrapping.
    line_count = sum(max(1, math.ceil((len(item) + 2) / 18)) for item in group["items"])
    return 105 + 36 * line_count + 8 * len(group["items"])


def _paginate_groups(groups: list[dict]) -> list[list[tuple[int, int, dict]]]:
    pages: list[list[tuple[int, int, dict]]] = []
    placements: list[tuple[int, int, dict]] = []
    tops = [260, 260]
    gap = 24
    for group in groups:
        height = _group_height(group)
        candidates = [column for column in range(2) if tops[column] + height <= CONTENT_BOTTOM]
        if not candidates:
            pages.append(placements)
            placements = []
            tops = [260, 260]
            candidates = [0, 1]
        column = min(candidates, key=lambda value: tops[value])
        placements.append((column, tops[column], group))
        tops[column] += height + gap
    if placements or not pages:
        pages.append(placements)
    return pages


def render_plugin_help(payload: dict, width: int = 1200) -> list[Image.Image]:
    plugin = payload.get("plugin") or {}
    name = str(plugin.get("name", "插件"))
    menu_index = int(plugin.get("menuIndex", 1))
    detailed = bool(payload.get("detailed"))
    groups = _normalize_groups(payload)
    pages = _paginate_groups(groups)
    result = []
    margin = 42
    column_gap = 26
    card_width = (width - margin * 2 - column_gap) // 2
    title_font = _font(58)
    subtitle_font = _font(29)
    group_font = _font(34)
    item_font = _font(27)

    for page_index, placements in enumerate(pages, start=1):
        image = _gradient(width, PAGE_HEIGHT)
        draw = ImageDraw.Draw(image)
        title = f"{name}插件帮助"
        draw.text((55, 46), title, font=title_font, fill=TEXT_COLOR)
        subtitle = (
            f"No.{menu_index} · 完整指令 · 第 {page_index}/{len(pages)} 页"
            if detailed
            else f"No.{menu_index} · 功能分组 · 发送 {plugin.get('detailedCommand', '/插件详细')} 查看完整指令"
        )
        draw.text((58, 136), subtitle, font=subtitle_font, fill=MUTED_COLOR)
        visible_text = [title, subtitle]

        for column, top, group in placements:
            left = margin + column * (card_width + column_gap)
            right = left + card_width
            bottom = top + _group_height(group)
            _rounded_card(image, (left, top, right, bottom), radius=24)
            draw = ImageDraw.Draw(image)
            draw.text((left + 26, top + 22), group["title"], font=group_font, fill=TEXT_COLOR)
            y = top + 78
            for item in group["items"]:
                lines = _wrap_text(draw, f"• {item}", item_font, card_width - 52)
                for line in lines:
                    draw.text((left + 26, y), line, font=item_font, fill=TEXT_COLOR)
                    y += 36
                y += 8
            visible_text.append(group["title"])
            visible_text.extend(group["items"])

        draw.text(
            (55, PAGE_HEIGHT - 70),
            "MashiroBot · 本地脚本处理，不调用 GPT",
            font=_font(25),
            fill=MUTED_COLOR,
        )
        _record_visible_text(image, visible_text)
        result.append(image)
    return result


def _png_metadata(image: Image.Image) -> PngInfo:
    metadata = PngInfo()
    for key, value in image.info.items():
        metadata.add_text(str(key), str(value))
    return metadata


def _page_path(output: Path, page_number: int) -> Path:
    if page_number == 1:
        return output
    stem = output.stem[:-2] if output.stem.endswith("-1") else output.stem
    return output.with_name(f"{stem}-{page_number}{output.suffix}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--payload-base64", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    payload = json.loads(base64.b64decode(args.payload_base64).decode("utf-8"))
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    if payload["kind"] == "main":
        images = [
            render_main_menu(
                payload.get("plugins", []),
                width=1200,
                columns=2,
                unavailable_plugin_count=int(payload.get("unavailablePluginCount", 0)),
            )
        ]
    else:
        images = render_plugin_help(payload, width=1200)
    for page_number, image in enumerate(images, start=1):
        image.save(
            _page_path(output, page_number),
            format="PNG",
            pnginfo=_png_metadata(image),
            optimize=False,
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
