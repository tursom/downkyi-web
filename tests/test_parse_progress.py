import asyncio
import copy
import json
import os
import signal
import sys
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from backend import media, parse_stream
from backend.app import create_app
from tests.test_app import FakeAccount, FakeMedia, config_at, login
from tests.test_media import URL, FakeProcess, fixture_info, install_extractor
from tests.test_parse_retry import RetryMedia

HEADERS = {"Accept": "application/x-ndjson"}


def progress(completed=0, total=None, succeeded=0, failed=0, stage="extracting"):
    return dict(stage=stage, completed=completed, total=total,
                succeeded=succeeded, failed=failed, title="标题")


def test_walk_reports_real_work_unknown_total_and_failures(monkeypatch):
    events = []
    parts = [URL + f"?p={i}" for i in range(1, 4)]

    def children():
        assert events[-1]["stage"] == "listing"
        for index, part in enumerate(parts):
            assert events[-1]["completed"] == index
            yield {"_type": "url", "url": part, "title": str(index)}
        yield {"_type": "url", "url": parts[0]}  # Duplicate is not another success.

    install_extractor(monkeypatch, {URL: {"_type": "playlist", "entries": children()},
        parts[0]: fixture_info(), parts[1]: RuntimeError("HTTP 403 secret"),
        parts[2]: fixture_info(formats=[])})
    result = media.parse_media(URL, on_progress=events.append)
    assert events[0]["stage"] == "resolving"
    assert all(e["total"] is None for e in events[:-1])
    assert events[-1] == {**progress(3, 3, 1, 2), "title": ""}
    assert len(result["entries"]) == 3
    assert all(e["completed"] == e["succeeded"] + e["failed"] for e in events)
    assert "secret" not in json.dumps(events)


def test_truncated_walk_does_not_claim_known_total(monkeypatch):
    root = {"_type": "playlist", "entries": [
        fixture_info(webpage_url=URL + f"?p={i}") for i in range(1, 102)]}
    install_extractor(monkeypatch, {URL: root})
    events = []
    result = media.parse_media(URL, on_progress=events.append)
    assert result["truncated"]
    assert all(event["total"] is None for event in events)
    assert events[-1]["completed"] == events[-1]["succeeded"] == len(result["entries"]) == 100
    async def check():
        protocol = media._ParseProtocol(None)
        for event in events:
            await protocol.line(json.dumps({"event": "progress", "progress": event}).encode())
        await protocol.line(json.dumps({"event": "parsed", "result": result}).encode())
        assert protocol.terminal["result"] == result
    asyncio.run(check())


def test_empty_walk_reports_zero_before_error(monkeypatch):
    install_extractor(monkeypatch, {URL: {"_type": "playlist", "entries": []}})
    events = []
    with pytest.raises(RuntimeError):
        media.parse_media(URL, on_progress=events.append)
    assert events[-1] == {**progress(0, 0), "title": ""}


def test_retry_progress_counts_selected_urls(monkeypatch):
    urls = [URL + "?p=1", URL + "?p=2"]
    install_extractor(monkeypatch, {urls[0]: fixture_info(), urls[1]: RuntimeError("403")})
    events = []
    result = media.retry_media(urls, on_progress=events.append)
    assert [(e["completed"], e["total"], e["succeeded"], e["failed"]) for e in events] == [
        (0, 2, 0, 0), (1, 2, 1, 0), (2, 2, 1, 1)]
    assert len(result["entries"]) == 2


class ProgressMedia(RetryMedia):
    async def parse(self, url, cookie, *, on_progress=None):
        result = await super().parse(url, cookie)
        if on_progress:
            await on_progress(progress(stage="resolving"))
            await on_progress(progress(3, 3, 1, 2))
        return result

    async def retry(self, urls, cookie, *, on_progress=None):
        if on_progress:
            await on_progress(progress(total=len(urls)))
        result = await super().retry(urls, cookie)
        if on_progress:
            await on_progress(progress(len(urls), len(urls), len(urls)))
        return result


def test_stream_parse_retry_merge_cache_and_normal_json(tmp_path):
    account = FakeAccount()
    account.cookies = True
    app = create_app(config_at(tmp_path), account=account, media=ProgressMedia(), worker_module="tests.fake_worker")
    with TestClient(app) as client:
        login(client)
        normal = client.post("/api/parse", json={"url": URL})
        assert normal.headers["content-type"] == "application/json"
        response = client.post("/api/parse", json={"url": URL}, headers=HEADERS)
        assert response.headers["content-type"].startswith("application/x-ndjson")
        events = [json.loads(line) for line in response.iter_lines()]
        assert [e["event"] for e in events] == ["progress", "progress", "parsed"]
        parsed = events[-1]["result"]
        assert parsed["id"] != normal.json()["id"]
        before = copy.deepcopy(app.state.store.get_parse(parsed["id"]))
        response = client.post(f'/api/parse/{parsed["id"]}/retry',
                               json={"entry_ids": ["failed"]}, headers=HEADERS)
        events = [json.loads(line) for line in response.iter_lines()]
        assert [e["event"] for e in events] == ["progress", "progress", "parsed"]
        result = events[-1]["result"]
        assert result["id"] != parsed["id"]
        assert result["entries"][0] == parsed["entries"][0]
        assert result["entries"][2] == parsed["entries"][2]
        assert result["entries"][1]["available"]
        assert result["entries"][1]["id"] == "failed"
        assert app.state.store.get_parse(parsed["id"]) == before
        assert app.state.store.get_parse(result["id"])["entries"] == result["entries"]
        assert not list((app.state.config.data_dir / "runtime").iterdir())
        assert "private-cookie" not in response.text


@pytest.mark.parametrize("error,status", [(ValueError("secret"), 422),
    (RuntimeError("https://private/?token=secret"), 502), (OSError("/private/secret"), 500),
    (TimeoutError(), 504)])
def test_stream_errors_are_single_safe_terminal(tmp_path, error, status):
    class Broken(FakeMedia):
        async def parse(self, url, cookie, *, on_progress):
            await on_progress(progress())
            raise error
    app = create_app(config_at(tmp_path), account=FakeAccount(), media=Broken(), worker_module="tests.fake_worker")
    with TestClient(app) as client:
        login(client)
        response = client.post("/api/parse", json={"url": URL}, headers=HEADERS)
        events = [json.loads(line) for line in response.iter_lines()]
        assert response.status_code == 200
        assert [e["event"] for e in events] == ["progress", "error"]
        assert events[-1]["status"] == status
        assert "secret" not in response.text
        assert not list((app.state.config.data_dir / "runtime").iterdir())


def test_stream_preflight_errors_and_legacy_adapter(tmp_path):
    app = create_app(config_at(tmp_path), account=FakeAccount(), media=FakeMedia(), worker_module="tests.fake_worker")
    with TestClient(app) as client:
        assert client.post("/api/parse", json={"url": URL}, headers=HEADERS).status_code == 401
        login(client)
        for path, body, status in [("/api/parse", {"url": "http://127.0.0.1"}, 422),
                                   ("/api/parse", {}, 422),
                                   ("/api/parse/missing/retry", {"entry_ids": ["x"]}, 410)]:
            response = client.post(path, json=body, headers=HEADERS)
            assert response.status_code == status
            assert response.headers["content-type"] == "application/json"
        events = client.post("/api/parse", json={"url": URL}, headers=HEADERS).text.splitlines()
        assert len(events) == 1 and json.loads(events[0])["event"] == "parsed"


def encode(*events):
    return b"".join(json.dumps(e).encode() + b"\n" for e in events)


TERMINAL = {"event": "parsed", "result": {"entries": []}}


@pytest.mark.parametrize("output,code", [
    (encode(TERMINAL, TERMINAL), 0),
    (encode(TERMINAL, {"event": "progress", "progress": progress()}), 0),
    (encode({"event": "progress", "progress": progress()}), 0),
    (encode({"event": "progress", "progress": progress(1, 1)}), 0),
    (encode({"event": "progress", "progress": progress(total=True)}), 0),
    (encode({"event": "progress", "progress": progress(stage="fake")}), 0),
    (encode({"event": "progress", "progress": progress(1, 2, 1)},
            {"event": "progress", "progress": progress(0, 2)}), 0),
    (encode({"event": "progress", "progress": progress(1, 1, 1)}, TERMINAL), 0),
    (encode(TERMINAL), 1), (b"\xff\n", 0), (b"\n", 0),
    (b" " * (media.MAX_PROTOCOL_LINE_BYTES + 1) + b"\n", 0),
    (encode({"event": "progress", "progress": progress()}) * 10000, 0),
])
def test_multiline_protocol_rejects_invalid_streams_and_kills(monkeypatch, output, code):
    async def spawn(*a, **kw):
        return FakeProcess(output, code)
    killed = []
    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
    monkeypatch.setattr(os, "killpg", lambda pid, sig: killed.append(sig))
    with pytest.raises(RuntimeError):
        asyncio.run(media.MediaService(None).parse(URL))
    assert killed == [signal.SIGTERM, signal.SIGKILL]


def test_repeated_cancellation_waits_for_process_reaper(monkeypatch):
    async def check():
        spawned, reaping, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
        process = FakeProcess(b"")
        process.stdout = asyncio.StreamReader()
        reapers = []
        async def spawn(*args, **kwargs):
            spawned.set()
            return process
        async def stop(worker):
            assert worker is process
            reapers.append(asyncio.current_task())
            reaping.set()
            await release.wait()
        monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
        monkeypatch.setattr(media, "_stop_process", stop)
        job = asyncio.create_task(media.MediaService(None).parse(URL))
        await spawned.wait()
        job.cancel()
        await reaping.wait()
        job.cancel()
        await asyncio.sleep(0)
        assert not job.done()
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await job
        assert len(reapers) == 1 and reapers[0].done()
    asyncio.run(check())


def test_protocol_total_bound_applies_across_valid_lines(monkeypatch):
    event = {"event": "progress", "progress": progress(0, 0)}
    output = encode(event, event, TERMINAL)
    # Every individual line fits; only the accumulated byte budget is exceeded.
    monkeypatch.setattr(media, "MAX_PROTOCOL_BYTES", len(output) - 1)
    async def spawn(*args, **kwargs):
        return FakeProcess(output)
    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
    monkeypatch.setattr(os, "killpg", lambda *args: None)
    with pytest.raises(RuntimeError, match="媒体处理失败"):
        asyncio.run(media.MediaService(None).parse(URL))


def test_stream_busy_is_json_before_response_starts(tmp_path):
    import concurrent.futures
    started, release = asyncio.Event(), asyncio.Event()
    active = 0
    class Slow(FakeMedia):
        async def parse(self, url, cookie, *, on_progress):
            nonlocal active
            active += 1
            if active == 2:
                started.set()
            await release.wait()
            return await super().parse(url, cookie)
    app = create_app(config_at(tmp_path), account=FakeAccount(), media=Slow(), worker_module="tests.fake_worker")
    with TestClient(app) as client:
        login(client)
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            jobs = [pool.submit(client.post, "/api/parse", json={"url": URL}, headers=HEADERS) for _ in range(2)]
            try:
                client.portal.call(asyncio.wait_for, started.wait(), 2)
                response = client.post("/api/parse", json={"url": URL}, headers=HEADERS)
                assert response.status_code == 429
                assert response.headers["content-type"] == "application/json"
                assert "detail" in response.json()
            finally:
                client.portal.call(release.set)
            assert all(json.loads(job.result(timeout=2).text)["event"] == "parsed" for job in jobs)
        assert not list((app.state.config.data_dir / "runtime").iterdir())


def test_protocol_emits_callback_before_eof_and_waits_for_exit(monkeypatch):
    async def check():
        process = FakeProcess(b"")
        process.stdout = asyncio.StreamReader()
        observed = asyncio.Event()
        async def callback(value):
            assert value == progress(0, 0)
            observed.set()
        async def spawn(*a, **kw):
            return process
        monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
        monkeypatch.setattr(os, "killpg", lambda *a: None)
        job = asyncio.create_task(media.MediaService(None).parse(URL, on_progress=callback))
        data = encode({"event": "progress", "progress": progress(0, 0)})
        for byte in data:
            process.stdout.feed_data(bytes([byte]))
        await asyncio.wait_for(observed.wait(), 1)
        assert not job.done()
        process.stdout.feed_data(encode(TERMINAL))
        await asyncio.sleep(0)
        assert not job.done()
        process.stdout.feed_eof()
        assert await job == {"entries": []}
    asyncio.run(check())


@pytest.mark.parametrize("operation", ["parse", "retry"])
def test_real_cli_walk_progress_reaches_service(monkeypatch, operation):
    spawn_original = asyncio.create_subprocess_exec
    script = '''
from backend import media
from tests.test_media import FakeExtractor, fixture_info, URL
parts = [URL + "?p=1", URL + "?p=2"]
mapping = {URL: {"_type": "playlist", "title": "合集", "entries": [
    {"_type": "url", "url": part} for part in parts]},
    parts[0]: fixture_info(), parts[1]: RuntimeError("HTTP 403 private-cookie")}
media._make_ydl = lambda options: FakeExtractor(mapping)
raise SystemExit(media.main())
'''
    async def spawn(*args, **kwargs):
        return await spawn_original(sys.executable, "-c", script, *args[3:], **kwargs)
    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
    async def check():
        events = []
        async def callback(value):
            events.append(value)
        service = media.MediaService(None)
        result = await (service.parse(URL, on_progress=callback) if operation == "parse"
                        else service.retry([URL + "?p=1", URL + "?p=2"], on_progress=callback))
        assert events[-1]["completed"] == events[-1]["total"] == 2
        assert events[-1]["succeeded"] == events[-1]["failed"] == 1
        assert len(result["entries"]) == 2
        if operation == "parse":
            assert [e["stage"] for e in events][:2] == ["resolving", "listing"]
        else:
            assert [e["completed"] for e in events] == [0, 1, 2]
        assert "private-cookie" not in json.dumps(events)
    asyncio.run(check())


@pytest.mark.parametrize("streaming", [False, True])
def test_http_timeout_kills_real_worker_and_cleans_cookie(tmp_path, monkeypatch, streaming):
    spawn_original = asyncio.create_subprocess_exec
    processes = []
    monkeypatch.setattr(media, "PARSE_TIMEOUT", 0.2)
    script = '''
import json, time
print(json.dumps({"event": "progress", "progress": {"stage": "resolving",
    "completed": 0, "total": None, "succeeded": 0, "failed": 0, "title": ""}}), flush=True)
time.sleep(60)
'''
    async def spawn(*args, **kwargs):
        process = await spawn_original(sys.executable, "-c", script, **kwargs)
        processes.append(process)
        return process
    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
    account = FakeAccount()
    account.cookies = True
    app = create_app(config_at(tmp_path), account=account, media=media.MediaService(None), worker_module="tests.fake_worker")
    with TestClient(app) as client:
        login(client)
        for _ in range(3):
            response = client.post("/api/parse", json={"url": URL}, headers=HEADERS if streaming else {})
            if streaming:
                events = [json.loads(line) for line in response.iter_lines()]
                assert events[-1]["event"] == "error" and events[-1]["status"] == 504
                assert sum(e["event"] == "error" for e in events) == 1
            else:
                assert response.status_code == 504
            assert processes[-1].returncode is not None
            assert not list((app.state.config.data_dir / "runtime").iterdir())
        assert app.state.store.db.execute("SELECT count(*) FROM parses").fetchone()[0] == 0



@pytest.mark.parametrize("disconnect", [False, True])
def test_asgi_live_progress_heartbeat_disconnect_and_slot_cleanup(tmp_path, monkeypatch, disconnect):
    monkeypatch.setattr(parse_stream, "HEARTBEAT_SECONDS", 0.02)

    async def check():
        release, disconnected, stopped = asyncio.Event(), asyncio.Event(), asyncio.Event()
        class Slow(FakeMedia):
            async def parse(self, url, cookie, *, on_progress=None):
                try:
                    if on_progress:
                        await on_progress(progress(stage="resolving"))
                    await release.wait()
                    return await super().parse(url, cookie)
                finally:
                    stopped.set()
        config = replace(config_at(tmp_path), auth_mode="none")
        account = FakeAccount()
        account.cookies = True
        app = create_app(config, account=account, media=Slow(), worker_module="tests.fake_worker")
        async with app.router.lifespan_context(app):
            frames, events = [], []
            delivered, receiving = False, False
            async def receive():
                nonlocal delivered, receiving
                assert not receiving, "Two ASGI receive consumers"
                receiving = True
                try:
                    if not delivered:
                        delivered = True
                        return {"type": "http.request", "body": json.dumps({"url": URL}).encode(), "more_body": False}
                    await disconnected.wait()
                    return {"type": "http.disconnect"}
                finally:
                    receiving = False
            async def send(frame):
                frames.append(frame)
                if frame["type"] == "http.response.body" and frame.get("body"):
                    event = json.loads(frame["body"])
                    events.append(event)
                    if event["event"] == "progress":
                        assert not release.is_set()  # Truly emitted during extraction.
                        assert list((config.data_dir / "runtime").iterdir())
                    if event["event"] == "heartbeat":
                        (disconnected if disconnect else release).set()
            scope = {"type": "http", "asgi": {"version": "3.0", "spec_version": "2.4"},
                     "http_version": "1.1", "method": "POST", "scheme": "http", "path": "/api/parse",
                     "raw_path": b"/api/parse", "query_string": b"", "root_path": "",
                     "headers": [(b"content-type", b"application/json"), (b"accept", b"application/x-ndjson")],
                     "client": ("127.0.0.1", 123), "server": ("testserver", 80)}
            await asyncio.wait_for(app(scope, receive, send), 2)
            assert stopped.is_set()
            assert [e["event"] for e in events][:2] == ["progress", "heartbeat"]
            assert sum(e["event"] == "parsed" for e in events) == int(not disconnect)
            assert not list((config.data_dir / "runtime").iterdir())
            # Repeat twice: leaked slots from a disconnect would cause a 429.
            for _ in range(2):
                delivered = False
                release.set()
                async def discard(frame):
                    if frame["type"] == "http.response.start":
                        assert frame["status"] == 200
                await asyncio.wait_for(app(scope, receive, discard), 2)
            assert not list((config.data_dir / "runtime").iterdir())
    asyncio.run(check())
