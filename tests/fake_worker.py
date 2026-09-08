"""Deterministic subprocess fixture; never imported by production code."""
import json
import subprocess
import sys
import time
from pathlib import Path


def emit(event):
    print(json.dumps(event), flush=True)


job = json.loads(Path(sys.argv[2]).read_text())
root = Path(job["output_dir"])
partial = root / "media.part"
partial.write_bytes(b"checkpoint")
if "stubborn" in job["url"]:
    child = subprocess.Popen([sys.executable, "-c", "import os,signal,sys,time; from pathlib import Path; signal.signal(signal.SIGTERM,signal.SIG_IGN); Path(sys.argv[1]).write_text(str(os.getpid())); time.sleep(60)", str(root / "child.pid")])
emit({"event": "progress", "status": "downloading", "progress": 40, "downloaded_bytes": 4, "total_bytes": 10, "speed": 1, "eta": 6})
if "slow" in job["url"]:
    time.sleep(60)
if "failed" in job["url"]:
    emit({"event": "error", "message": "视频暂时不可用，请稍后重试"})
    sys.exit(1)
if "invalid" in job["url"]:
    emit({"event": "complete", "files": ["../../private.txt"]})
    sys.exit(0)
if "crash" in job["url"]:
    sys.exit(2)
if "malformed" in job["url"]:
    print("not-json", flush=True)
    sys.exit(0)
emit({"event": "progress", "status": "merging", "progress": 100, "downloaded_bytes": 10})
time.sleep(0.1)
name = "sample.m4a" if job["mode"] == "audio" else "sample.mp4"
(root / name).write_bytes(b"fake-media-test-only")
files = [name]
if job["cover"]:
    (root / "cover.jpg").write_bytes(b"fake-cover-test-only")
    files.append("cover.jpg")
partial.unlink()
emit({"event": "complete", "files": files, "quality": "720"})
