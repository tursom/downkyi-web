import os

from backend.containment import acquire_task_lock
from tests.test_app import client, create, login, wait_state


def test_deleting_files_does_not_bypass_visible_task_duplicate(client):
    login(client)
    task = create(client, "slow-duplicate")
    task_id = task["id"]
    wait_state(client, task_id, {"downloading"})
    assert client.post(f"/api/tasks/{task_id}/pause").status_code == 200
    assert client.delete(f"/api/tasks/{task_id}/files").status_code == 200
    parsed = client.post("/api/parse", json={"url": task["url"]}).json()
    response = client.post("/api/tasks", json={"parse_id": parsed["id"], "entry_ids": ["one"]})
    assert response.status_code == 409
    assert client.post(f"/api/tasks/{task_id}/resume").status_code == 200


def test_removed_incomplete_storage_remains_discoverable(client):
    login(client)
    task = create(client, "slow-retained")
    task_id = task["id"]
    wait_state(client, task_id, {"downloading"})
    assert client.delete(f"/api/tasks/{task_id}").status_code == 200
    assert not client.get("/api/tasks").json()["tasks"]
    library = client.get("/api/library").json()["tasks"]
    assert len(library) == 1 and library[0]["id"] == task_id
    assert library[0]["record_removed"] and library[0]["status"] == "paused"
    assert client.get(f"/api/tasks/{task_id}/files").json()["files"] == []
    assert client.get(f"/api/tasks/{task_id}/files/media.part").status_code == 404
    assert client.delete(f"/api/tasks/{task_id}/files").status_code == 200
    assert not client.get("/api/library").json()["tasks"]


def test_old_writer_lock_blocks_resume_and_deletion(client):
    login(client)
    task = create(client, "slow-lock")
    task_id = task["id"]
    wait_state(client, task_id, {"downloading"})
    assert client.post(f"/api/tasks/{task_id}/pause").status_code == 200
    fd = acquire_task_lock(client.app.state.config.data_dir, task_id)
    try:
        assert client.post(f"/api/tasks/{task_id}/resume").status_code == 409
        assert client.delete(f"/api/tasks/{task_id}/files").status_code == 409
        assert (client.app.state.config.download_dir / task_id / "media.part").is_file()
    finally:
        os.close(fd)
    assert client.delete(f"/api/tasks/{task_id}/files").status_code == 200


def test_artifact_and_mutations_are_protected(client):
    login(client)
    task = create(client)
    wait_state(client, task["id"], {"completed"})
    artifact = client.get(f'/api/tasks/{task["id"]}/files').json()["files"][0]["url"]
    client.cookies.clear()
    assert client.get(artifact).status_code == 401
    assert client.post(f'/api/tasks/{task["id"]}/pause').status_code == 401
    assert client.delete(f'/api/tasks/{task["id"]}/files').status_code == 401
    assert client.post("/api/bilibili/qr").status_code == 401


def test_expired_session_is_rejected(client, monkeypatch):
    import time
    login(client)
    future = time.time() + 8 * 86400
    monkeypatch.setattr("backend.security.time.time", lambda: future)
    assert not client.get("/api/session").json()["authenticated"]
    assert client.get("/api/tasks").status_code == 401
