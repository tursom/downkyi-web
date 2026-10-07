import asyncio
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.config import Config
from backend.security import COOKIE_NAME

TOKEN = "test-access-token-at-least-32-characters"


class FakeAccount:
    def __init__(self):
        self.cookies = False

    def configured(self):
        return self.cookies

    def snapshot(self, path):
        if self.cookies:
            path.write_text("private-cookie-value")
            return path
        return None

    def import_cookies(self, text):
        if text != "valid":
            raise ValueError("private-cookie-value must not be reflected")
        self.cookies = True

    def clear_cookies(self):
        self.cookies = False

    async def close(self):
        pass

    async def account(self):
        return {"logged_in": False, "username": None, "vip": False}

    async def create_qr(self):
        return {"id": "sample", "url": "https://www.bilibili.com", "image": "data:image/png;base64,AA==", "expires_in": 180}

    async def poll_qr(self, key):
        return {"status": "waiting", "message": "等待扫码"}


class FakeMedia:
    async def parse(self, url, cookie):
        if not url.startswith("https://www.bilibili.com/"):
            raise ValueError("无效的视频链接")
        return {"title": "Sample", "thumbnail": "", "truncated": False, "warnings": [], "entries": [
            {"id": "one", "title": "Sample", "url": url, "duration": 1,
             "thumbnail": "", "group": "视频", "available": True, "error": None,
             "qualities": [360, 720], "codecs": ["avc"], "has_subtitles": False},
        ]}


def config_at(path):
    return Config(path / "data", path / "downloads", TOKEN, frontend_dir=path / "frontend")


@pytest.fixture
def client(tmp_path):
    app = create_app(config_at(tmp_path), account=FakeAccount(), media=FakeMedia(), worker_module="tests.fake_worker")
    with TestClient(app) as client:
        yield client


def login(client):
    response = client.post("/api/login", json={"token": TOKEN})
    assert response.status_code == 200


def create(client, name="complete", **options):
    parsed = client.post("/api/parse", json={"url": f"https://www.bilibili.com/video/{name}"})
    assert parsed.status_code == 200, parsed.text
    response = client.post("/api/tasks", json={"parse_id": parsed.json()["id"], "entry_ids": ["one"], **options})
    assert response.status_code == 201, response.text
    return response.json()["tasks"][0]


def wait_state(client, task_id, states):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        task = next(t for t in client.get("/api/tasks").json()["tasks"] if t["id"] == task_id)
        if task["status"] in states:
            return task
        time.sleep(0.04)
    raise AssertionError(f"Task did not reach {states}: {task}")


def test_auth_sessions_and_logout(client):
    assert client.get("/api/session").json() == {"authenticated": False, "auth_required": True}
    for path in ["/api/tasks", "/api/system", "/api/library", "/api/settings", "/api/bilibili/account"]:
        assert client.get(path).status_code == 401
    response = client.post("/api/login", json={"token": TOKEN})
    assert "HttpOnly" in response.headers["set-cookie"]
    assert "SameSite=strict" in response.headers["set-cookie"]
    assert client.get("/api/session").json()["authenticated"]
    old = client.cookies.get(COOKIE_NAME)
    assert client.post("/api/logout").status_code == 200
    client.cookies.set(COOKIE_NAME, old)
    assert client.get("/api/tasks").status_code == 401


def test_rate_limit_origin_and_body_limit(client):
    for _ in range(5):
        assert client.post("/api/login", json={"token": "wrong"}).status_code == 401
    assert client.post("/api/login", json={"token": TOKEN}).status_code == 429
    assert client.post("/api/login", json={"token": TOKEN}, headers={"Origin": "https://evil.example"}).status_code == 403
    assert client.post("/api/login", content=b"x" * 170000, headers={"Content-Type": "application/json"}).status_code == 413
    assert client.post("/api/login", content="token=x").status_code == 415


def test_settings_validation_and_security_headers(client):
    login(client)
    assert client.patch("/api/settings", json={"concurrency": 4}).json()["concurrency"] == 4
    for value in [0, 5, True, "2"]:
        assert client.patch("/api/settings", json={"concurrency": value}).status_code == 422
    assert client.put("/api/settings/cookies", json={"cookies": "valid"}).json()["cookie_configured"]
    failure = client.put("/api/settings/cookies", json={"cookies": "secret"})
    assert failure.status_code == 422
    assert "private-cookie-value" not in failure.text
    assert not client.delete("/api/settings/cookies").json()["cookie_configured"]
    response = client.get("/api/system")
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert "frame-ancestors 'none'" in response.headers["content-security-policy"]


def test_parse_admission_rejects_spoofed_and_duplicate_entries(client):
    login(client)
    assert client.post("/api/parse", json={"url": "http://127.0.0.1"}).status_code == 422
    assert client.post("/api/tasks", json={"parse_id": "missing", "entry_ids": ["one"]}).status_code == 410
    parsed = client.post("/api/parse", json={"url": "https://www.bilibili.com/video/complete"}).json()
    for entries in [["unknown"], ["one", "one"], []]:
        assert client.post("/api/tasks", json={"parse_id": parsed["id"], "entry_ids": entries}).status_code == 422
    assert client.post("/api/tasks", json={"parse_id": parsed["id"], "entry_ids": ["one"], "codec": "hevc"}).status_code == 422
    assert client.post("/api/tasks", json={"parse_id": parsed["id"], "entry_ids": ["one"], "url": "http://localhost"}).status_code == 422
    task = create(client)
    assert "files" not in task and "cookie_path" not in task
    assert task["danmaku"] is False
    assert client.post("/api/tasks", json={"parse_id": parsed["id"], "entry_ids": ["one"]}).status_code == 409


@pytest.mark.parametrize("count", [65, 100])
def test_admit_entire_large_list_atomically(client, monkeypatch, count):
    login(client)
    # Keep test tasks queued; the admission test does not need download workers.
    monkeypatch.setattr(client.app.state.manager.wake, "set", lambda: None)
    parsed = client.post("/api/parse", json={"url": "https://www.bilibili.com/video/complete"}).json()
    template = parsed["entries"][0]
    parsed["entries"] = [{**template, "id": str(index), "url": f'{template["url"]}?p={index + 1}'}
                         for index in range(count)]
    store = client.app.state.store
    body = {"parse_id": "large-pending", "entry_ids": [entry["id"] for entry in parsed["entries"]]}
    parsed["entries"][-1]["resolution"] = "pending"
    store.save_parse(body["parse_id"], parsed)
    assert client.post("/api/tasks", json=body).status_code == 422
    assert store.all_tasks() == []
    parsed["entries"][-1]["resolution"] = "ready"
    body["parse_id"] = "large-ready"
    store.save_parse(body["parse_id"], parsed)
    response = client.post("/api/tasks", json=body)
    assert response.status_code == 201, response.text
    assert len(response.json()["tasks"]) == count
    assert len(store.all_tasks()) == count
    assert client.post("/api/tasks", json=body).status_code == 409
    assert len(store.all_tasks()) == count
    assert client.post("/api/tasks", json={**body, "entry_ids": [str(i) for i in range(101)]}).status_code == 422


def test_complete_library_record_removal_and_file_deletion(client):
    login(client)
    task = create(client)
    task_id = task["id"]
    completed = wait_state(client, task_id, {"completed"})
    assert completed["progress"] == 100
    files = client.get(f"/api/tasks/{task_id}/files").json()["files"]
    assert {f["name"] for f in files} == {"sample.mp4", "cover.jpg"}
    response = client.get(files[0]["url"])
    assert response.status_code == 200
    assert response.content == b"fake-media-test-only"
    assert "attachment" in response.headers["content-disposition"]
    assert client.delete(f"/api/tasks/{task_id}").status_code == 200
    assert not client.get("/api/tasks").json()["tasks"]
    assert client.get("/api/library").json()["tasks"][0]["record_removed"]
    assert client.get(files[0]["url"]).status_code == 200
    assert client.delete(f"/api/tasks/{task_id}/files").status_code == 200
    assert client.get(files[0]["url"]).status_code == 404
    assert not client.get("/api/library").json()["tasks"]


def test_inline_playback_supports_ranges_and_only_manifest_media(client):
    login(client)
    task_id = create(client)["id"]
    wait_state(client, task_id, {"completed"})
    url = f"/api/tasks/{task_id}/play/sample.mp4"
    response = client.get(url)
    assert response.status_code == 200 and response.content == b"fake-media-test-only"
    assert response.headers["content-type"] == "video/mp4"
    assert "attachment" not in response.headers.get("content-disposition", "")
    assert response.headers["accept-ranges"] == "bytes"
    partial = client.get(url, headers={"Range": "bytes=5-9"})
    assert partial.status_code == 206 and partial.content == b"media"
    assert client.get(f"/api/tasks/{task_id}/play/cover.jpg").status_code == 404
    assert client.get(f"/api/tasks/{task_id}/play/../tasks.sqlite3").status_code == 404
    client.cookies.clear()
    assert client.get(url).status_code == 401
    login(client)
    assert client.delete(f"/api/tasks/{task_id}/files").status_code == 200
    assert client.get(url).status_code == 404


def test_subtitle_track_converts_srt_to_webvtt(client):
    from backend.app import srt_to_vtt

    assert srt_to_vtt("1\n00:00:01,250 --> 00:01:02,000\n你好\n") == \
        "WEBVTT\n\n1\n00:00:01.250 --> 00:01:02.000\n你好\n"
    login(client)
    task_id = create(client)["id"]
    wait_state(client, task_id, {"completed"})
    root = client.app.state.config.download_dir / task_id
    (root / "media.zh-CN.srt").write_bytes("﻿1\r\n00:00:01,000 --> 00:00:02,500\r\n字幕\r\n".encode())
    files = client.app.state.store.get(task_id)["files"]
    client.app.state.store.update(task_id, files=[*files, "media.zh-CN.srt"])
    response = client.get(f"/api/tasks/{task_id}/subtitles/media.zh-CN.srt")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/vtt")
    assert response.text == "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500\n字幕\n"
    assert client.get(f"/api/tasks/{task_id}/subtitles/sample.mp4").status_code == 404
    assert client.get(f"/api/tasks/{task_id}/subtitles/unlisted.srt").status_code == 404


def test_pause_resume_stops_process_and_preserves_partial(client):
    login(client)
    task = create(client, "slow")
    task_id = task["id"]
    wait_state(client, task_id, {"downloading"})
    assert client.delete(f"/api/tasks/{task_id}/files").status_code == 409
    response = client.post(f"/api/tasks/{task_id}/pause")
    assert response.status_code == 200 and response.json()["status"] == "paused"
    root = client.app.state.config.download_dir / task_id
    assert (root / "media.part").read_bytes() == b"checkpoint"
    assert task_id not in client.app.state.manager.processes
    assert client.get(f"/api/tasks/{task_id}/files").json()["files"] == []
    assert client.post(f"/api/tasks/{task_id}/resume").status_code == 200
    wait_state(client, task_id, {"downloading"})
    assert client.delete(f"/api/tasks/{task_id}").status_code == 200
    assert client.post(f"/api/tasks/{task_id}/resume").status_code == 409
    assert (root / "media.part").exists()


def test_danmaku_without_subtitles_persists_and_files_follow_task_lifecycle(client):
    login(client)
    task = create(client, danmaku=True, subtitles=False, cover=False)
    task_id = task["id"]
    assert task["danmaku"] is True and task["subtitles"] is False
    assert client.app.state.store.get(task_id)["danmaku"] is True
    completed = wait_state(client, task_id, {"completed"})
    assert completed["danmaku"] is True
    files = client.get(f"/api/tasks/{task_id}/files").json()["files"]
    assert {item["name"] for item in files} == {"sample.mp4", "media.danmaku.xml", "media.danmaku.ass"}
    for item in files:
        response = client.get(item["url"])
        assert response.status_code == 200 and response.content
        assert "attachment" in response.headers["content-disposition"]
    client.cookies.clear()
    assert client.get(files[-1]["url"]).status_code == 401
    login(client)
    assert client.delete(f"/api/tasks/{task_id}").status_code == 200
    assert client.get("/api/library").json()["tasks"][0]["danmaku"] is True
    assert client.get(files[-1]["url"]).status_code == 200
    assert client.delete(f"/api/tasks/{task_id}/files").status_code == 200
    assert client.get(files[-1]["url"]).status_code == 404


@pytest.mark.parametrize("legacy", [False, True])
def test_danmaku_option_survives_restart_and_legacy_tasks_default_false(tmp_path, legacy):
    import json

    cfg = config_at(tmp_path)
    with TestClient(create_app(cfg, account=FakeAccount(), media=FakeMedia(), worker_module="tests.fake_worker")) as client:
        login(client)
        task = create(client, "slow-danmaku", danmaku=True)
        task_id = task["id"]
        wait_state(client, task_id, {"downloading"})
        assert client.post(f"/api/tasks/{task_id}/pause").status_code == 200
        if legacy:
            store = client.app.state.store
            payload = store.get(task_id)
            del payload["danmaku"]
            with store.lock, store.db:
                store.db.execute("UPDATE tasks SET payload=? WHERE id=?", (json.dumps(payload), task_id))
    with TestClient(create_app(cfg, account=FakeAccount(), media=FakeMedia(), worker_module="tests.fake_worker")) as client:
        login(client)
        restored = client.get("/api/tasks").json()["tasks"][0]
        assert restored["status"] == "paused" and restored["danmaku"] is (not legacy)
        # Change only the fixture URL to let the resumed worker finish immediately.
        client.app.state.store.update(task_id, url="https://www.bilibili.com/video/complete")
        assert client.post(f"/api/tasks/{task_id}/resume").status_code == 200
        wait_state(client, task_id, {"completed"})
        names = {item["name"] for item in client.get(f"/api/tasks/{task_id}/files").json()["files"]}
        assert ("media.danmaku.xml" in names) is (not legacy)
        assert ("media.danmaku.ass" in names) is (not legacy)


@pytest.mark.parametrize("failure", ["failed", "invalid", "crash", "malformed"])
def test_worker_failures_never_complete(client, failure):
    login(client)
    task = create(client, failure)
    result = wait_state(client, task["id"], {"failed"})
    assert result["error"]
    assert client.get(f'/api/tasks/{task["id"]}/files').json()["files"] == []
    assert client.post(f'/api/tasks/{task["id"]}/resume').status_code == 200


def test_manifest_rejects_symlink_and_unlisted_file(client, tmp_path):
    login(client)
    task = create(client)
    task_id = task["id"]
    wait_state(client, task_id, {"completed"})
    outside = tmp_path / "private.txt"
    outside.write_text("private-secret")
    root = client.app.state.config.download_dir / task_id
    (root / "sample.mp4").unlink()
    (root / "sample.mp4").symlink_to(outside)
    assert client.get(f"/api/tasks/{task_id}/files/sample.mp4").status_code == 404
    assert client.get(f"/api/tasks/{task_id}/files/private.txt").status_code == 404
    assert client.delete(f"/api/tasks/{task_id}/files").status_code == 200
    assert outside.read_text() == "private-secret"


def test_restart_recovers_active_queue_and_keeps_paused(tmp_path):
    cfg = config_at(tmp_path)
    with TestClient(create_app(cfg, account=FakeAccount(), media=FakeMedia(), worker_module="tests.fake_worker")) as client:
        login(client)
        active = create(client, "slow-one")
        paused = create(client, "slow-two")
        wait_state(client, active["id"], {"downloading"})
        client.post(f'/api/tasks/{paused["id"]}/pause')
        client.patch("/api/settings", json={"concurrency": 1})
    with TestClient(create_app(cfg, account=FakeAccount(), media=FakeMedia(), worker_module="tests.fake_worker")) as client:
        login(client)
        wait_state(client, active["id"], {"downloading"})
        records = {t["id"]: t for t in client.get("/api/tasks").json()["tasks"]}
        assert records[paused["id"]]["status"] == "paused"
        assert client.get("/api/settings").json()["concurrency"] == 1
        assert client.get(f'/api/tasks/{active["id"]}/files').json()["files"] == []
