"""Offline conversion of Bilibili comment XML to a small, safe ASS subset.

Modes 1/2/3 scroll left, 6 scrolls right (8 seconds); 4/5 stay at the
bottom/top (4 seconds). All modes share 28 vertical slots of 24 pixels on a
1280x720 canvas. A comment reserves enough slots for its font for its whole
lifetime; crowded comments are skipped, never queued. Text width is estimated,
not measured using installed fonts. Text over 1,000 characters, scrolling text
over 4,096 estimated pixels, and fixed text wider than the canvas margins are
skipped. Advanced/unknown modes are also skipped after parameter validation.

Input must be UTF-8 XML, at most 32 MiB, with root <i> and plain-text <d>
children. The first eight p fields are required. Time is 0..86,400 seconds
(rounded to centiseconds), mode 1..255, font size 1..64, and color 0..0xFFFFFF.
Date/pool/id must be unsigned decimal integers (63/31/64 bits respectively);
the user field must be nonempty. Additional p fields and XML metadata are ignored.

The source is never changed. Output uses <ass filename>.part then an atomic
replace; callers must serialize conversions to the same destination. The parent
directory must already exist. Invalid input and filesystem failures share the
public RuntimeError(DANMAKU_ERROR) interface, without exposing input or paths.
"""

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
import math
from pathlib import Path
import re
import unicodedata
import xml.etree.ElementTree as ET


DANMAKU_ERROR = "弹幕转换失败，请重新下载弹幕，并检查下载目录是否可写及磁盘空间是否充足。"

_MAX_XML_BYTES = 32 * 1024 * 1024
_WIDTH, _HEIGHT = 1280, 720
_MARGIN, _SLOT_HEIGHT = 24, 24
_SLOT_COUNT = (_HEIGHT - 2 * _MARGIN) // _SLOT_HEIGHT
_HEADER = """[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Danmaku,Arial,25,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,7,0,0,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


@dataclass(frozen=True)
class _Comment:
    start: int
    mode: int
    size: int
    color: int
    text: str


def _integer(value: str, minimum: int, maximum: int) -> int:
    if not re.fullmatch(r"[0-9]{1,20}", value):
        raise ValueError("Invalid integer")
    number = int(value)
    if not minimum <= number <= maximum:
        raise ValueError("Integer out of range")
    return number


def _safe_text(text: str) -> str:
    # Fullwidth lookalikes remain readable without creating ASS override blocks,
    # escapes (including \N/\n/\h), or extra physical lines in the output file.
    text = text.translate(str.maketrans({"{": "｛", "}": "｝", "\\": "＼"}))
    text = "".join(" " if unicodedata.category(char) in {"Cc", "Cf", "Zl", "Zp"}
                   else char for char in text)
    return " ".join(text.split())


def _read_comments(xml_path: Path) -> list[_Comment]:
    with xml_path.open("rb") as source:
        data = source.read(_MAX_XML_BYTES + 1)
    if len(data) > _MAX_XML_BYTES:
        raise ValueError("XML too large")
    xml = data.decode("utf-8-sig")
    # NUL rejection also prevents BOM-less UTF-16/32 from being auto-detected by
    # Expat after bypassing the declaration scan on the decoded string.
    if "\x00" in xml or re.search(r"<!\s*(?:DOCTYPE|ENTITY)\b", xml, re.IGNORECASE):
        raise ValueError("Unsafe XML declaration")
    root = ET.fromstring(xml)
    if root.tag != "i":
        raise ValueError("Wrong XML root")
    comments = []
    for element in root.findall("d"):
        fields = [field.strip() for field in element.get("p", "").split(",", 8)]
        if len(element) or len(fields) < 8 or not all(fields[:8]):
            raise ValueError("Invalid comment schema")
        if len(fields[0]) > 64:
            raise ValueError("Invalid time")
        seconds = Decimal(fields[0])
        if not seconds.is_finite() or not 0 <= seconds <= 86400:
            raise ValueError("Time out of range")
        start = int((seconds * 100).to_integral_value(rounding=ROUND_HALF_UP))
        mode = _integer(fields[1], 1, 255)
        size = _integer(fields[2], 1, 64)
        color = _integer(fields[3], 0, 0xFFFFFF)
        _integer(fields[4], 0, (1 << 63) - 1)
        _integer(fields[5], 0, (1 << 31) - 1)
        _integer(fields[7], 0, (1 << 64) - 1)
        text = element.text or ""
        if mode not in {1, 2, 3, 4, 5, 6} or len(text) > 1000:
            continue
        text = _safe_text(text)
        if text:
            comments.append(_Comment(start, mode, size, color, text))
    return sorted(comments, key=lambda comment: comment.start)


def _text_width(text: str, size: int) -> int:
    # Conservatively allow one em for non-ASCII and wide Latin glyphs, and
    # three quarters for the remaining ASCII. Include the outline and padding.
    ems = sum(0 if unicodedata.combining(char) else
              0.75 if char.isascii() and char not in "MWmw@" else 1
              for char in text)
    return math.ceil(ems * size) + 8


def _timestamp(centiseconds: int) -> str:
    seconds, fraction = divmod(centiseconds, 100)
    minutes, seconds = divmod(seconds, 60)
    hours, minutes = divmod(minutes, 60)
    return f"{hours}:{minutes:02}:{seconds:02}.{fraction:02}"


def _events(comments: list[_Comment]):
    free_at = [0] * _SLOT_COUNT
    for comment in comments:
        fixed = comment.mode in {4, 5}
        width = _text_width(comment.text, comment.size)
        if width > (_WIDTH - 2 * _MARGIN if fixed else 4096):
            continue
        span = math.ceil((comment.size * 1.4 + 4) / _SLOT_HEIGHT)
        candidates = (range(_SLOT_COUNT - span, -1, -1) if comment.mode == 4
                      else range(_SLOT_COUNT - span + 1))
        lane = next((index for index in candidates
                     if all(time <= comment.start for time in free_at[index:index + span])), None)
        if lane is None:
            continue
        end = comment.start + (400 if fixed else 800)
        free_at[lane:lane + span] = [end] * span
        y = _MARGIN + lane * _SLOT_HEIGHT
        if comment.mode == 4:
            position = f"\\an2\\pos({_WIDTH // 2},{y + span * _SLOT_HEIGHT})"
        elif comment.mode == 5:
            position = f"\\an8\\pos({_WIDTH // 2},{y})"
        elif comment.mode == 6:
            position = f"\\an7\\move({-width},{y},{_WIDTH},{y})"
        else:
            position = f"\\an7\\move({_WIDTH},{y},{-width},{y})"
        color = comment.color
        bgr = f"{color & 0xFF:02X}{(color >> 8) & 0xFF:02X}{(color >> 16) & 0xFF:02X}"
        tags = f"{{{position}\\fs{comment.size}\\c&H{bgr}&}}"
        yield (f"Dialogue: 0,{_timestamp(comment.start)},{_timestamp(end)},"
               f"Danmaku,,0,0,0,,{tags}{comment.text}\n")


def convert_danmaku(xml_path: Path, ass_path: Path) -> None:
    """Write UTF-8 ASS atomically, or raise RuntimeError(DANMAKU_ERROR)."""
    part_path = ass_path.with_name(ass_path.name + ".part")
    try:
        if xml_path.resolve() in {ass_path.resolve(), part_path.resolve()}:
            raise ValueError("Source and destination must differ")
        comments = _read_comments(xml_path)
        try:
            # Discard a previous interrupted attempt without following a stale
            # symlink or modifying an inode shared with the source via hardlink.
            part_path.unlink(missing_ok=True)
            with part_path.open("x", encoding="utf-8", newline="\n") as output:
                output.write(_HEADER)
                output.writelines(_events(comments))
            part_path.replace(ass_path)
        finally:
            try:
                part_path.unlink(missing_ok=True)
            except OSError:
                pass
    except (OSError, ValueError, ET.ParseError, InvalidOperation):
        raise RuntimeError(DANMAKU_ERROR) from None
