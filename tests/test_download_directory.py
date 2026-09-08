import json
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from tests.test_app import FakeAccount, FakeMedia, client, config_at, create, login, wait_state


def app_for(config):
    return create_app(config, account=FakeAccount(), media=FakeMedia(), worker_module="tests.fake_worker")


def test_directory_settings_persist_and_environment_remains_initial_default(tmp_path):
    config = config_at(tmp_path)
    selected = tmp_path / "selected"
    selected.mkdir()
    with TestClient(app_for(config)) as client:
        login(client)
        initial = client.get("/api/settings").json()
        assert initial["download_dir"] == initial["default_download_dir"] == str(config.download_dir)
        response = client.patch("/api/settings", json={"download_dir": f"  {selected}  ", "concurrency": 3})
        assert response.status_code == 200, response.text
        assert response.json()["download_dir"] == str(selected)
        assert response.json()["concurrency"] == 3
        assert client.get("/api/system").json()["download_dir"] == str(selected)
        assert list(selected.iterdir()) == []
    unused_default = tmp_path / "environment-default"
    unused_default.write_text("unused initial default must not affect saved settings")
    changed = replace(config, download_dir=unused_default)
    with TestClient(app_for(changed)) as client:
        login(client)
        result = client.get("/api/settings").json()
        assert result["download_dir"] == str(selected)
        assert result["default_download_dir"] == str(changed.download_dir)
        assert result["concurrency"] == 3


@pytest.mark.parametrize("value", ["", "   ", "relative/path", "/tmp/../etc", "/", "/etc", "/proc", "/tmp/invalid\x00name"])
def test_invalid_directory_does_not_partially_save_settings(client, value):
    login(client)
    old = client.get("/api/settings").json()
    response = client.patch("/api/settings", json={"download_dir": value, "concurrency": 4})
    assert response.status_code == 422
    assert client.get("/api/settings").json() == old


@pytest.mark.parametrize("body", [{}, {"download_dir": None}, {"download_dir": 5}, {"concurrency": None}])
def test_settings_patch_requires_non_null_changes(client, body):
    login(client)
    assert client.patch("/api/settings", json=body).status_code == 422


def test_directory_must_exist_and_not_be_file_symlink_or_private_state(client, tmp_path):
    login(client)
    regular_file = tmp_path / "file"
    regular_file.write_text("keep")
    target = tmp_path / "target"
    target.mkdir()
    link = tmp_path / "alias"
    link.symlink_to(target, target_is_directory=True)
    config = client.app.state.config
    for directory in [tmp_path / "missing", regular_file, link, config.data_dir, config.data_dir / "runtime"]:
        response = client.patch("/api/settings", json={"download_dir": str(directory)})
        assert response.status_code == 422, (directory, response.text)
    assert not (tmp_path / "missing").exists()
    assert regular_file.read_text() == "keep"


def test_unwritable_directory_probe_is_atomic(client, tmp_path, monkeypatch):
    login(client)
    target = tmp_path / "readonly"
    target.mkdir()
    def denied(*args, **kwargs):
        raise PermissionError("denied")
    monkeypatch.setattr("backend.storage_paths.tempfile.NamedTemporaryFile", denied)
    old = client.get("/api/settings").json()
    response = client.patch("/api/settings", json={"download_dir": str(target), "concurrency": 4})
    assert response.status_code == 422 and "不可写" in response.text
    assert client.get("/api/settings").json() == old


def test_new_root_does_not_move_queued_active_or_completed_tasks(client, tmp_path):
    login(client)
    original = client.app.state.config.download_dir
    chosen = tmp_path / "new-downloads"
    chosen.mkdir()
    assert client.patch("/api/settings", json={"concurrency": 1}).status_code == 200
    active = create(client, "slow-original")
    wait_state(client, active["id"], {"downloading"})
    queued = create(client, "queued-original")
    assert queued["download_dir"] == str(original)
    assert client.patch("/api/settings", json={"download_dir": str(chosen)}).status_code == 200
    fresh = create(client, "fresh-new")
    assert fresh["download_dir"] == str(chosen)
    assert client.post(f'/api/tasks/{active["id"]}/pause').status_code == 200
    wait_state(client, queued["id"], {"completed"})
    wait_state(client, fresh["id"], {"completed"})
    assert (original / queued["id"] / "sample.mp4").is_file()
    assert not (chosen / queued["id"]).exists()
    assert (chosen / fresh["id"] / "sample.mp4").is_file()
    old_files = client.get(f'/api/tasks/{queued["id"]}/files').json()["files"]
    assert client.get(old_files[0]["url"]).status_code == 200
    assert client.post(f'/api/tasks/{active["id"]}/resume').status_code == 200
    resumed = wait_state(client, active["id"], {"downloading"})
    assert resumed["download_dir"] == str(original)
    assert (original / active["id"] / "media.part").is_file()
    assert not (chosen / active["id"]).exists()
    assert client.delete(f'/api/tasks/{queued["id"]}/files').status_code == 200
    assert not (original / queued["id"]).exists()
    assert (chosen / fresh["id"] / "sample.mp4").is_file()


def test_legacy_tasks_are_backfilled_without_changing_paths_or_timestamps(tmp_path):
    config = config_at(tmp_path)
    chosen = tmp_path / "chosen"
    chosen.mkdir()
    with TestClient(app_for(config)) as client:
        login(client)
        task = create(client)
        completed = wait_state(client, task["id"], {"completed"})
        client.patch("/api/settings", json={"download_dir": str(chosen)})
        store = client.app.state.store
        legacy = store.get(task["id"])
        del legacy["download_dir"]
        with store.lock, store.db:
            store.db.execute("UPDATE tasks SET payload=? WHERE id=?", (json.dumps(legacy), task["id"]))
    changed = replace(config, download_dir=tmp_path / "other-default")
    with TestClient(app_for(changed)) as client:
        login(client)
        restored = client.get("/api/tasks").json()["tasks"][0]
        assert restored["download_dir"] == str(config.download_dir)
        assert restored["updated_at"] == completed["updated_at"]
        assert client.get("/api/settings").json()["download_dir"] == str(chosen)
        files = client.get(f'/api/tasks/{task["id"]}/files').json()["files"]
        assert client.get(files[0]["url"]).status_code == 200


def test_managed_task_directory_cannot_be_used_as_new_root(client):
    login(client)
    task = create(client)
    wait_state(client, task["id"], {"completed"})
    directory = client.app.state.config.download_dir / task["id"]
    child = directory / "nested"
    child.mkdir()
    for value in [directory, child]:
        response = client.patch("/api/settings", json={"download_dir": str(value)})
        assert response.status_code == 422 and "已有任务" in response.text


def test_missing_selected_root_fails_without_recreating_or_retargeting(client, tmp_path):
    login(client)
    chosen = tmp_path / "removable"
    chosen.mkdir()
    assert client.patch("/api/settings", json={"download_dir": str(chosen)}).status_code == 200
    chosen.rmdir()
    assert client.get("/api/settings").json()["download_dir"] == str(chosen)
    assert client.get("/api/system").status_code == 503
    task = create(client, "missing-directory")
    failure = wait_state(client, task["id"], {"failed"})
    assert "原下载目录" in failure["error"]
    assert not chosen.exists()
    assert not (client.app.state.config.download_dir / task["id"]).exists()
    chosen.mkdir()
    assert client.post(f'/api/tasks/{task["id"]}/resume').status_code == 200
    wait_state(client, task["id"], {"completed"})


def test_replaced_pinned_root_symlink_does_not_redirect_file_operations(client, tmp_path):
    login(client)
    chosen = tmp_path / "chosen"
    chosen.mkdir()
    client.patch("/api/settings", json={"download_dir": str(chosen)})
    task = create(client)
    wait_state(client, task["id"], {"completed"})
    files = client.get(f'/api/tasks/{task["id"]}/files').json()["files"]
    moved = tmp_path / "moved"
    chosen.rename(moved)
    chosen.symlink_to(moved, target_is_directory=True)
    assert client.get(files[0]["url"]).status_code == 409
    assert client.delete(f'/api/tasks/{task["id"]}/files').status_code == 409
    assert (moved / task["id"] / "sample.mp4").is_file()
