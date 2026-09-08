from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.config import Config
from tests.test_app import FakeAccount, FakeMedia, config_at, create, wait_state


@pytest.fixture
def open_client(tmp_path):
    config = replace(config_at(tmp_path), auth_mode="none", token="")
    with TestClient(create_app(config, account=FakeAccount(), media=FakeMedia(), worker_module="tests.fake_worker")) as client:
        yield client


def test_none_mode_allows_full_workflow_without_cookie(open_client):
    client = open_client
    assert client.get("/api/session").json() == {"authenticated": True, "auth_required": False}
    for path in ["/api/tasks", "/api/library", "/api/settings", "/api/system", "/api/bilibili/account"]:
        assert client.get(path).status_code == 200
    assert client.patch("/api/settings", json={"concurrency": 1}).status_code == 200
    assert client.put("/api/settings/cookies", json={"cookies": "valid"}).status_code == 200
    assert client.delete("/api/settings/cookies").status_code == 200
    assert client.post("/api/bilibili/qr").status_code == 200
    task = create(client)
    wait_state(client, task["id"], {"completed"})
    files = client.get(f'/api/tasks/{task["id"]}/files').json()["files"]
    assert client.get(files[0]["url"]).status_code == 200
    assert client.delete(f'/api/tasks/{task["id"]}').status_code == 200
    assert client.delete(f'/api/tasks/{task["id"]}/files').status_code == 200
    slow = create(client, "slow-open")
    wait_state(client, slow["id"], {"downloading"})
    assert client.post(f'/api/tasks/{slow["id"]}/pause').status_code == 200
    assert client.post(f'/api/tasks/{slow["id"]}/resume').status_code == 200
    assert not list(client.cookies)


def test_none_mode_login_is_noop_and_logout_does_not_lock_workspace(open_client):
    response = open_client.post("/api/login")
    assert response.json() == {"authenticated": True, "auth_required": False}
    assert "set-cookie" not in response.headers
    assert open_client.post("/api/logout").status_code == 200
    assert open_client.get("/api/session").json()["authenticated"]
    assert open_client.get("/api/tasks").status_code == 200


def test_none_mode_retains_cross_site_body_and_settings_guards(open_client):
    assert open_client.patch("/api/settings", json={"concurrency": 2}, headers={"Origin": "http://evil.example"}).status_code == 403
    assert open_client.post("/api/bilibili/qr", headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
    assert open_client.patch("/api/settings", json={"concurrency": 2}, headers={"Origin": "http://testserver"}).status_code == 200
    assert open_client.patch("/api/settings", json={"concurrency": 2, "auth_mode": "none"}).status_code == 422
    assert open_client.post("/api/login", content=b"x" * 170000, headers={"Content-Type": "application/json"}).status_code == 413


def test_none_mode_does_not_create_or_validate_token(tmp_path, monkeypatch):
    monkeypatch.setenv("DOWNKYI_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("DOWNKYI_AUTH_MODE", "none")
    monkeypatch.setenv("DOWNKYI_ADMIN_TOKEN", "short")
    config = Config.from_env()
    assert config.auth_mode == "none" and config.token == ""
    assert not (tmp_path / "admin-token").exists()


def test_default_is_protected_and_switching_back_preserves_token(tmp_path, monkeypatch):
    monkeypatch.setenv("DOWNKYI_DATA_DIR", str(tmp_path))
    monkeypatch.delenv("DOWNKYI_AUTH_MODE", raising=False)
    monkeypatch.delenv("DOWNKYI_ADMIN_TOKEN", raising=False)
    original = Config.from_env()
    assert original.auth_mode == "token"
    monkeypatch.setenv("DOWNKYI_AUTH_MODE", "none")
    assert Config.from_env().token == ""
    assert (tmp_path / "admin-token").read_text() == original.token
    monkeypatch.setenv("DOWNKYI_AUTH_MODE", "token")
    protected = Config.from_env()
    assert protected.token == original.token
    with TestClient(create_app(protected, account=FakeAccount(), media=FakeMedia())) as client:
        assert client.get("/api/tasks").status_code == 401
        assert client.post("/api/login").status_code == 422
        assert client.post("/api/login", json={"token": original.token}).status_code == 200
        assert client.get("/api/tasks").status_code == 200


@pytest.mark.parametrize("value", ["", "off", "false", "disabled", "typo"])
def test_invalid_auth_mode_fails_closed(tmp_path, monkeypatch, value):
    monkeypatch.setenv("DOWNKYI_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("DOWNKYI_AUTH_MODE", value)
    with pytest.raises(ValueError, match="DOWNKYI_AUTH_MODE"):
        Config.from_env()
