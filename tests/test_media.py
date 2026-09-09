import asyncio
import base64
import io
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
from types import SimpleNamespace
import urllib.error
import urllib.request

import pytest

from backend import media


URL = "https://www.bilibili.com/video/BV1xx411c7mD"


@pytest.mark.parametrize(("value", "expected"), [
    ("BV1xx411c7mD", URL),
    ("av170001", "https://www.bilibili.com/video/av170001"),
    ("ep123", "https://www.bilibili.com/bangumi/play/ep123"),
    ("https://m.bilibili.com/video/BV1xx411c7mD/?p=2&share_source=copy#hello", URL + "?p=2"),
    ("http://bilibili.com/bangumi/play/ss123/", "https://www.bilibili.com/bangumi/play/ss123"),
    ("https://space.bilibili.com/123/lists/456?type=season", "https://space.bilibili.com/123/channel/collectiondetail?sid=456"),
    ("https://space.bilibili.com/123/lists/456?type=series", "https://space.bilibili.com/123/channel/seriesdetail?sid=456"),
    ("https://space.bilibili.com/123/lists?sid=456", "https://space.bilibili.com/123/channel/collectiondetail?sid=456"),
    ("https://www.bilibili.com/list/123?sid=456&bvid=BV1xx411c7mD", "https://space.bilibili.com/123/channel/seriesdetail?sid=456"),
    ("https://www.bilibili.com/medialist/play/123?business=space_collection&business_id=456", "https://space.bilibili.com/123/channel/collectiondetail?sid=456"),
    ("https://space.bilibili.com/123/favlist?fid=456", "https://www.bilibili.com/medialist/detail/ml456"),
])
def test_canonical_urls(value, expected):
    assert media.canonical_url(value) == expected


@pytest.mark.parametrize("value", [
    "http://127.0.0.1/", "http://[::1]/", "file:///etc/passwd", "ftp://bilibili.com/video/av1",
    "https://bilibili.com.evil.test/video/av1", "https://bilibili.com@127.0.0.1/video/av1",
    "https://user:password@www.bilibili.com/video/av1", "https://www.bilibili.com:444/video/av1",
    "https://www.bilibili.com/video/BVbad", "https://www.bilibili.com/video/av0",
    "https://www.bilibili.com/video/av1/extra", "https://www.bilibili.com/video/av1?p=0",
    "https://www.bilibili.com/video/av1?p=1&p=2", "https://www.bilibili.com/video/av1?p=bad",
    "https://www.bilibili.com/video/av1\n?test=1", "https://www.bilibili.com\\@evil.test/video/av1",
    "https://live.bilibili.com/123", "https://www.bilibili.com/bangumi/media/md123",
    "https://space.bilibili.com/123", "https://b23.tv/a/b", "https://www.youtube.com/watch?v=123",
    "https://www.bilibili.com/video/%61v1", "https://www.bilibili.com/video/av1?." + "&a=x" * 101,
])
def test_rejects_unsupported_input(value):
    with pytest.raises(ValueError):
        media.canonical_url(value)


class Redirect:
    code = 302

    def __init__(self, location):
        self.headers = {"Location": location}

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


def test_short_link_validates_every_hop(monkeypatch):
    requested = []

    def open_url(req, timeout):
        requested.append(req.full_url)
        return Redirect("http://169.254.169.254/latest/meta-data")

    monkeypatch.setattr(media, "_public_host", lambda host: None)
    monkeypatch.setattr(urllib.request, "build_opener", lambda *a: SimpleNamespace(open=open_url))
    with pytest.raises(ValueError, match="不支持"):
        media._resolve_url("https://b23.tv/abc")
    assert requested == ["https://b23.tv/abc"]


def test_short_link_to_video_does_not_fetch_target(monkeypatch):
    requested = []

    def open_url(req, timeout):
        requested.append(req.full_url)
        return Redirect(URL + "?p=2&share_source=copy")

    monkeypatch.setattr(media, "_public_host", lambda host: None)
    monkeypatch.setattr(urllib.request, "build_opener", lambda *a: SimpleNamespace(open=open_url))
    assert media._resolve_url("https://b23.tv/abc") == URL + "?p=2"
    assert len(requested) == 1


def test_private_dns_is_rejected(monkeypatch):
    monkeypatch.setattr(media.socket, "getaddrinfo", lambda *a, **kw: [(None, None, None, None, ("127.0.0.1", 443))])
    with pytest.raises(ValueError):
        media._public_host("b23.tv")


@pytest.mark.parametrize("url", ["http://127.0.0.1/x", "file:///etc/passwd", "https://bilivideo.com.evil.test/x"])
def test_network_guard_rejects_redirect_targets(url):
    with pytest.raises(ValueError):
        media._NetworkGuard().http_request(urllib.request.Request(url))


@pytest.mark.parametrize("destination", ["http://127.0.0.1/private", "ftp://127.0.0.1/private", "file:///etc/passwd"])
def test_urllib_redirects_pass_through_network_guard(monkeypatch, destination):
    networking = pytest.importorskip("yt_dlp.networking._urllib")
    requests = []
    monkeypatch.setattr(media, "_public_host", lambda host: None)

    class RedirectingHandler(urllib.request.BaseHandler):
        handler_order = 90

        def https_open(self, request):
            requests.append(request.full_url)
            response = urllib.response.addinfourl(io.BytesIO(), {"Location": destination}, request.full_url, 302)
            response.msg = "Found"
            return response

    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}), media._NetworkGuard(), RedirectingHandler(), networking.RedirectHandler())
    with pytest.raises((ValueError, urllib.error.HTTPError)):
        opener.open(URL)
    assert requests == [URL]


def test_only_explicit_extractors_registered():
    pytest.importorskip("yt_dlp")
    with media._make_ydl(media._base_options(None, media._Logger())) as ydl:
        assert "Generic" not in ydl._ies
        assert set(ydl._ies) == {name[:-2] for name in media.EXTRACTOR_NAMES}
        with pytest.raises(ValueError):
            ydl.extract_info("http://127.0.0.1/", download=False)
        assert len(ydl._request_director.handlers) == 1
        assert "RestrictedUrllib" in ydl._request_director.handlers


def fixture_info(height=1080, codec="avc1.640028", **extra):
    return {"id": "BV1xx411c7mD", "title": "Actual title", "duration": 12.5,
            "thumbnail": "https://i0.hdslb.com/bfs/archive/test.jpg",
            "formats": [{"url": "https://example.bilivideo.com/media", "height": height, "vcodec": codec},
                        {"url": "https://example.bilivideo.com/audio", "vcodec": "none", "acodec": "mp4a"}],
            "subtitles": {"danmaku": [{"ext": "xml"}]}, **extra}


class FakeExtractor:
    def __init__(self, mapping):
        self.mapping = mapping
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def extract_info(self, url, **kwargs):
        assert kwargs == {"download": False, "process": False}
        self.calls.append(url)
        value = self.mapping[url]
        if isinstance(value, Exception):
            raise value
        return value


def install_extractor(monkeypatch, mapping):
    extractor = FakeExtractor(mapping)
    monkeypatch.setattr(media, "_make_ydl", lambda options: extractor)
    return extractor


def test_parse_full_per_entry_metadata_and_unavailable(monkeypatch):
    parts = [URL + f"?p={i}" for i in range(1, 4)]
    root = {"_type": "playlist", "title": "Actual group", "entries": [
        {"_type": "url", "url": part, "title": f"Part {i}"} for i, part in enumerate(parts)]}
    extractor = install_extractor(monkeypatch, {
        URL: root, parts[0]: fixture_info(),
        parts[1]: fixture_info(2160, "hev1", subtitles={"zh-CN": [{"ext": "srt", "data": "actual"}]}),
        parts[2]: RuntimeError("HTTP Error 403 https://secret/?cookie=xxx /private/cookies.txt"),
    })
    result = media.parse_media(URL)
    assert "id" not in result
    assert extractor.calls == [URL, *parts]
    first, second, unavailable = result["entries"]
    assert first["qualities"] == [1080]
    assert first["codecs"] == ["auto", "avc"]
    assert first["has_subtitles"] is False
    assert second["qualities"] == [2160]
    assert second["codecs"] == ["auto", "hevc"]
    assert second["has_subtitles"] is True
    assert first["group"] == "Actual group"
    assert first["id"] != second["id"]
    assert unavailable["available"] is False
    assert unavailable["qualities"] == unavailable["codecs"] == []
    assert unavailable["duration"] is None
    assert "secret" not in json.dumps(result)
    assert "cookies.txt" not in json.dumps(result)


def test_parse_flattens_nested_groups_and_caps_full_extractions(monkeypatch):
    yielded = []

    def children():
        for i in range(1, 1000):
            yielded.append(i)
            yield {"_type": "url", "url": URL + f"?p={i}"}

    root = {"_type": "playlist", "title": "Outer", "entries": [
        {"_type": "playlist", "title": "Inner", "entries": children()}]}
    mapping = {URL: root, **{URL + f"?p={i}": fixture_info() for i in range(1, 101)}}
    extractor = install_extractor(monkeypatch, mapping)
    result = media.parse_media(URL)
    assert len(result["entries"]) == 100
    assert len(extractor.calls) == 101
    assert len(yielded) == 101
    assert result["truncated"] is True
    assert all(item["group"] == "Inner" for item in result["entries"])


def test_exactly_100_entries_is_not_truncated(monkeypatch):
    root = {"_type": "playlist", "entries": [
        fixture_info(webpage_url=URL + f"?p={i}") for i in range(1, 101)]}
    install_extractor(monkeypatch, {URL: root})
    assert media.parse_media(URL)["truncated"] is False


def test_no_fake_qualities_for_missing_formats_or_audio(monkeypatch):
    install_extractor(monkeypatch, {URL: fixture_info(formats=[])})
    entry = media.parse_media(URL)["entries"][0]
    assert not entry["available"]
    assert entry["qualities"] == []
    install_extractor(monkeypatch, {URL: fixture_info(formats=[{
        "url": "https://example.bilivideo.com/audio", "vcodec": "none", "acodec": "aac"}])})
    entry = media.parse_media(URL)["entries"][0]
    assert entry["available"]
    assert entry["qualities"] == []


def test_interactive_and_fragment_entries_not_falsely_downloadable(monkeypatch):
    install_extractor(monkeypatch, {URL: fixture_info(id="BV1xx411c7mD_123456")})
    assert not media.parse_media(URL)["entries"][0]["available"]
    install_extractor(monkeypatch, {URL: {"_type": "multi_video", "entries": [fixture_info()]}})
    assert not media.parse_media(URL)["entries"][0]["available"]


@pytest.mark.parametrize("error", [
    "https://user:password@private.test/?cookie=SESSDATA /root/private/cookies.txt",
    "HTTP Error 403 https://private.test /secret/file", "No space left on device /secret/file",
    "HTTP Error 429 https://private.test/?auth=abc", "ERROR unexpected traceback /secret/file",
])
def test_error_redaction(error):
    result = media.sanitize_error(error)
    assert all(secret not in result for secret in ("https://", "SESSDATA", "/secret", "/root", "password", "private.test"))
    assert media.sanitize_error(result) == result


def test_selectors_with_real_yt_dlp():
    pytest.importorskip("yt_dlp")
    from yt_dlp import YoutubeDL
    formats = [
        {"format_id": "audio", "url": "https://example.bilivideo.com/a", "vcodec": "none", "acodec": "mp4a.40.2", "ext": "m4a"},
        {"format_id": "avc720", "url": "https://example.bilivideo.com/b", "vcodec": "avc1", "acodec": "none", "height": 720, "ext": "mp4"},
        {"format_id": "hevc1080", "url": "https://example.bilivideo.com/c", "vcodec": "hev1", "acodec": "none", "height": 1080, "ext": "mp4"},
        {"format_id": "avc2160", "url": "https://example.bilivideo.com/d", "vcodec": "avc1", "acodec": "none", "height": 2160, "ext": "mp4"},
    ]
    with YoutubeDL({"quiet": True}) as ydl:
        selector = ydl.build_format_selector(media._format_selector("1080", "video", "avc"))
        chosen = list(selector({"formats": formats, "has_merged_format": False, "incomplete_formats": False}))
        assert chosen[0]["format_id"] == "avc720+audio"
        selector = ydl.build_format_selector(media._format_selector("1080", "video", "av1"))
        assert list(selector({"formats": formats, "has_merged_format": False, "incomplete_formats": False})) == []
        selector = ydl.build_format_selector(media._format_selector("best", "audio", "auto"))
        assert list(selector({"formats": formats}))[0]["format_id"] == "audio"


def test_progress_finished_means_merging():
    events = []
    progress = media._Progress(events.append)
    progress.send("resolving")
    progress.download({"status": "downloading", "filename": "video", "downloaded_bytes": 50, "total_bytes": 100, "speed": float("nan")})
    progress.download({"status": "finished", "filename": "video", "downloaded_bytes": 100, "total_bytes": 100})
    progress.download({"status": "finished", "filename": "audio", "downloaded_bytes": 20, "total_bytes": 20})
    assert events[-1]["status"] == "merging"
    assert events[-1]["downloaded_bytes"] == 120
    assert events[-1]["progress"] < 100
    assert events[1]["speed"] is None
    assert all(event["event"] == "progress" for event in events)
    json.dumps(events, allow_nan=False)


@pytest.fixture
def job(tmp_path):
    return {"url": URL, "output_dir": str(tmp_path), "cookie_path": None,
            "quality": "1080", "mode": "video", "codec": "avc", "subtitles": True, "cover": True}


def good_probe(path, mode):
    return {"streams": [{"codec_type": mode, "codec_name": "h264", "height": 720}], "format": {"duration": "1"}}


def test_manifest_only_intended_files(tmp_path, job, monkeypatch):
    for name in ("media.mp4", "media.zh-CN.srt", "media.jpg", "media.f137.mp4.part", "cookies.txt", "unrelated.mp4"):
        (tmp_path / name).write_bytes(b"data")
    monkeypatch.setattr(media, "_probe", good_probe)
    record = {"filepath": str(tmp_path / "media.mp4"),
              "requested_subtitles": {"zh-CN": {"filepath": str(tmp_path / "media.zh-CN.srt")}},
              "thumbnails": [{"filepath": str(tmp_path / "media.jpg")}]}
    files, quality = media._manifest(tmp_path, [record], job)
    assert files == ["media.jpg", "media.mp4", "media.zh-CN.srt"]
    assert quality == "720"
    assert (tmp_path / "media.f137.mp4.part").exists()


@pytest.mark.parametrize("record_extra", [
    {"requested_subtitles": {"zh-CN": {"ext": "srt"}}},
    {"thumbnail": "https://i0.hdslb.com/cover.png", "thumbnails": []},
])
def test_requested_missing_sidecars_prevent_completion(tmp_path, job, monkeypatch, record_extra):
    (tmp_path / "media.mp4").write_bytes(b"data")
    monkeypatch.setattr(media, "_probe", good_probe)
    with pytest.raises(RuntimeError, match="校验失败"):
        media._manifest(tmp_path, [{"filepath": str(tmp_path / "media.mp4"), **record_extra}], job)


def test_manifest_rejects_symlinks_and_missing_artifacts(tmp_path, job, monkeypatch):
    monkeypatch.setattr(media, "_probe", good_probe)
    (tmp_path / "target.mp4").write_bytes(b"data")
    (tmp_path / "media.mp4").symlink_to(tmp_path / "target.mp4")
    with pytest.raises(RuntimeError):
        media._manifest(tmp_path, [{"filepath": str(tmp_path / "media.mp4")}], job)
    with pytest.raises(RuntimeError):
        media._manifest(tmp_path, [{"filepath": str(tmp_path / "missing.mp4")}], job)


def test_real_ffprobe_generated_media(tmp_path):
    if not media.shutil.which("ffmpeg") or not media.shutil.which("ffprobe"):
        pytest.skip("FFmpeg tools are not installed")
    path = tmp_path / "media.m4a"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.1", "-c:a", "aac", str(path)], check=True, capture_output=True, timeout=20)
    assert media._probe(path, "audio")["streams"][0]["codec_name"] == "aac"
    with pytest.raises(RuntimeError):
        media._probe(path, "video")
    path.write_bytes(b"not media")
    with pytest.raises(RuntimeError):
        media._probe(path, "audio")


def test_download_options_and_completion_order(tmp_path, job, monkeypatch):
    pytest.importorskip("yt_dlp")
    events, options = [], {}
    (tmp_path / "media.mp4").write_bytes(b"data")
    monkeypatch.setattr(media.shutil, "which", lambda name: "/usr/bin/" + name)
    monkeypatch.setattr(media, "_probe", lambda *a: (events.append({"event": "validated"}) or good_probe(*a)))

    class Downloader:
        params = {}
        def __enter__(self):
            return self
        def __exit__(self, *args):
            pass
        def add_post_processor(self, pp, when):
            assert when == "after_move"
            self.pp = pp
        def add_postprocessor_hook(self, hook):
            pass
        def extract_info(self, url, download):
            assert download and url == URL
            options["progress_hooks"][0]({"status": "finished", "downloaded_bytes": 4})
            info = {"filepath": str(tmp_path / "media.mp4")}
            # Avoid PostProcessor's hook wrapper, which needs a real YoutubeDL.
            self.pp.run.__wrapped__(self.pp, info)
            return info

    def make(options_in):
        options.update(options_in)
        return Downloader()

    monkeypatch.setattr(media, "_make_ydl", make)
    media.download_job(job, events.append)
    assert options["continuedl"] is True
    assert options["overwrites"] is False
    assert options["nopart"] is False
    assert options["subtitleslangs"] == ["all", "-danmaku"]
    assert options["merge_output_format"] == "mp4"
    assert events[-2]["event"] == "validated"
    assert events[-1] == {"event": "complete", "files": ["media.mp4"], "quality": "720"}


def test_cli_rejects_url_and_sanitizes_protocol():
    result = subprocess.run([sys.executable, "-m", "backend.media", "parse", json.dumps({"url": "http://127.0.0.1/?cookie=secret"})],
                            cwd=Path(media.__file__).parents[1], capture_output=True, timeout=10)
    assert result.returncode == 1
    event = json.loads(result.stdout)
    assert event == {"event": "error", "message": media.UNSUPPORTED}
    assert b"secret" not in result.stdout + result.stderr
    assert result.stderr == b""


def test_observed_height_and_invalid_selector_inputs():
    assert "[height<=288]" in media._format_selector("288", "video", "auto")
    for height in ("-1", "0", "1080]/best", "99999", 1080, None):
        with pytest.raises(ValueError):
            media._format_selector(height, "video", "auto")


def test_av_aliases_and_inline_collection_entries_use_bv_urls(monkeypatch):
    av_url = "https://www.bilibili.com/video/av170001?p=1"
    install_extractor(monkeypatch, {av_url: fixture_info(id="BV1xx411c7mD_p1")})
    assert media.parse_media(av_url)["entries"][0]["url"] == URL + "?p=1"
    collection = "https://space.bilibili.com/123/channel/collectiondetail?sid=456"
    install_extractor(monkeypatch, {collection: {"_type": "playlist", "entries": [fixture_info()]}})
    assert media.parse_media(collection)["entries"][0]["url"] == URL


def test_missing_installed_extractor_fails_clearly(monkeypatch):
    bilibili = pytest.importorskip("yt_dlp.extractor.bilibili")
    monkeypatch.setattr(bilibili, "BilibiliCollectionListIE", None)
    with media._make_ydl(media._base_options(None, media._Logger())) as ydl:
        with pytest.raises(ValueError, match="不支持"):
            ydl.extract_info("https://space.bilibili.com/123/channel/collectiondetail?sid=456", download=False)


def test_failed_playlist_pagination_keeps_successful_results(monkeypatch):
    def entries():
        yield fixture_info()
        raise RuntimeError("HTTP Error 429 https://private.test")
    install_extractor(monkeypatch, {URL: {"_type": "playlist", "entries": entries()}})
    result = media.parse_media(URL)
    assert len(result["entries"]) == 1
    assert result["truncated"] is True
    assert media.RATE_ERROR in result["warnings"]


@pytest.mark.parametrize("timeout", [False, True])
def test_cli_suppresses_upstream_output_and_handles_deadline(monkeypatch, capsys, timeout):
    def parse(*args):
        print("cookie=secret /private/file https://private.test")
        print("cookie=secret stderr", file=sys.stderr)
        if timeout:
            raise media._ParseTimeout(media.TIMEOUT_ERROR)
        return {"title": "Actual", "entries": [], "warnings": [], "thumbnail": "", "truncated": False}
    monkeypatch.setattr(media, "parse_media", parse)
    code = media.main(["parse", json.dumps({"url": URL})])
    captured = capsys.readouterr()
    assert captured.err == ""
    assert "secret" not in captured.out
    event = json.loads(captured.out)
    assert code == int(timeout)
    assert event["event"] == ("error" if timeout else "parsed")
    if timeout:
        assert event["message"] == media.TIMEOUT_ERROR


@pytest.mark.parametrize("mode", ["video", "audio"])
def test_real_ytdlp_postprocessing_with_synthetic_local_streams(tmp_path, monkeypatch, mode):
    """Exercise real merge/conversion, after_move hooks, resume and ffprobe, offline."""
    yt_dlp = pytest.importorskip("yt_dlp")
    if not media.shutil.which("ffmpeg") or not media.shutil.which("ffprobe"):
        pytest.skip("FFmpeg tools are not installed")
    video, audio, pcm = [tmp_path / name for name in ("source.mp4", "source.m4a", "source.wav")]
    subprocess.run([
        "ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=32x32:d=0.2",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=0.2",
        "-map", "0:v", "-c:v", "mpeg4", str(video),
        "-map", "1:a", "-c:a", "aac", str(audio),
        "-map", "1:a", "-c:a", "pcm_s16le", str(pcm),
    ], capture_output=True, check=True, timeout=20)
    formats = [
        {"format_id": "v", "url": "https://example.bilivideo.com/v", "height": 32, "vcodec": "mp4v", "acodec": "none", "ext": "mp4"},
        {"format_id": "a", "url": "https://example.bilivideo.com/a", "vcodec": "none", "acodec": "mp4a", "ext": "m4a"},
    ] if mode == "video" else [
        {"format_id": "pcm", "url": "https://example.bilivideo.com/pcm", "vcodec": "none", "acodec": "pcm_s16le", "ext": "wav"},
    ]
    transfers = []

    thumbnail = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=")
    subtitles = {"zh-CN": [{"ext": "srt", "data": "1\n00:00:00,000 --> 00:00:00,200\nSynthetic\n"}]}

    class LocalStreamsDL(yt_dlp.YoutubeDL):
        def extract_info(self, url, download=True, **kwargs):
            return self.process_ie_result({
                "id": "synthetic", "title": "Synthetic", "formats": formats,
                "subtitles": subtitles, "thumbnail": "https://i0.hdslb.com/cover.png",
            }, download=download)

        def dl(self, name, info, **kwargs):
            source = {"v": video, "a": audio, "pcm": pcm}[info["format_id"]]
            transfers.append(info["format_id"])
            media.shutil.copyfile(source, name)
            for hook in self.params["progress_hooks"]:
                hook({"status": "finished", "filename": name, "downloaded_bytes": source.stat().st_size})
            return True, True

        def urlopen(self, request):
            assert request.url == "https://i0.hdslb.com/cover.png", "Offline test must never access the network"
            return io.BytesIO(thumbnail)

    monkeypatch.setattr(media, "_make_ydl", LocalStreamsDL)
    job = {"url": URL, "output_dir": str(tmp_path / "task"), "cookie_path": None,
           "quality": "best", "mode": mode, "codec": "auto", "subtitles": mode == "video", "cover": mode == "video"}
    events = []
    media.download_job(job, events.append)
    completed = events[-1]
    assert completed["event"] == "complete"
    assert completed["files"] == (["media.mp4", "media.png", "media.zh-CN.srt"] if mode == "video" else ["media.m4a"])
    assert len(transfers) == (2 if mode == "video" else 1)
    media.download_job(job, events.append)
    assert events[-1] == completed
    assert len(transfers) == (2 if mode == "video" else 1)


class FakeProcess:
    pid = 123456789

    def __init__(self, output, code=0):
        self.stdout = asyncio.StreamReader()
        self.stdout.feed_data(output)
        self.stdout.feed_eof()
        self.stdin = SimpleNamespace(write=lambda value: None, drain=self.drain, close=lambda: None)
        self.returncode = code

    async def drain(self):
        pass

    async def wait(self):
        return self.returncode


def test_service_protocol_and_no_cache_id(monkeypatch):
    result = {"title": "Actual", "thumbnail": "", "entries": [], "truncated": False, "warnings": []}
    options = {}
    async def spawn(*args, **kwargs):
        options.update(kwargs)
        return FakeProcess(json.dumps({"event": "parsed", "result": result}).encode())
    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
    monkeypatch.setattr(os, "killpg", lambda *a: None)
    actual = asyncio.run(media.MediaService(SimpleNamespace()).parse(URL))
    assert actual == result and "id" not in actual
    assert options["start_new_session"] is True
    assert options["stderr"] == asyncio.subprocess.DEVNULL


@pytest.mark.parametrize("output", [b"raw error /secret", b"{}", b"x" * (media.MAX_PROTOCOL_BYTES + 1)])
def test_service_bounds_and_rejects_bad_protocol(monkeypatch, output):
    async def spawn(*a, **kw):
        return FakeProcess(output)
    killed = []
    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
    monkeypatch.setattr(os, "killpg", lambda pid, sig: killed.append(sig))
    with pytest.raises(RuntimeError, match="媒体处理失败"):
        asyncio.run(media.MediaService(SimpleNamespace()).parse(URL))
    assert killed == [signal.SIGTERM, signal.SIGKILL]


@pytest.mark.parametrize("cancel", [False, True])
@pytest.mark.parametrize("operation", ["parse", "retry"])
def test_parse_timeout_and_cancel_terminate_process_group(monkeypatch, cancel, operation):
    original_spawn = asyncio.create_subprocess_exec
    processes, descendants = [], []
    ready = asyncio.Event()
    monkeypatch.setattr(media, "PARSE_TIMEOUT", 0.3)
    script = """
import signal, subprocess, sys, time
child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])
def stop(signum, frame):
    child.wait()
    sys.exit(0)
signal.signal(signal.SIGTERM, stop)
print(child.pid, flush=True)
time.sleep(60)
"""

    async def spawn(*a, **kw):
        process = await original_spawn(sys.executable, "-c", script, **kw)
        processes.append(process)
        descendants.append(int(await process.stdout.readline()))
        ready.set()
        return process

    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)

    async def run():
        service = media.MediaService(SimpleNamespace())
        request = service.parse(URL) if operation == "parse" else service.retry([URL])
        task = asyncio.create_task(request)
        if cancel:
            await ready.wait()
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
        else:
            with pytest.raises(RuntimeError, match="解析超时"):
                await task
        assert processes[0].returncode is not None
        with pytest.raises(ProcessLookupError):
            os.kill(descendants[0], 0)

    asyncio.run(run())
