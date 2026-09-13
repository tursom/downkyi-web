"""Isolated Bilibili extraction and download workers (Python 3.11+).

The parent owns authentication, cookie snapshots, cache IDs and unique task dirs.
Parse subprocess protocol: NDJSON progress records followed by exactly one
{event: "parsed", result: {...}} or {event: "error", message: ...} record.
Download protocol is documented in IMPLEMENTATION.md.
Quality is a height ceiling, codec is a strict stream filter (not transcoding).
Interactive branches and legacy multi-video fragments are unavailable because
URL-only jobs cannot independently identify them. All networking is restricted
to Bilibili pages/APIs/CDNs, including urllib redirects.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import sys
from urllib.parse import parse_qs, urljoin, urlsplit
import urllib.request

MAX_ENTRIES = 100
PARSE_TIMEOUT = 180
MAX_PROTOCOL_LINE_BYTES = 1024 * 1024
MAX_PROTOCOL_BYTES = 4 * MAX_PROTOCOL_LINE_BYTES
MAX_INPUT_BYTES = 16 * 1024
UNSUPPORTED = "不支持此链接，请输入 Bilibili BV/av 视频、番剧 ep/ss 或受支持的合集链接。"
NETWORK_ERROR = "连接 Bilibili 失败，请检查网络后重试。"
TIMEOUT_ERROR = "解析超时，请缩小合集范围或稍后重试。"
NO_FORMATS = "没有可用媒体流，可能需要登录或该内容暂不可用。"
FORMAT_ERROR = "没有符合所选清晰度或编码的媒体流，请更换选项或更新登录凭据。"
VALIDATION_ERROR = "媒体文件校验失败，未标记完成；请重试或检查 FFmpeg。"
DEPENDENCY_ERROR = "缺少 yt-dlp、FFmpeg 或 ffprobe，请安装所需组件。"
GENERIC_ERROR = "媒体处理失败，请稍后重试或更新 yt-dlp。"
RATE_ERROR = "Bilibili 请求受到限制，请稍后重试。"
AUTH_ERROR = "该内容需要有效登录或相应权限，请更新登录凭据后重试。"
UNAVAILABLE_ERROR = "该内容已失效或受地区限制，暂时无法访问。"
DISK_ERROR = "磁盘空间不足，请清理空间后重试。"
PARTIAL_WARNING = "部分条目不可用，已保留实际获取的信息。"
RETRY_CHANGED_ERROR = "该项目的信息已发生变化，请重新解析原链接。"
COLLECTION_ERROR = "未能确认视频所属合集，本次仅解析当前视频。"
SAFE_ERRORS = {UNSUPPORTED, NETWORK_ERROR, TIMEOUT_ERROR, NO_FORMATS, FORMAT_ERROR,
               VALIDATION_ERROR, DEPENDENCY_ERROR, GENERIC_ERROR, RATE_ERROR,
               AUTH_ERROR, UNAVAILABLE_ERROR, DISK_ERROR, COLLECTION_ERROR, RETRY_CHANGED_ERROR}
BV = r"BV[0-9A-Za-z]{10}"
VIDEO_ID = rf"(?:{BV}|av[1-9][0-9]*)"
EXTRACTOR_NAMES = (
    "BiliBiliIE", "BiliBiliBangumiIE", "BiliBiliBangumiSeasonIE",
    "BilibiliCollectionListIE", "BilibiliSeriesListIE", "BilibiliFavoritesListIE",
)
NETWORK_DOMAINS = ("bilibili.com", "bilivideo.com", "bilivideo.cn", "hdslb.com", "biliimg.com")


def sanitize_error(error: object) -> str:
    """Classify, never interpolate upstream exception text or logger messages."""
    text = str(error)
    if text in SAFE_ERRORS:
        return text
    lower = text.lower()
    if isinstance(error, (TimeoutError, asyncio.TimeoutError)) or "timed out" in lower:
        return TIMEOUT_ERROR
    if isinstance(error, (ImportError, FileNotFoundError)) or "ffmpeg not found" in lower or "ffprobe not found" in lower:
        return DEPENDENCY_ERROR
    if any(word in lower for word in ("429", "412", "rate limit", "risk control", "风控")):
        return RATE_ERROR
    if any(word in lower for word in ("login", "cookie", "premium", "vip", "supporter-only", "403")):
        return AUTH_ERROR
    if any(word in lower for word in ("404", "deleted", "geo-restrict", "not available", "地区")):
        return UNAVAILABLE_ERROR
    if any(word in lower for word in ("requested format", "no video formats", "no formats")):
        return FORMAT_ERROR
    if isinstance(error, (ConnectionError, socket.gaierror, urllib.error.URLError)) or any(
            word in lower for word in ("network", "connection", "resolve", "ssl", "http error", "urlopen")):
        return NETWORK_ERROR
    if any(word in lower for word in ("no space", "disk full")):
        return DISK_ERROR
    return GENERIC_ERROR


def _split_url(value: str):
    if not isinstance(value, str) or not value or len(value) > 4096:
        raise ValueError(UNSUPPORTED)
    if re.search(r"[\x00-\x20\x7f\\]", value):
        raise ValueError(UNSUPPORTED)
    try:
        parsed = urlsplit(value)
        if (parsed.scheme not in ("http", "https") or parsed.username is not None
                or parsed.password is not None or not parsed.hostname
                or parsed.port not in (None, 443 if parsed.scheme == "https" else 80)):
            raise ValueError(UNSUPPORTED)
        return parsed
    except ValueError:
        raise ValueError(UNSUPPORTED) from None


def canonical_url(value: str, *, allow_short: bool = True) -> str:
    """Accept only explicitly supported page shapes; discard tracking parameters."""
    if not isinstance(value, str):
        raise ValueError(UNSUPPORTED)
    value = value.strip()
    if re.fullmatch(VIDEO_ID, value):
        return f"https://www.bilibili.com/video/{value}"
    if re.fullmatch(r"(?:ep|ss)[1-9][0-9]*", value):
        return f"https://www.bilibili.com/bangumi/play/{value}"
    parsed = _split_url(value)
    host, path = parsed.hostname, parsed.path.rstrip("/")
    try:
        query = parse_qs(parsed.query, keep_blank_values=True, max_num_fields=100)
    except ValueError:
        raise ValueError(UNSUPPORTED) from None

    def parameter(key: str, default: str = "") -> str:
        values = query.get(key, [default])
        if len(values) != 1:
            raise ValueError(UNSUPPORTED)
        return values[0]

    def number(key: str) -> str:
        val = parameter(key)
        if not re.fullmatch(r"[1-9][0-9]{0,19}", val):
            raise ValueError(UNSUPPORTED)
        return val

    if allow_short and host == "b23.tv" and re.fullmatch(r"/[A-Za-z0-9]{1,64}", path):
        return f"https://b23.tv{path}"
    if host in ("www.bilibili.com", "bilibili.com", "m.bilibili.com"):
        if re.fullmatch(rf"/video/{VIDEO_ID}", path):
            part = f"?p={number('p')}" if "p" in query else ""
            return f"https://www.bilibili.com{path}{part}"
        if re.fullmatch(r"/bangumi/play/(?:ep|ss)[1-9][0-9]*", path):
            return f"https://www.bilibili.com{path}"
        match = re.fullmatch(r"/(?:list|medialist/play)/([1-9][0-9]*)", path)
        if match:
            mid = match[1]
            if "sid" in query:
                return f"https://space.bilibili.com/{mid}/channel/seriesdetail?sid={number('sid')}"
            if parameter("business") in ("space_series", "space_collection"):
                kind = "series" if parameter("business") == "space_series" else "collection"
                return f"https://space.bilibili.com/{mid}/channel/{kind}detail?sid={number('business_id')}"
        match = re.fullmatch(r"/(?:list|medialist/play|medialist/detail)/ml([1-9][0-9]*)", path)
        if match:
            return f"https://www.bilibili.com/medialist/detail/ml{match[1]}"
    if host == "space.bilibili.com":
        match = re.fullmatch(r"/([1-9][0-9]*)/channel/(collection|series)detail", path)
        if match:
            return f"https://space.bilibili.com/{match[1]}/channel/{match[2]}detail?sid={number('sid')}"
        match = re.fullmatch(r"/([1-9][0-9]*)/lists(?:/([1-9][0-9]*))?", path)
        if match and parameter("type", "season") in ("season", "series"):
            sid = match[2] or number("sid")
            kind = "series" if parameter("type") == "series" else "collection"
            return f"https://space.bilibili.com/{match[1]}/channel/{kind}detail?sid={sid}"
        match = re.fullmatch(r"/([1-9][0-9]*)/favlist", path)
        if match:
            return f"https://www.bilibili.com/medialist/detail/ml{number('fid')}"
    raise ValueError(UNSUPPORTED)


def _public_host(host: str) -> None:
    addresses = socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(item[4][0]).is_global for item in addresses):
        raise ValueError(UNSUPPORTED)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _resolve_url(value: str) -> str:
    url = canonical_url(value)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
    seen = set()
    for _ in range(5):
        if urlsplit(url).hostname != "b23.tv":
            return canonical_url(url, allow_short=False)
        if url in seen:
            raise ValueError(UNSUPPORTED)
        seen.add(url)
        _public_host("b23.tv")
        request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
        try:
            response = opener.open(request, timeout=15)
        except urllib.error.HTTPError as exc:
            if exc.code not in (301, 302, 303, 307, 308):
                exc.close()
                raise RuntimeError(NETWORK_ERROR) from None
            response = exc
        with response:
            if response.code not in (301, 302, 303, 307, 308):
                raise ValueError(UNSUPPORTED)
            location = response.headers.get("Location", "")
            if not location:
                raise ValueError(UNSUPPORTED)
            url = canonical_url(urljoin(url, location))
    raise ValueError(UNSUPPORTED)


class _Logger:
    def __init__(self):
        self.warnings: list[str] = []

    def debug(self, message):
        pass

    def info(self, message):
        pass

    def warning(self, message):
        if "subtitles are only available when logged in" in str(message).lower():
            safe = "字幕需要登录后才能获取，不影响当前可用视频的下载。"
        else:
            safe = sanitize_error(message)
        if safe not in self.warnings and len(self.warnings) < 10:
            self.warnings.append(safe)

    def error(self, message):
        pass


def _network_url(url: str) -> None:
    parsed = _split_url(url)
    if not any(parsed.hostname == domain or parsed.hostname.endswith("." + domain)
               for domain in NETWORK_DOMAINS):
        raise ValueError(UNSUPPORTED)


class _NetworkGuard(urllib.request.BaseHandler):
    # urllib invokes request processors again on redirects, before opening a socket.
    handler_order = 100

    def http_request(self, req):
        _network_url(req.full_url)
        _public_host(urlsplit(req.full_url).hostname)
        return req

    https_request = http_request
    ftp_request = http_request
    file_request = http_request
    data_request = http_request


def _video_collection(ydl, url: str) -> tuple[str, dict] | None:
    """Discover a root video's UGC season; playlist children and downloads skip this."""
    parsed = urlsplit(url)
    match = re.fullmatch(rf"/video/({VIDEO_ID})", parsed.path)
    if not match or "p" in parse_qs(parsed.query):
        return None
    from yt_dlp.networking import Request

    identity = match[1]
    query = f"bvid={identity}" if identity.startswith("BV") else f"aid={identity[2:]}"
    try:
        request = Request(f"https://api.bilibili.com/x/web-interface/view?{query}",
                          headers={"Referer": "https://www.bilibili.com/"})
        with ydl.urlopen(request) as response:
            payload = response.read(8 * 1024 * 1024 + 1)
        if len(payload) > 8 * 1024 * 1024:
            raise ValueError(COLLECTION_ERROR)
        result = json.loads(payload)
        if result.get("code") != 0 or not isinstance(result.get("data"), dict):
            raise ValueError(COLLECTION_ERROR)
        data = result["data"]
        season = data.get("ugc_season") or {}
        sid = season.get("id") or data.get("season_id")
        if not sid:
            return None
        mid = season.get("mid") or (data.get("owner") or {}).get("mid")
        if not all(re.fullmatch(r"[1-9][0-9]{0,19}", str(value)) for value in (mid, sid)):
            raise ValueError(COLLECTION_ERROR)
        collection_url = canonical_url(f"https://space.bilibili.com/{mid}/channel/collectiondetail?sid={sid}",
                                       allow_short=False)
        metadata = {}
        for section in season.get("sections") or []:
            if not isinstance(section, dict):
                continue
            for episode in section.get("episodes") or []:
                if not isinstance(episode, dict) or not re.fullmatch(BV, str(episode.get("bvid", ""))):
                    continue
                arc = episode.get("arc")
                arc = arc if isinstance(arc, dict) else {}
                metadata[f"https://www.bilibili.com/video/{episode['bvid']}"] = {
                    "title": episode.get("title") or arc.get("title"),
                    "duration": arc.get("duration"), "thumbnail": arc.get("pic"),
                }
        return collection_url, metadata
    except Exception:
        # Metadata discovery must not prevent an otherwise playable video from parsing.
        ydl.report_warning(COLLECTION_ERROR)
        return None


def _make_ydl(options: dict):
    from yt_dlp import YoutubeDL
    from yt_dlp.extractor import bilibili
    from yt_dlp.networking._urllib import UrllibRH

    class RestrictedUrllibRH(UrllibRH):
        _SUPPORTED_URL_SCHEMES = ("http", "https")

        def _create_instance(self, *args, **kwargs):
            opener = super()._create_instance(*args, **kwargs)
            opener.add_handler(_NetworkGuard())
            return opener

    class BilibiliDL(YoutubeDL):
        def build_request_director(self, handlers, preferences=None):
            return super().build_request_director([RestrictedUrllibRH])

        def extract_info(self, url, *args, **kwargs):
            normalized = canonical_url(url, allow_short=False)
            key = kwargs.get("ie_key")
            if key and key not in self._ies:
                raise ValueError(UNSUPPORTED)
            if not any(ie.suitable(normalized) for ie in self._ies.values()):
                raise ValueError(UNSUPPORTED)
            if self.params.pop("downkyi_expand_collection", False):
                collection = _video_collection(self, normalized)
                if collection:
                    collection_url, metadata = collection
                    playlist = self.extract_info(collection_url, *args, **kwargs)
                    if isinstance(playlist, dict) and playlist.get("_type") == "playlist":
                        def annotated_entries():
                            for entry in playlist.get("entries") or []:
                                if isinstance(entry, dict):
                                    yield {**metadata.get(entry.get("url"), {}), **entry}
                                else:
                                    yield entry
                        return {**playlist, "entries": annotated_entries()}
                    return playlist
            return super().extract_info(normalized, *args, **kwargs)

        def urlopen(self, req):
            _network_url(req if isinstance(req, str) else getattr(req, "url", getattr(req, "full_url", "")))
            return super().urlopen(req)

    ydl = BilibiliDL(options, auto_init=False)
    for name in EXTRACTOR_NAMES:
        extractor = getattr(bilibili, name, None)
        if extractor is not None:
            ydl.add_info_extractor(extractor())
    return ydl


def _base_options(cookie_path, logger) -> dict:
    return {
        "quiet": True, "no_warnings": True, "noprogress": True, "logger": logger,
        "cookiefile": str(cookie_path) if cookie_path else None,
        "cachedir": False, "proxy": "", "socket_timeout": 20,
        "retries": 2, "fragment_retries": 2, "extractor_retries": 1,
        "ignoreerrors": False, "allowed_extractors": ["bilibili"],
        "extract_flat": False, "skip_unavailable_fragments": False,
        "usenetrc": False, "geo_bypass": False,
    }


def _number(value, default=None):
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0:
        return value
    return default


def _text(value, limit=500):
    return str(value or "")[:limit]


def _thumbnail(value):
    if not isinstance(value, str) or len(value) > 2048:
        return ""
    try:
        if value.startswith("//"):
            value = "https:" + value
        _network_url(value)
        parsed = urlsplit(value)
        return f"https://{parsed.hostname}{parsed.path}"
    except ValueError:
        return ""


def _codec(value):
    value = str(value or "").lower()
    if value.startswith(("avc", "h264")):
        return "avc"
    if value.startswith(("hev", "hvc", "h265")):
        return "hevc"
    if value.startswith(("av01", "av1")):
        return "av1"
    return None


def _entry(info: dict, url: str, group: str, error=None) -> dict:
    formats = info.get("formats") or []
    formats = [fmt for fmt in formats if isinstance(fmt, dict) and fmt.get("url")]
    available = bool(formats) and error is None
    heights = {int(fmt["height"]) for fmt in formats
               if _number(fmt.get("height"), 0) > 0 and fmt.get("vcodec") != "none"}
    codecs = {_codec(fmt.get("vcodec")) for fmt in formats} - {None}
    subtitle_tracks = {**(info.get("subtitles") or {}), **(info.get("automatic_captions") or {})}
    return {
        "id": hashlib.sha256(url.encode()).hexdigest()[:24],
        "title": _text(info.get("title")), "url": url,
        "duration": _number(info.get("duration")), "thumbnail": _thumbnail(info.get("thumbnail")),
        "group": _text(group), "available": available,
        "error": sanitize_error(error) if error else (None if available else NO_FORMATS),
        "qualities": sorted(heights, reverse=True) if available else [],
        "codecs": (["auto"] + sorted(codecs)) if available else [],
        "has_subtitles": available and any(tracks for lang, tracks in subtitle_tracks.items() if lang != "danmaku"),
    }


def parse_media(url: str, cookie_path=None, *, expand_collection=True, on_progress=None) -> dict:
    """Walk entries with an optional synchronous progress callback.

    Playlist cardinality is unknown until traversal ends: lazy pages, nested
    playlists and duplicate URLs make upstream playlist counts unreliable.
    """
    url = canonical_url(url)
    entries, seen = [], set()
    truncated = False

    def report(stage, title="", *, final=False):
        if on_progress:
            succeeded = sum(bool(entry["available"]) for entry in entries)
            on_progress({"stage": stage, "completed": len(entries),
                         "total": len(entries) if final and not truncated else None,
                         "succeeded": succeeded, "failed": len(entries) - succeeded,
                         "title": _text(title)})

    def append(entry):
        entries.append(entry)
        report("extracting", entry["title"])

    report("resolving")
    url = _resolve_url(url)
    logger = _Logger()
    options = _base_options(cookie_path, logger)
    options.update({"writesubtitles": True, "listsubtitles": True, "lazy_playlist": True,
                    "downkyi_expand_collection": expand_collection, "sleep_interval_requests": 0.25})
    visited = 0
    with _make_ydl(options) as ydl:
        root = ydl.extract_info(url, download=False, process=False)
        if not isinstance(root, dict):
            raise RuntimeError(NO_FORMATS)

        def walk(info, source, group="", ancestors=(), depth=0):
            nonlocal truncated, visited
            if len(entries) >= MAX_ENTRIES or visited >= MAX_ENTRIES * 10:
                truncated = True
                return
            visited += 1
            if depth > 12:
                truncated = True
                return
            if not isinstance(info, dict):
                logger.warning(NO_FORMATS)
                return
            kind = info.get("_type", "video")
            if kind in ("url", "url_transparent"):
                target = canonical_url(info.get("url", ""), allow_short=False)
                if target in seen:
                    return
                if target in ancestors:
                    logger.warning(UNSUPPORTED)
                    return
                report("extracting", info.get("title"))
                try:
                    full = ydl.extract_info(target, download=False, process=False)
                    if full is None:
                        raise RuntimeError(NO_FORMATS)
                except Exception as exc:
                    if target not in seen:
                        append(_entry(info, target, group, exc))
                        seen.add(target)
                    return
                walk(full, target, group, (*ancestors, target), depth + 1)
                return
            if kind in ("playlist", "multi_video"):
                if kind == "multi_video":
                    # Legacy FLV fragments cannot be selected by the URL-only job contract.
                    append(_entry(info, source, group, UNSUPPORTED))
                    return
                child_group = _text(info.get("title")) or group
                report("listing", child_group)
                try:
                    for child in info.get("entries") or []:
                        if len(entries) >= MAX_ENTRIES or visited >= MAX_ENTRIES * 10:
                            truncated = True
                            break
                        walk(child, source, child_group, ancestors, depth + 1)
                except Exception as exc:
                    if not entries:
                        raise
                    logger.warning(exc)
                    truncated = True
                return
            candidate = info.get("webpage_url") or source
            target = canonical_url(candidate, allow_short=False)
            identity = re.fullmatch(rf"({BV})(?:_p([1-9][0-9]*))?", str(info.get("id", "")))
            if identity:
                part = identity[2] or parse_qs(urlsplit(target).query).get("p", [None])[0]
                target = f"https://www.bilibili.com/video/{identity[1]}" + (f"?p={part}" if part else "")
            if target in seen:
                return
            seen.add(target)
            # Inline interactive branches have no independently addressable page URL.
            interactive = bool(info.get("id") and "_" in str(info["id"]) and not re.fullmatch(rf"{BV}_p[0-9]+", str(info["id"])))
            append(_entry(info, target, group, UNSUPPORTED if interactive else None))

        walk(root, url)
    report("extracting", root.get("title"), final=True)
    if not entries:
        raise RuntimeError(NO_FORMATS)
    warnings = list(logger.warnings)
    if truncated:
        warnings.append("结果超过处理范围，仅显示前 100 个条目；请使用更具体的链接。")
    if any(not entry["available"] for entry in entries):
        warnings.append(PARTIAL_WARNING)
    return {"title": _text(root.get("title")) or entries[0]["title"],
            "thumbnail": _thumbnail(root.get("thumbnail")) or entries[0]["thumbnail"],
            "entries": entries, "truncated": truncated, "warnings": warnings}


def retry_media(urls: list[str], cookie_path=None, *, on_progress=None) -> dict:
    """Retry selected URLs; on_progress is synchronous and counts URLs, not walks."""
    if not isinstance(urls, list) or not 1 <= len(urls) <= MAX_ENTRIES:
        raise ValueError(UNSUPPORTED)
    targets = [canonical_url(url, allow_short=False) for url in urls]
    if len(set(targets)) != len(targets):
        raise ValueError(UNSUPPORTED)
    entries, warnings = [], []

    def report(title=""):
        if on_progress:
            succeeded = sum(bool(entry["available"]) for entry in entries)
            on_progress({"stage": "extracting", "completed": len(entries),
                         "total": len(targets), "succeeded": succeeded,
                         "failed": len(entries) - succeeded, "title": _text(title)})

    report()
    for target in targets:
        try:
            result = parse_media(target, cookie_path, expand_collection=False)
            matches = [entry for entry in result["entries"] if entry["url"] == target]
            if len(matches) != 1:
                raise RuntimeError(RETRY_CHANGED_ERROR)
            entries.append(matches[0])
            for warning in result["warnings"]:
                if warning not in warnings and len(warnings) < 10:
                    warnings.append(warning)
        except Exception as error:
            entries.append(_entry({}, target, "", error))
        report(entries[-1].get("title"))
    return {"entries": entries, "warnings": warnings}


async def _stop_process(process):
    with contextlib.suppress(ProcessLookupError):
        os.killpg(process.pid, signal.SIGTERM)
    try:
        await asyncio.wait_for(process.wait(), 1)
    except asyncio.TimeoutError:
        pass
    finally:
        # The leader may already have exited while a descendant is still running.
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
        await process.wait()


def validate_parse_progress(value):
    if (not isinstance(value, dict) or set(value) != {
            "stage", "completed", "total", "succeeded", "failed", "title"}
            or value["stage"] not in ("resolving", "listing", "extracting")
            or not isinstance(value["title"], str) or len(value["title"]) > 500):
        raise RuntimeError(GENERIC_ERROR)
    for key in ("completed", "succeeded", "failed"):
        if type(value[key]) is not int or not 0 <= value[key] <= MAX_ENTRIES:
            raise RuntimeError(GENERIC_ERROR)
    total = value["total"]
    if (value["completed"] != value["succeeded"] + value["failed"]
            or (total is not None and (type(total) is not int
                or not value["completed"] <= total <= MAX_ENTRIES))):
        raise RuntimeError(GENERIC_ERROR)
    return value


class _ParseProtocol:
    def __init__(self, on_progress):
        self.on_progress = on_progress
        self.terminal = None
        self.previous = None

    async def line(self, line):
        if self.terminal is not None or not line or len(line) > MAX_PROTOCOL_LINE_BYTES:
            raise RuntimeError(GENERIC_ERROR)
        event = json.loads(line)
        if not isinstance(event, dict):
            raise RuntimeError(GENERIC_ERROR)
        kind = event.get("event")
        if kind == "progress":
            progress = validate_parse_progress(event.get("progress"))
            if self.previous and (any(progress[key] < self.previous[key]
                    for key in ("completed", "succeeded", "failed"))
                    or (self.previous["total"] is not None
                        and progress["total"] != self.previous["total"])):
                raise RuntimeError(GENERIC_ERROR)
            self.previous = progress.copy()
            if self.on_progress:
                await self.on_progress(progress)
        elif kind == "parsed":
            result = event.get("result")
            if (not isinstance(result, dict) or not isinstance(result.get("entries"), list)
                    or len(result["entries"]) > MAX_ENTRIES):
                raise RuntimeError(GENERIC_ERROR)
            if self.previous:
                entries = result["entries"]
                succeeded = sum(bool(entry["available"]) for entry in entries)
                if (self.previous["completed"] != len(entries)
                        or (self.previous["total"] != len(entries)
                            and not (result.get("truncated") is True and self.previous["total"] is None))
                        or self.previous["succeeded"] != succeeded):
                    raise RuntimeError(GENERIC_ERROR)
            self.terminal = event
        elif kind == "error" and isinstance(event.get("message"), str):
            self.terminal = event
        else:
            raise RuntimeError(GENERIC_ERROR)


class MediaService:
    def __init__(self, config):
        self.config = config

    async def parse(self, url: str, cookie_path: Path | None = None, *, on_progress=None) -> dict:
        """on_progress, when supplied, is awaited with each progress dictionary."""
        return await self._extract("parse", {"url": canonical_url(url)}, cookie_path, on_progress)

    async def retry(self, urls: list[str], cookie_path: Path | None = None, *, on_progress=None) -> dict:
        """on_progress follows the same asynchronous contract as parse."""
        return await self._extract("retry", {"urls": urls}, cookie_path, on_progress)

    async def _extract(self, operation: str, payload: dict, cookie_path: Path | None, on_progress=None) -> dict:
        payload = json.dumps({**payload, "progress": True, "cookie_path": str(cookie_path) if cookie_path else None}).encode()
        if len(payload) > MAX_INPUT_BYTES:
            raise ValueError(UNSUPPORTED)
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "backend.media", operation, "-",
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL, start_new_session=True,
            cwd=str(Path(__file__).resolve().parents[1]),
        )
        try:
            async with asyncio.timeout(PARSE_TIMEOUT):
                process.stdin.write(payload)
                await process.stdin.drain()
                process.stdin.close()
                protocol = _ParseProtocol(on_progress)
                pending = bytearray()
                size = 0
                while chunk := await process.stdout.read(65536):
                    size += len(chunk)
                    if size > MAX_PROTOCOL_BYTES:
                        raise RuntimeError(GENERIC_ERROR)
                    pending.extend(chunk)
                    while b"\n" in pending:
                        line, _, rest = pending.partition(b"\n")
                        pending = bytearray(rest)
                        await protocol.line(line)
                    if len(pending) > MAX_PROTOCOL_LINE_BYTES:
                        raise RuntimeError(GENERIC_ERROR)
                if pending:
                    await protocol.line(pending)  # Legacy single-JSON workers need no newline.
                code = await process.wait()
                event = protocol.terminal
                if not event or code or event["event"] != "parsed":
                    raise RuntimeError(sanitize_error((event or {}).get("message", "")))
                return event["result"]
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            raise RuntimeError(sanitize_error(exc)) from None
        finally:
            # A deadline followed by a disconnect can cancel us more than once.
            # Keep ownership of the reaper until the whole process group is gone.
            reaper = asyncio.create_task(_stop_process(process))
            cancelled = False
            while not reaper.done():
                try:
                    await asyncio.shield(reaper)
                except asyncio.CancelledError:
                    cancelled = True
            await reaper
            if cancelled:
                raise asyncio.CancelledError


def _emit(event: dict):
    line = json.dumps(event, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    if len(line.encode()) > MAX_PROTOCOL_LINE_BYTES:
        raise RuntimeError(GENERIC_ERROR)
    print(line, flush=True)


def _format_selector(quality: str, mode: str, codec: str) -> str:
    # Trusted jobs may contain an observed height (e.g. 288), not just UI presets.
    valid_height = (isinstance(quality, str) and re.fullmatch(r"[1-9][0-9]{0,4}", quality)
                    and int(quality) <= 16384)
    if (quality != "best" and not valid_height) or mode not in ("video", "audio") or codec not in ("auto", "avc", "hevc", "av1"):
        raise ValueError(FORMAT_ERROR)
    if mode == "audio":
        return "bestaudio[ext=m4a]/bestaudio/best"
    filters = "" if quality == "best" else f"[height<={quality}]"
    if codec != "auto":
        pattern = {"avc": "avc|h264", "hevc": "hev|hvc|h265", "av1": "av01|av1"}[codec]
        filters += f"[vcodec~='^({pattern})']"
    return f"bestvideo{filters}+bestaudio[ext=m4a]/bestvideo{filters}+bestaudio/best{filters}/bestvideo{filters}"


class _Progress:
    def __init__(self, emit):
        self.emit = emit
        self.current = {}
        self.expected = {}
        self.progress = 0.0

    def send(self, status, data=None):
        data = data or {}
        key = str(data.get("filename", "media"))
        downloaded = _number(data.get("downloaded_bytes"), 0)
        total = _number(data.get("total_bytes")) or _number(data.get("total_bytes_estimate"))
        if data:
            self.current[key] = max(self.current.get(key, 0), downloaded)
            if total:
                self.expected[key] = total
        done = sum(self.current.values())
        expected = sum(self.expected.values()) or None
        # Stream hooks are per-component, so reserve 10% for merging/validation.
        progress = min(90, 90 * done / expected) if expected else self.progress
        self.progress = max(self.progress, progress)
        self.emit({"event": "progress", "status": status, "progress": self.progress,
                   "downloaded_bytes": int(done), "total_bytes": int(max(done, expected)) if expected else None,
                   "speed": _number(data.get("speed")) if status == "downloading" else None,
                   "eta": _number(data.get("eta")) if status == "downloading" else None})

    def download(self, data):
        self.send("merging" if data.get("status") == "finished" else "downloading", data)

    def postprocess(self, data):
        self.send("merging")


def _artifact(root: Path, value: str) -> Path:
    path = Path(value)
    if not path.is_absolute():
        path = root / path
    if path.parent != root or path.is_symlink() or not path.is_file() or path.stat().st_size <= 0:
        raise RuntimeError(VALIDATION_ERROR)
    if not path.name.startswith("media.") or path.resolve().parent != root:
        raise RuntimeError(VALIDATION_ERROR)
    return path


def _probe(path: Path, mode: str) -> dict:
    result = subprocess.run([
        "ffprobe", "-v", "error", "-protocol_whitelist", "file", "-show_entries",
        "stream=codec_type,codec_name,height:format=duration,format_name", "-of", "json", str(path),
    ], capture_output=True, timeout=30, check=False)
    if result.returncode or result.stderr or len(result.stdout) > 65536:
        raise RuntimeError(VALIDATION_ERROR)
    try:
        data = json.loads(result.stdout)
        duration = float(data.get("format", {}).get("duration", 0))
        streams = data.get("streams", [])
        if not math.isfinite(duration) or duration <= 0:
            raise ValueError
        if not any(s.get("codec_type") == mode and s.get("codec_name") for s in streams):
            raise ValueError
        if mode == "audio" and (path.suffix != ".m4a" or any(s.get("codec_type") == "video" for s in streams)):
            raise ValueError
        return data
    except (ValueError, TypeError, AttributeError):
        raise RuntimeError(VALIDATION_ERROR) from None


def _manifest(root: Path, records: list[dict], job: dict) -> tuple[list[str], str]:
    if len(records) != 1:
        raise RuntimeError(VALIDATION_ERROR)
    info = records[0]
    media = _artifact(root, info.get("filepath", ""))
    if media.suffix not in (".mp4", ".mkv", ".webm", ".flv", ".mov", ".m4a"):
        raise RuntimeError(VALIDATION_ERROR)
    probe = _probe(media, job["mode"])
    expected_audio = any(fmt.get("acodec") not in (None, "none")
                         for fmt in [info, *(info.get("requested_formats") or [])])
    if expected_audio and not any(stream.get("codec_type") == "audio" for stream in probe["streams"]):
        raise RuntimeError(VALIDATION_ERROR)
    files = [media.name]
    subtitles = info.get("requested_subtitles") or {}
    thumbnails = info.get("thumbnails") or []
    if job["subtitles"] and any(not item.get("filepath") for item in subtitles.values()):
        raise RuntimeError(VALIDATION_ERROR)
    if job["cover"] and (thumbnails or info.get("thumbnail")) and not any(item.get("filepath") for item in thumbnails):
        raise RuntimeError(VALIDATION_ERROR)
    for requested, items, extensions in (
        (job["subtitles"], subtitles.values(), {".srt", ".vtt", ".ass", ".lrc", ".ttml"}),
        (job["cover"], thumbnails, {".jpg", ".jpeg", ".png", ".webp"}),
    ):
        if not requested:
            continue
        for item in items:
            if not item.get("filepath"):
                continue
            path = _artifact(root, item["filepath"])
            if path.suffix not in extensions:
                raise RuntimeError(VALIDATION_ERROR)
            files.append(path.name)
    height = max((_number(stream.get("height"), 0) for stream in probe["streams"]), default=0)
    if job["mode"] == "video":
        if job["quality"] != "best" and height > int(job["quality"]):
            raise RuntimeError(VALIDATION_ERROR)
        if job["codec"] != "auto" and not any(_codec(stream.get("codec_name")) == job["codec"] for stream in probe["streams"]):
            raise RuntimeError(VALIDATION_ERROR)
    return sorted(set(files)), str(int(height)) if height else job["quality"]


def download_job(job: dict, emit=_emit) -> None:
    from yt_dlp.postprocessor.common import PostProcessor

    selector = _format_selector(job.get("quality"), job.get("mode"), job.get("codec"))
    if not all(isinstance(job.get(key), bool) for key in ("subtitles", "cover")):
        raise ValueError(GENERIC_ERROR)
    url = canonical_url(job.get("url", ""), allow_short=False)
    if not ("/video/" in url or "/bangumi/play/ep" in url):
        raise ValueError(UNSUPPORTED)
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        raise RuntimeError(DEPENDENCY_ERROR)
    root = Path(job["output_dir"]).absolute()
    # The parent guarantees a unique directory per task, including on resume.
    if root.is_symlink() or root.resolve() != root:
        raise ValueError(VALIDATION_ERROR)
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if any(path.is_symlink() or path.is_dir() for path in root.iterdir()):
        raise ValueError(VALIDATION_ERROR)
    progress = _Progress(emit)
    progress.send("resolving")
    records = []

    class FinalOutputPP(PostProcessor):
        def run(self, info):
            records.append(info.copy())
            return [], info

    options = _base_options(job.get("cookie_path"), _Logger())
    options.update({
        "format": selector, "noplaylist": True, "playlistend": 1,
        "outtmpl": str(root / "media.%(ext)s"), "restrictfilenames": True,
        "continuedl": True, "overwrites": False, "nopart": False,
        "merge_output_format": "mp4", "writesubtitles": job["subtitles"],
        "writeautomaticsub": job["subtitles"], "subtitleslangs": ["all", "-danmaku"],
        "subtitlesformat": "srt/vtt/best", "writethumbnail": job["cover"],
        "progress_hooks": [progress.download], "postprocessor_hooks": [progress.postprocess],
        "postprocessors": ([{"key": "FFmpegExtractAudio", "preferredcodec": "m4a", "preferredquality": "0"}]
                           if job["mode"] == "audio" else [{"key": "FFmpegVideoRemuxer", "preferedformat": "mp4"}]),
        "final_ext": "m4a" if job["mode"] == "audio" else "mp4",
    })
    with _make_ydl(options) as ydl:
        ydl.add_post_processor(FinalOutputPP(ydl), when="after_move")
        info = ydl.extract_info(url, download=True)
        if not info or info.get("_type", "video") != "video":
            raise RuntimeError(UNSUPPORTED)
    progress.send("merging")
    files, quality = _manifest(root, records, job)
    emit({"event": "complete", "files": files, "quality": quality})


class _ParseTimeout(BaseException):
    # Must bypass yt-dlp's and the per-entry Exception handlers.
    pass


def main(argv=None) -> int:
    args = sys.argv[1:] if argv is None else argv
    try:
        if len(args) != 2 or args[0] not in ("parse", "retry", "download"):
            raise ValueError(GENERIC_ERROR)
        if args[0] == "download":
            with open(args[1], "rb") as file:
                raw = file.read(MAX_INPUT_BYTES + 1)
        else:
            raw = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1) if args[1] == "-" else args[1].encode()
        if len(raw) > MAX_INPUT_BYTES:
            raise ValueError(GENERIC_ERROR)
        payload = json.loads(raw)
        if not isinstance(payload, dict):
            raise ValueError(GENERIC_ERROR)
        # Neither stdout nor stderr may expose unexpected library diagnostics.
        protocol_out = sys.stdout

        def emit(event):
            with contextlib.redirect_stdout(protocol_out):
                _emit(event)

        with open(os.devnull, "w") as sink:
            if args[0] in ("parse", "retry"):
                def timed_out(signum, frame):
                    raise _ParseTimeout(TIMEOUT_ERROR)
                previous_handler = signal.signal(signal.SIGALRM, timed_out)
                signal.alarm(PARSE_TIMEOUT)
                try:
                    with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
                        progress_options = ({"on_progress": lambda value: emit({"event": "progress", "progress": value})}
                                            if payload.get("progress") is True else {})
                        if args[0] == "retry":
                            result = retry_media(payload.get("urls"), payload.get("cookie_path"), **progress_options)
                        else:
                            result = parse_media(payload.get("url", ""), payload.get("cookie_path"), **progress_options)
                    emit({"event": "parsed", "result": result})
                finally:
                    signal.alarm(0)
                    signal.signal(signal.SIGALRM, previous_handler)
            else:
                with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
                    download_job(payload, emit)
        return 0
    except (Exception, _ParseTimeout) as exc:
        _emit({"event": "error", "message": sanitize_error(exc)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
