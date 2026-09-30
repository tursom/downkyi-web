from pathlib import Path
import re
from xml.sax.saxutils import escape

import pytest

from backend import danmaku
from backend.danmaku import DANMAKU_ERROR, convert_danmaku


def _p(time="0", mode=1, size=25, color=16777215):
    return f"{time},{mode},{size},{color},1700000000,0,abc123,123456789"


def _xml(*comments):
    return ("<i>" + "".join(f'<d p="{params}">{escape(text)}</d>'
                           for params, text in comments) + "</i>").encode("utf-8")


def _convert(tmp_path, data):
    source, target = tmp_path / "comments.xml", tmp_path / "comments.ass"
    source.write_bytes(data)
    assert convert_danmaku(source, target) is None
    assert source.read_bytes() == data
    assert not target.with_name(target.name + ".part").exists()
    return target.read_text(encoding="utf-8")


def _events(ass):
    # ASS's first nine commas delimit fields; commas in the text are literal.
    return [line.removeprefix("Dialogue: ").split(",", 9)
            for line in ass.splitlines() if line.startswith("Dialogue: ")]


def _move(event):
    match = re.search(r"\\move\((-?\d+),(\d+),(-?\d+),(\d+)\)", event[9])
    assert match
    return tuple(map(int, match.groups()))


@pytest.mark.parametrize("mode", [1, 2, 3])
def test_scrolling_timestamp_direction_color_and_utf8(tmp_path, mode):
    ass = _convert(tmp_path, _xml((_p("3661.235", mode, 36, 0x123456), "你好, world")))
    assert "ScriptType: v4.00+" in ass
    assert "PlayResX: 1280\nPlayResY: 720" in ass
    assert "WrapStyle: 2" in ass
    event, = _events(ass)
    assert event[:4] == ["0", "1:01:01.24", "1:01:09.24", "Danmaku"]
    x1, y1, x2, y2 = _move(event)
    assert x1 == 1280 and x2 < 0 and y1 == y2 == 24
    assert r"\an7" in event[9]
    assert r"\fs36\c&H563412&" in event[9]
    assert event[9].endswith("你好, world")


def test_reverse_scroll_starts_offscreen_on_left(tmp_path):
    event, = _events(_convert(tmp_path, _xml((_p(mode=6), "反向"))))
    assert _move(event) == (-58, 24, 1280, 24)
    assert event[1:3] == ["0:00:00.00", "0:00:08.00"]


@pytest.mark.parametrize(("mode", "position"), [(4, r"\an2\pos(640,696)"),
                                               (5, r"\an8\pos(640,24)")])
def test_fixed_comments_have_top_or_bottom_alignment(tmp_path, mode, position):
    event, = _events(_convert(tmp_path, _xml((_p("59.999", mode), "固定"))))
    assert event[1:3] == ["0:01:00.00", "0:01:04.00"]
    assert position in event[9]
    assert r"\move" not in event[9]


@pytest.mark.parametrize(("color", "bgr"), [(0xFF0000, "0000FF"), (0x00FF00, "00FF00"),
                                           (0x0000FF, "FF0000"), (0, "000000"),
                                           (0xFFFFFF, "FFFFFF")])
def test_primary_colors_are_bgr(tmp_path, color, bgr):
    event, = _events(_convert(tmp_path, _xml((_p(color=color), "color"))))
    assert f"\\c&H{bgr}&" in event[9]


def test_hostile_text_cannot_add_tags_escapes_or_events(tmp_path):
    text = "{\\pos(0,0)\\p1}x\\N\\n\\h\r\nDialogue: 0,evil\t\x85\u2028\u2029\u202e结束 & <ok>"
    ass = _convert(tmp_path, _xml((_p(), text)))
    event, = _events(ass)
    tags, payload = event[9].split("}", 1)
    assert tags.startswith(r"{\an7\move(")
    assert payload == "｛＼pos(0,0)＼p1｝x＼N＼n＼h Dialogue: 0,evil 结束 & <ok>"
    assert not any(char in payload for char in "{}\\\r\n\t\x85\u2028\u2029\u202e")


@pytest.mark.parametrize("data", [b"<i/>", b"<i><chatserver>example</chatserver></i>",
                                  b'\xef\xbb\xbf<?xml version="1.0" encoding="UTF-8"?><i/>'])
def test_empty_xml_writes_valid_ass_header(tmp_path, data):
    ass = _convert(tmp_path, data)
    assert "[V4+ Styles]" in ass and "Style: Danmaku,Arial,25," in ass
    assert "[Events]\nFormat: Layer, Start, End," in ass
    assert _events(ass) == []


@pytest.mark.parametrize("data", [
    b"", b"not XML", b"<i>", b"<html/>", b"[]", b"<i/>trailing", b"<i>\xff</i>",
    b'<i xmlns="unexpected"/>', b'<i><d p="0,1,25,16777215,1,0,u,1">&#1;</d></i>',
    '<i/>'.encode("utf-16"), '<i/>'.encode("utf-16-le"),
    b'<!DOCTYPE i><i/>',
    b'<!DOCTYPE i SYSTEM "file:///private"><i/>',
    b'<!DOCTYPE i [<!ENTITY x "expanded">]><i>&x;</i>',
    b'<!ENTITY x SYSTEM "https://example.invalid/private"><i/>',
    b'<i><![CDATA[<!ENTITY x "value">]]></i>',
    '<!DOCTYPE i [<!ENTITY x "expanded">]><i>&x;</i>'.encode("utf-16-le"),
])
def test_invalid_xml_is_safe_and_does_not_replace_existing_ass(tmp_path, data):
    source, target = tmp_path / "private.xml", tmp_path / "comments.ass"
    source.write_bytes(data)
    target.write_bytes(b"previous complete subtitle")
    with pytest.raises(RuntimeError) as caught:
        convert_danmaku(source, target)
    assert str(caught.value) == DANMAKU_ERROR
    assert caught.value.__suppress_context__
    assert source.read_bytes() == data
    assert target.read_bytes() == b"previous complete subtitle"
    assert not (tmp_path / "comments.ass.part").exists()


def test_dtd_is_rejected_before_elementtree(tmp_path, monkeypatch):
    def unexpected_parse(*args):
        pytest.fail("DTD reached the XML parser")

    monkeypatch.setattr(danmaku.ET, "fromstring", unexpected_parse)
    source = tmp_path / "comments.xml"
    source.write_bytes(b'<!DOCTYPE i [<!ENTITY x "expanded">]><i>&x;</i>')
    with pytest.raises(RuntimeError, match=DANMAKU_ERROR):
        convert_danmaku(source, tmp_path / "comments.ass")


def test_missing_xml_has_public_error(tmp_path):
    with pytest.raises(RuntimeError, match=DANMAKU_ERROR):
        convert_danmaku(tmp_path / "missing.xml", tmp_path / "comments.ass")
    assert not (tmp_path / "comments.ass").exists()


@pytest.mark.parametrize("element", [
    "<d>missing</d>", '<d p="">empty</d>', '<d p="0,1,25,16777215">short</d>',
    '<d p="0,1,25,16777215,1,0,u,1"><b>nested markup</b></d>',
])
def test_missing_params_or_nested_comment_fail(tmp_path, element):
    source = tmp_path / "comments.xml"
    source.write_text(f"<i>{element}</i>", encoding="utf-8")
    with pytest.raises(RuntimeError, match=DANMAKU_ERROR):
        convert_danmaku(source, tmp_path / "comments.ass")


@pytest.mark.parametrize(("index", "value"), [
    *[(index, "") for index in range(8)],
    (0, "NaN"), (0, "Infinity"), (0, "-Infinity"), (0, "1e999999"),
    (0, "-0.01"), (0, "86400.01"), (0, "invalid"), (0, "1" * 65),
    (1, "nan"), (1, "1.5"), (1, "0"), (1, "-1"), (1, "256"),
    (2, "0"), (2, "-1"), (2, "65"), (2, "nan"), (2, "25.5"),
    (3, "-1"), (3, "16777216"), (3, "red"), (3, "1e6"),
    (4, "date"), (4, "-1"), (4, str(1 << 63)),
    (5, "pool"), (5, "-1"), (5, str(1 << 31)),
    (6, "   "), (7, "id"), (7, "-1"), (7, str(1 << 64)), (7, "9" * 100),
])
def test_invalid_required_fields_fail_even_for_empty_text(tmp_path, index, value):
    fields = _p().split(",")
    fields[index] = value
    source = tmp_path / "comments.xml"
    source.write_bytes(_xml((",".join(fields), "")))
    with pytest.raises(RuntimeError, match=DANMAKU_ERROR):
        convert_danmaku(source, tmp_path / "comments.ass")
    assert not (tmp_path / "comments.ass").exists()


def test_parameter_boundaries_extra_fields_and_centisecond_rounding(tmp_path):
    data = _xml(("86400,1,64,16777215,9223372036854775807,2147483647,u,18446744073709551615,extra", "最大"),
                ("0.005,6,1,0,0,0,0,0", "最小"))
    first, last = _events(_convert(tmp_path, data))
    assert first[1:3] == ["0:00:00.01", "0:00:08.01"]
    assert last[1:3] == ["24:00:00.00", "24:00:08.00"]
    assert r"\fs1\c&H000000&" in first[9]
    assert r"\fs64\c&HFFFFFF&" in last[9]


def test_unsupported_modes_skip_but_validate_their_schema(tmp_path):
    data = _xml(*[(_p(mode=mode), "unsupported") for mode in (7, 8, 9, 42)],
                (_p(), "普通"))
    event, = _events(_convert(tmp_path, data))
    assert event[9].endswith("普通")
    source = tmp_path / "comments.xml"
    source.write_bytes(_xml((_p(mode=7, color=-1), "unsupported")))
    with pytest.raises(RuntimeError, match=DANMAKU_ERROR):
        convert_danmaku(source, tmp_path / "comments.ass")


def test_input_limit_is_enforced_before_parsing(tmp_path, monkeypatch):
    monkeypatch.setattr(danmaku, "_MAX_XML_BYTES", 32)
    _convert(tmp_path, b"<i>" + b" " * 25 + b"</i>")
    source = tmp_path / "comments.xml"
    source.write_bytes(b"<i>" + b" " * 26 + b"</i>")
    with pytest.raises(RuntimeError, match=DANMAKU_ERROR):
        convert_danmaku(source, tmp_path / "comments.ass")


def test_slots_are_shared_between_directions_and_fixed_comments(tmp_path):
    data = _xml((_p(mode=1, size=64), "large"), (_p(mode=6), "reverse"),
                (_p(mode=5), "top"), (_p(mode=4), "bottom"))
    normal, reverse, top, bottom = _events(_convert(tmp_path, data))
    assert _move(normal)[1] == 24
    assert _move(reverse)[1] >= 24 + 64 * 1.4 + 4
    assert r"\pos(640,168)" in top[9]
    assert r"\pos(640,696)" in bottom[9]


def test_dense_comments_skip_until_their_whole_lifetime_ends(tmp_path):
    comments = [(_p(), f"first-{index}") for index in range(20)]
    comments += [(_p("7.99", mode=6), "still-full"), (_p("8"), "reuse")]
    events = _events(_convert(tmp_path, _xml(*comments)))
    assert len(events) == 15  # 28 slots, two per 25-pixel comment, then one reuse.
    ys = [_move(event)[1] for event in events[:-1]]
    assert len(set(ys)) == 14
    assert all(b - a >= 39 for a, b in zip(ys, ys[1:]))
    assert not any("still-full" in event[9] for event in events)
    assert events[-1][1] == "0:00:08.00"
    assert events[-1][9].endswith("reuse")
    assert _move(events[-1])[1] == ys[0]


def test_fixed_lanes_release_after_four_seconds_and_input_is_sorted(tmp_path):
    comments = [(_p("4", mode=5), "later"),
                *[(_p(mode=5), f"fixed-{index}") for index in range(14)],
                (_p("3.99", mode=4), "too-early")]
    events = _events(_convert(tmp_path, _xml(*comments)))
    assert len(events) == 15
    assert events[0][9].endswith("fixed-0")
    assert events[-1][9].endswith("later")
    assert r"\pos(640,24)" in events[-1][9]
    assert events[-1][1:3] == ["0:00:04.00", "0:00:08.00"]
    assert not any("too-early" in event[9] for event in events)


def test_larger_fonts_and_wide_text_move_fully_offscreen(tmp_path):
    events = _events(_convert(tmp_path, _xml((_p(), "iiii"), (_p(), "汉字汉字"),
                                            (_p(size=50), "汉字汉字"))))
    assert [_move(event)[2] for event in events] == [-83, -108, -208]


def test_oversized_and_blank_text_skip_without_occupying_lanes(tmp_path):
    data = _xml((_p(), "a" * 1001), (_p(size=64), "宽" * 65),
                (_p(mode=5), "宽" * 50), (_p(), " \n\t "), (_p(), "visible"))
    event, = _events(_convert(tmp_path, data))
    assert event[9].endswith("visible")
    assert _move(event)[1] == 24


def test_replace_failure_preserves_source_and_old_ass_then_retry_succeeds(tmp_path, monkeypatch):
    source, target, part = (tmp_path / name for name in ("comments.xml", "comments.ass", "comments.ass.part"))
    data = b'<?xml version="1.0" encoding="UTF-8"?>\r\n' + _xml((_p(), "你好"))
    source.write_bytes(data)
    target.write_bytes(b"old complete ASS")
    part.write_bytes(b"stale interrupted attempt")
    original_replace = Path.replace
    attempts = []

    def fail_replace(self, destination):
        attempts.append((self, destination))
        assert self == part and destination == target
        assert self.read_text(encoding="utf-8").endswith("你好\n")
        assert target.read_bytes() == b"old complete ASS"
        raise OSError("private-path disk error")

    monkeypatch.setattr(Path, "replace", fail_replace)
    with pytest.raises(RuntimeError) as caught:
        convert_danmaku(source, target)
    assert str(caught.value) == DANMAKU_ERROR
    assert attempts == [(part, target)]
    assert target.read_bytes() == b"old complete ASS"
    assert source.read_bytes() == data
    assert not part.exists()
    monkeypatch.setattr(Path, "replace", original_replace)
    part.write_bytes(b"another interrupted attempt")
    convert_danmaku(source, target)
    assert _events(target.read_text(encoding="utf-8"))[0][9].endswith("你好")
    assert source.read_bytes() == data
    assert not part.exists()


def test_partial_write_is_cleaned_up(tmp_path, monkeypatch):
    source, target = tmp_path / "comments.xml", tmp_path / "comments.ass"
    data = _xml((_p(), "test"))
    source.write_bytes(data)
    target.write_bytes(b"old subtitle")

    def fail_events(comments):
        yield "partial event\n"
        raise OSError("disk full")

    monkeypatch.setattr(danmaku, "_events", fail_events)
    with pytest.raises(RuntimeError, match=DANMAKU_ERROR):
        convert_danmaku(source, target)
    assert source.read_bytes() == data
    assert target.read_bytes() == b"old subtitle"
    assert not (tmp_path / "comments.ass.part").exists()


@pytest.mark.parametrize("alias", ["output", "part", "symlink-output", "symlink-part"])
def test_source_cannot_be_used_as_output_or_staging_file(tmp_path, alias):
    source, target, part = (tmp_path / name for name in ("comments.xml", "comments.ass", "comments.ass.part"))
    data = _xml((_p(), "original"))
    if alias == "output":
        target = source
    elif alias == "part":
        source = part
    elif alias == "symlink-output":
        target.symlink_to(source)
    else:
        part.symlink_to(source)
    source.write_bytes(data)
    with pytest.raises(RuntimeError, match=DANMAKU_ERROR):
        convert_danmaku(source, target)
    assert source.read_bytes() == data


def test_missing_destination_directory_uses_public_error(tmp_path):
    source = tmp_path / "comments.xml"
    source.write_bytes(b"<i/>")
    with pytest.raises(RuntimeError, match=DANMAKU_ERROR):
        convert_danmaku(source, tmp_path / "missing" / "comments.ass")
    assert source.read_bytes() == b"<i/>"
