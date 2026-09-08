import asyncio
import hashlib
import json
import logging
import math
import os
import re
import shutil
import signal
import sys
import time
import uuid
from pathlib import Path, PurePosixPath
from urllib.parse import quote

from .containment import acquire_task_lock
from .errors import ServiceError
from .store import now_iso
from .storage_paths import check_task_overlap, validate_download_directory

logger = logging.getLogger(__name__)
RUNNING = {"queued", "resolving", "downloading", "merging"}
PUBLIC_FIELDS = {
    "id", "url", "title", "thumbnail", "status", "progress", "downloaded_bytes",
    "total_bytes", "speed", "eta", "error", "quality", "mode", "codec", "subtitles",
    "cover", "created_at", "updated_at", "record_removed", "files_deleted", "source_key", "download_dir",
}


def public_task(task):
    return {key: task[key] for key in PUBLIC_FIELDS}


def private_json(path, payload):
    with open(path, "x", opener=lambda p, f: os.open(p, f, 0o600)) as stream:
        json.dump(payload, stream)


def finite_number(value, default=None):
    if isinstance(value, (float, int)) and not isinstance(value, bool) and math.isfinite(value):
        return max(0, value)
    return default


class DownloadManager:
    def __init__(self, config, store, account, worker_module="backend.media"):
        self.config = config
        self.store = store
        self.account = account
        self.worker_module = worker_module
        self.lock = asyncio.Lock()
        self.wake = asyncio.Event()
        self.runs = {}
        self.processes = {}
        self.scheduler = None
        self.closing = False

    async def start(self):
        self.store.pin_download_directories(self.config.download_dir.resolve())
        if self.store.setting("download_dir") is None:
            self.config.download_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.store.recover()
        self.scheduler = asyncio.create_task(self._schedule())

    async def close(self):
        self.closing = True
        self.wake.set()
        if self.scheduler:
            await self.scheduler
        async with self.lock:
            for task_id, process in self.processes.items():
                task = self.store.get(task_id)
                if task and task["status"] in RUNNING:
                    self.store.update(task_id, status="queued", speed=None, eta=None)
                self._signal(process, signal.SIGTERM)
        await asyncio.gather(*(self._join(task_id) for task_id in list(self.runs)), return_exceptions=True)

    def require(self, task_id):
        task = self.store.get(task_id)
        if not task:
            raise ServiceError(404, "任务不存在")
        return task

    def current_directory(self):
        return Path(self.store.setting("download_dir", str(self.config.download_dir.resolve())))

    async def configure(self, changes):
        if "download_dir" in changes:
            directory = await asyncio.to_thread(validate_download_directory, changes["download_dir"], self.config, self.store.all_tasks())
            changes = {**changes, "download_dir": str(directory)}
        async with self.lock:
            if "download_dir" in changes:
                check_task_overlap(Path(changes["download_dir"]), self.store.all_tasks(), self.config.download_dir.resolve())
            self.store.set_settings(changes)
        self.wake.set()

    def directory(self, task_id):
        if not re.fullmatch(r"[a-f0-9]{32}", task_id):
            raise ServiceError(404, "任务不存在")
        task = self.require(task_id)
        root = Path(task["download_dir"])
        directory = root / task_id
        if not root.is_absolute() or root.resolve() != root or directory.is_symlink() or directory.resolve().parent != root:
            raise ServiceError(409, "任务目录不安全，操作已拒绝")
        if not root.is_dir():
            raise ServiceError(409, "该任务的原下载目录不可访问，请检查磁盘或 NAS 挂载")
        return directory

    async def admit(self, request):
        async with self.lock:
            if self.closing:
                raise ServiceError(503, "服务正在退出")
            parsed = self.store.get_parse(request.parse_id)
            if not parsed:
                raise ServiceError(410, "解析结果已过期，请重新解析")
            if len(set(request.entry_ids)) != len(request.entry_ids):
                raise ServiceError(422, "选择的项目重复")
            entries = {entry["id"]: entry for entry in parsed["entries"]}
            if any(key not in entries for key in request.entry_ids):
                raise ServiceError(422, "包含不属于本次解析的项目")
            all_tasks = self.store.all_tasks()
            if sum(t["status"] in RUNNING and not t["record_removed"] for t in all_tasks) + len(request.entry_ids) > 500:
                raise ServiceError(409, "队列已满，请先完成或移除部分任务")
            existing = {t["source_key"] for t in all_tasks if not t["record_removed"] or (not t["files_deleted"] and t.get("files"))}
            created = []
            for entry_id in request.entry_ids:
                entry = entries[entry_id]
                if not entry["available"]:
                    raise ServiceError(422, "包含失效或不可下载的项目")
                source_key = hashlib.sha256(f'{entry["url"]}\n{request.mode}'.encode()).hexdigest()
                if source_key in existing:
                    raise ServiceError(409, "选中的内容已有下载记录或保留文件，请先处理已有任务")
                existing.add(source_key)
                heights = [int(v) for v in entry["qualities"] if isinstance(v, (int, float)) and v > 0]
                if request.mode == "video":
                    if request.quality != "best":
                        heights = [v for v in heights if v <= int(request.quality)]
                    if not heights:
                        raise ServiceError(422, "选中的项目没有符合要求的视频画质，可尝试仅音频")
                    if request.codec != "auto" and request.codec not in entry["codecs"]:
                        raise ServiceError(422, "选中的项目不提供指定编码，请改用自动选择")
                stamp = now_iso()
                created.append({
                    "id": uuid.uuid4().hex, "url": entry["url"], "title": entry["title"],
                    "thumbnail": entry.get("thumbnail") or parsed.get("thumbnail", ""),
                    "status": "queued", "progress": 0, "downloaded_bytes": 0,
                    "total_bytes": None, "speed": None, "eta": None, "error": None,
                    "quality": str(max(heights)) if request.mode == "video" else "best",
                    "mode": request.mode, "codec": request.codec,
                    "subtitles": bool(request.subtitles and entry["has_subtitles"]),
                    "cover": request.cover, "created_at": stamp, "updated_at": stamp,
                    "record_removed": False, "files_deleted": False, "source_key": source_key,
                    "files": [], "download_dir": str(self.current_directory()),
                })
            self.store.insert_many(created)
        self.wake.set()
        return created

    async def pause(self, task_id, remove=False):
        async with self.lock:
            task = self.require(task_id)
            if task["record_removed"] and not remove:
                raise ServiceError(409, "下载记录已移除")
            changes = {}
            if task["status"] in RUNNING:
                changes.update(status="paused", speed=None, eta=None)
            if remove:
                changes["record_removed"] = True
            if not remove and task["status"] not in RUNNING | {"paused"}:
                raise ServiceError(409, "该任务不能暂停")
            self.store.update(task_id, **changes)
            if task_id in self.processes:
                self._signal(self.processes[task_id], signal.SIGTERM)
        await self._join(task_id)
        return self.require(task_id)

    async def resume(self, task_id):
        async with self.lock:
            task = self.require(task_id)
            if task["record_removed"]:
                raise ServiceError(409, "下载记录已移除，请重新添加")
            if task["status"] not in {"paused", "failed"} or task_id in self.runs:
                raise ServiceError(409, "任务未暂停或仍在停止，请稍后重试")
            if any(other["id"] != task_id and other["source_key"] == task["source_key"] and
                   (not other["record_removed"] or (not other["files_deleted"] and other.get("files")))
                   for other in self.store.all_tasks()):
                raise ServiceError(409, "相同内容已有下载任务或保留文件")
            fd = acquire_task_lock(self.config.data_dir, task_id)
            os.close(fd)
            result = self.store.update(task_id, status="queued", error=None, speed=None, eta=None, files_deleted=False)
        self.wake.set()
        return result

    async def delete_files(self, task_id):
        async with self.lock:
            task = self.require(task_id)
            if task["status"] in RUNNING or task_id in self.runs:
                raise ServiceError(409, "请先暂停任务，再删除文件")
            directory = self.directory(task_id)
            fd = acquire_task_lock(self.config.data_dir, task_id)
            try:
                if directory.exists():
                    shutil.rmtree(directory)
            except OSError:
                raise ServiceError(409, "无法删除文件，请检查目录权限") from None
            finally:
                os.close(fd)
            self.store.update(task_id, files=[], files_deleted=True, progress=0, downloaded_bytes=0, total_bytes=None)

    def manifest_path(self, task_id, name):
        task = self.require(task_id)
        if task["files_deleted"] or name not in task.get("files", []):
            raise ServiceError(404, "文件不存在或未完成")
        return self._validated_path(task_id, name)

    def _validated_path(self, task_id, name):
        relative = PurePosixPath(name)
        if not name or relative.is_absolute() or ".." in relative.parts or "\\" in name:
            raise ServiceError(404, "文件路径无效")
        root = self.directory(task_id)
        path = root
        for part in relative.parts:
            path = path / part
            if path.is_symlink():
                raise ServiceError(404, "不允许读取符号链接")
        if not path.resolve().is_relative_to(root.resolve()) or not path.is_file() or path.stat().st_size == 0:
            raise ServiceError(404, "文件不存在或已被移走")
        return path

    def files(self, task_id):
        task = self.require(task_id)
        files = []
        for name in task.get("files", []):
            try:
                path = self.manifest_path(task_id, name)
            except ServiceError:
                continue
            files.append({"name": name, "size": path.stat().st_size, "url": f"/api/tasks/{task_id}/files/{quote(name, safe='')}"})
        return files

    @staticmethod
    def _signal(process, signum):
        try:
            os.killpg(process.pid, signum)
        except ProcessLookupError:
            pass

    async def _join(self, task_id):
        run = self.runs.get(task_id)
        if not run:
            return
        try:
            await asyncio.wait_for(asyncio.shield(run), timeout=5)
        except asyncio.TimeoutError:
            process = self.processes.get(task_id)
            if process:
                self._signal(process, signal.SIGKILL)
            await asyncio.wait_for(asyncio.shield(run), timeout=10)

    async def _schedule(self):
        while not self.closing:
            self.wake.clear()
            limit = self.store.setting("concurrency", 2)
            for task in reversed(self.store.all_tasks()):
                if len(self.runs) >= limit:
                    break
                if task["status"] == "queued" and not task["record_removed"] and task["id"] not in self.runs:
                    self.runs[task["id"]] = asyncio.create_task(self._run(task["id"]))
            try:
                await asyncio.wait_for(self.wake.wait(), timeout=1)
            except asyncio.TimeoutError:
                pass

    async def _run(self, task_id):
        runtime = self.config.data_dir / "runtime" / uuid.uuid4().hex
        process = None
        task_lock_fd = None
        complete = None
        last_write = 0.0
        failure = "下载进程异常退出，请重试"
        try:
            async with self.lock:
                task = self.require(task_id)
                if self.closing or task["status"] != "queued" or task["record_removed"]:
                    return
                task_lock_fd = acquire_task_lock(self.config.data_dir, task_id)
                directory = self.directory(task_id)
                directory.mkdir(exist_ok=True, mode=0o700)
                runtime.mkdir(mode=0o700)
                cookie = self.account.snapshot(runtime / "cookies.txt")
                private_json(runtime / "job.json", {
                    "url": task["url"], "output_dir": str(directory), "cookie_path": str(cookie) if cookie else None,
                    **{key: task[key] for key in ("quality", "mode", "codec", "subtitles", "cover")},
                })
                self.store.update(task_id, status="resolving", speed=None, eta=None, error=None)
                process = await asyncio.create_subprocess_exec(
                    sys.executable, "-m", "backend.launcher", str(os.getpid()), self.worker_module,
                    "download", str(runtime / "job.json"), stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.DEVNULL, start_new_session=True, limit=131072,
                    pass_fds=(task_lock_fd,),
                    env={**{key: value for key, value in os.environ.items() if key != "DOWNKYI_ADMIN_TOKEN"}, "DOWNKYI_TASK_LOCK_FD": str(task_lock_fd)},
                    cwd=str(Path(__file__).resolve().parents[1]),
                )
                self.processes[task_id] = process
            async for line in process.stdout:
                event = json.loads(line)
                async with self.lock:
                    task = self.require(task_id)
                    if self.closing or task["status"] not in RUNNING or task["record_removed"]:
                        continue
                    if event.get("event") == "complete":
                        complete = event
                    elif event.get("event") == "error":
                        # Worker messages are curated; raw exceptions never cross the protocol.
                        message = event.get("message", "")
                        if isinstance(message, str) and not re.search(r"https?://|cookie|sessdata|token|/root/", message, re.I):
                            failure = message[:500] or failure
                    elif event.get("event") == "progress" and event.get("status") in {"resolving", "downloading", "merging"}:
                        if time.monotonic() - last_write < 0.4 and event["status"] == task["status"]:
                            continue
                        self.store.update(task_id,
                            status=event["status"], progress=min(100, finite_number(event.get("progress"), task["progress"])),
                            downloaded_bytes=int(finite_number(event.get("downloaded_bytes"), task["downloaded_bytes"])),
                            total_bytes=finite_number(event.get("total_bytes")), speed=finite_number(event.get("speed")), eta=finite_number(event.get("eta")),
                        )
                        last_write = time.monotonic()
            code = await process.wait()
            async with self.lock:
                task = self.require(task_id)
                if self.closing or task["status"] not in RUNNING or task["record_removed"]:
                    return
                if code != 0 or complete is None:
                    self.store.update(task_id, status="failed", error=failure, speed=None, eta=None)
                    return
                names = complete.get("files")
                if not isinstance(names, list) or not names or len(names) > 500 or not all(isinstance(n, str) for n in names):
                    raise ValueError("Invalid output manifest")
                paths = [self._validated_path(task_id, name) for name in names]
                if not any(path.suffix.lower() in {".mp4", ".mkv", ".webm", ".m4a", ".mp3", ".opus", ".flac"} for path in paths):
                    raise ValueError("No finalized media")
                size = sum(path.stat().st_size for path in paths)
                final_quality = complete.get("quality")
                if not isinstance(final_quality, str) or not re.fullmatch(r"[0-9]{2,5}", final_quality):
                    final_quality = task["quality"]
                self.store.update(task_id, status="completed", progress=100, downloaded_bytes=size, total_bytes=size,
                                  speed=None, eta=None, error=None, files=names, files_deleted=False, quality=final_quality)
        except Exception as error:
            logger.warning("Download task %s stopped (%s)", task_id, type(error).__name__)
            async with self.lock:
                task = self.store.get(task_id)
                if task and task["status"] in RUNNING and not self.closing and not task["record_removed"]:
                    message = error.message if isinstance(error, ServiceError) else "下载或输出文件校验失败，请检查登录状态、网络、磁盘空间和文件权限后重试"
                    self.store.update(task_id, status="failed", error=message, speed=None, eta=None)
        finally:
            if process:
                self._signal(process, signal.SIGKILL)
                await process.wait()
            if task_lock_fd is not None:
                os.close(task_lock_fd)
            shutil.rmtree(runtime, ignore_errors=True)
            self.processes.pop(task_id, None)
            self.runs.pop(task_id, None)
            self.wake.set()
