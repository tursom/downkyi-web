import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.config import Config
from tests.test_app import FakeAccount, FakeMedia, config_at, create, login, wait_state


def test_generated_token_is_private_persistent_and_not_overwritten(tmp_path, monkeypatch):
    monkeypatch.setenv("DOWNKYI_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.delenv("DOWNKYI_ADMIN_TOKEN", raising=False)
    monkeypatch.delenv("DOWNKYI_DOWNLOAD_DIR", raising=False)
    first = Config.from_env()
    second = Config.from_env()
    assert first.token == second.token and len(first.token) >= 32
    assert (first.data_dir / "admin-token").stat().st_mode & 0o777 == 0o600
    monkeypatch.setenv("DOWNKYI_ADMIN_TOKEN", "too-short")
    with pytest.raises(ValueError):
        Config.from_env()


def test_second_server_cannot_use_live_data_directory(tmp_path):
    cfg = config_at(tmp_path)
    with TestClient(create_app(cfg, account=FakeAccount(), media=FakeMedia())):
        with pytest.raises(RuntimeError, match="already in use"):
            with TestClient(create_app(cfg, account=FakeAccount(), media=FakeMedia())):
                pass


def test_concurrency_and_safe_validation_errors(tmp_path):
    cfg = config_at(tmp_path)
    with TestClient(create_app(cfg, account=FakeAccount(), media=FakeMedia(), worker_module="tests.fake_worker")) as client:
        login(client)
        client.patch("/api/settings", json={"concurrency": 1})
        tasks = [create(client, f"slow-{i}") for i in range(3)]
        wait_state(client, tasks[0]["id"], {"downloading"})
        records = client.get("/api/tasks").json()["tasks"]
        assert sum(t["status"] == "downloading" for t in records) == 1
        assert sum(t["status"] == "queued" for t in records) == 2
        client.post(f'/api/tasks/{tasks[0]["id"]}/pause')
        wait_state(client, tasks[1]["id"], {"downloading"})
        response = client.put("/api/settings/cookies", json={"cookies": {"secret": "MUST_NOT_REFLECT"}})
        assert response.status_code == 422
        assert "MUST_NOT_REFLECT" not in response.text


@pytest.mark.skipif(sys.platform != "linux", reason="Linux parent-death supervision")
def test_worker_group_dies_when_supervisor_is_killed(tmp_path):
    root = Path(__file__).resolve().parents[1]
    command = """
import fcntl, json, os, subprocess, sys, time
from pathlib import Path
path = Path(sys.argv[1]); path.mkdir(exist_ok=True)
job = path / 'job.json'
job.write_text(json.dumps({'url':'https://www.bilibili.com/video/slow-stubborn','output_dir':str(path),'mode':'video','cover':False}))
fd = os.open(path / 'task.lock', os.O_CREAT | os.O_RDWR, 0o600)
fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
child = subprocess.Popen([sys.executable,'-m','backend.launcher',str(os.getpid()),'tests.fake_worker','download',str(job)],start_new_session=True,stdout=subprocess.DEVNULL,pass_fds=(fd,),env={**os.environ,'DOWNKYI_TASK_LOCK_FD':str(fd)})
print(child.pid, flush=True)
time.sleep(60)
"""
    parent = subprocess.Popen([sys.executable, "-c", command, str(tmp_path / "job")], cwd=root, stdout=subprocess.PIPE, text=True)
    child_pid = int(parent.stdout.readline())
    try:
        deadline = time.monotonic() + 5
        while not (tmp_path / "job" / "child.pid").exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        assert (tmp_path / "job" / "child.pid").exists()
        descendant_pid = int((tmp_path / "job" / "child.pid").read_text())
        parent.kill()
        parent.wait(timeout=5)
        deadline = time.monotonic() + 5
        def is_dead(stat):
            try:
                return stat.read_text().split()[2] == "Z"
            except (FileNotFoundError, ProcessLookupError):
                return True
        while time.monotonic() < deadline:
            stats = [Path(f"/proc/{pid}/stat") for pid in (child_pid, descendant_pid)]
            if all(is_dead(stat) for stat in stats):
                break
            time.sleep(0.02)
        else:
            pytest.fail("Download worker survived supervisor death")
    finally:
        if parent.poll() is None:
            parent.kill()
            parent.wait(timeout=5)
        try:
            os.killpg(child_pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        parent.stdout.close()
