import asyncio
import fcntl
import logging
import re
import shutil
import tempfile
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, FastAPI, Request, Response
from fastapi.responses import FileResponse, JSONResponse
from fastapi.exceptions import RequestValidationError
from pydantic import BaseModel, ConfigDict, Field, model_validator
from yt_dlp.version import __version__ as yt_dlp_version

from .config import Config
from .errors import ServiceError
from .manager import DownloadManager, public_task
from .security import COOKIE_NAME, RequestGuard, Sessions
from .store import Store

logger = logging.getLogger(__name__)


class InputModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Login(InputModel):
    token: str = Field(min_length=1, max_length=4096)


class ParseInput(InputModel):
    url: str = Field(min_length=1, max_length=2048)


class NewTasks(InputModel):
    parse_id: str = Field(min_length=1, max_length=100)
    entry_ids: list[str] = Field(min_length=1, max_length=50)
    quality: Literal["best", "2160", "1440", "1080", "720", "480", "360"] = "best"
    mode: Literal["video", "audio"] = "video"
    codec: Literal["auto", "avc", "hevc", "av1"] = "auto"
    subtitles: bool = False
    cover: bool = True


class SettingsInput(InputModel):
    concurrency: int | None = Field(default=None, ge=1, le=4, strict=True)
    download_dir: str | None = Field(default=None, min_length=1, max_length=4096, strict=True)

    @model_validator(mode="after")
    def require_changes(self):
        if not self.model_fields_set or any(getattr(self, key) is None for key in self.model_fields_set):
            raise ValueError("请至少提供一项非空设置")
        return self


class CookiesInput(InputModel):
    cookies: str = Field(min_length=1, max_length=131072)


def create_app(config=None, *, account=None, media=None, worker_module="backend.media"):
    config = config or Config.from_env()
    sessions = Sessions(config.token)
    auth_required = config.auth_mode != "none"
    parse_gate = asyncio.Semaphore(2)
    parse_jobs = set()

    @asynccontextmanager
    async def lifespan(app):
        config.prepare()
        if not auth_required:
            logger.warning("Token authentication is disabled. All reachable clients can manage downloads, files and Bilibili credentials. Use only on a trusted network.")
        lock = (config.data_dir / "server.lock").open("a+")
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            lock.close()
            raise RuntimeError("Data directory is already in use. Run exactly one server worker.") from None
        for path in (config.data_dir / "runtime").iterdir():
            if re.fullmatch(r"(?:parse-)?[a-f0-9]{32}", path.name) and path.is_dir() and not path.is_symlink():
                shutil.rmtree(path)
        from .bilibili import BilibiliAccount
        from .media import MediaService
        app.state.account = account or BilibiliAccount(config)
        app.state.media = media or MediaService(config)
        app.state.store = Store(config.data_dir / "tasks.sqlite3")
        app.state.manager = DownloadManager(config, app.state.store, app.state.account, worker_module)
        try:
            await app.state.manager.start()
            yield
        finally:
            for job in list(parse_jobs):
                job.cancel()
            await asyncio.gather(*list(parse_jobs), return_exceptions=True)
            await app.state.manager.close()
            await app.state.account.close()
            app.state.store.close()
            lock.close()

    app = FastAPI(title="DownKyi Web", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(RequestGuard)
    app.state.config = config

    @app.exception_handler(ServiceError)
    async def service_error(_request, exc):
        return JSONResponse({"detail": exc.message}, status_code=exc.status)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_request, exc):
        return JSONResponse({"detail": [{"loc": list(item["loc"]), "msg": item["msg"], "type": item["type"]} for item in exc.errors()]}, status_code=422)

    @app.exception_handler(ValueError)
    async def invalid_request(_request, _exc):
        return JSONResponse({"detail": "输入无效，请检查链接或登录凭据格式"}, status_code=422)

    @app.exception_handler(Exception)
    async def internal_error(_request, exc):
        logger.error("Request failed (%s)", type(exc).__name__)
        return JSONResponse({"detail": "服务暂时无法完成操作，请检查服务日志与磁盘状态"}, status_code=500)

    @app.get("/favicon.ico")
    async def favicon():
        return FileResponse(Path(__file__).parent / "static" / "favicon.png", media_type="image/png")

    @app.get("/healthz")
    async def health():
        return {"status": "ok"}

    @app.get("/api/session")
    async def session(request: Request):
        return {"authenticated": not auth_required or sessions.valid(request.cookies.get(COOKIE_NAME)), "auth_required": auth_required}

    @app.post("/api/login")
    async def login(request: Request, response: Response, body: Login | None = None):
        if not auth_required:
            return {"authenticated": True, "auth_required": False}
        if body is None:
            raise ServiceError(422, "请输入访问口令")
        key, status = sessions.login(body.token, request.client.host if request.client else "local")
        if not key:
            raise ServiceError(status, "尝试次数过多，请一分钟后重试" if status == 429 else "访问口令不正确")
        response.set_cookie(COOKIE_NAME, key, max_age=7 * 86400, httponly=True, secure=config.secure_cookie, samesite="strict", path="/")
        return {"authenticated": True}

    async def require_auth(request: Request):
        if auth_required and not sessions.valid(request.cookies.get(COOKIE_NAME)):
            raise ServiceError(401, "请先登录工作空间")

    api = APIRouter(prefix="/api", dependencies=[Depends(require_auth)])

    @api.post("/logout")
    async def logout(request: Request, response: Response):
        sessions.logout(request.cookies.get(COOKIE_NAME))
        response.delete_cookie(COOKIE_NAME, path="/", httponly=True, secure=config.secure_cookie, samesite="strict")
        return {"ok": True}

    @api.get("/tasks")
    async def tasks():
        return {"tasks": [public_task(t) for t in app.state.store.all_tasks() if not t["record_removed"]]}

    @api.get("/library")
    async def library():
        return {"tasks": [public_task(t) for t in app.state.store.all_tasks() if (t["status"] == "completed" or t["record_removed"]) and not (t["record_removed"] and t["files_deleted"])]}

    @api.post("/parse")
    async def parse(body: ParseInput, request: Request):
        if parse_gate.locked():
            raise ServiceError(429, "已有解析任务进行中，请稍后重试")
        async with parse_gate:
            runtime = config.data_dir / "runtime" / f"parse-{uuid.uuid4().hex}"
            runtime.mkdir(mode=0o700)
            job = None
            try:
                cookie = app.state.account.snapshot(runtime / "cookies.txt")
                job = asyncio.create_task(app.state.media.parse(body.url, cookie))
                parse_jobs.add(job)
                async with asyncio.timeout(180):
                    while not job.done():
                        await asyncio.wait({job}, timeout=0.25)
                        if await request.is_disconnected():
                            raise ServiceError(499, "客户端已断开解析请求")
                    result = await job
                if not isinstance(result, dict) or not result.get("entries"):
                    raise ServiceError(422, "未找到可下载的内容")
                parse_id = uuid.uuid4().hex
                app.state.store.save_parse(parse_id, result)
                return {**result, "id": parse_id}
            except asyncio.TimeoutError:
                raise ServiceError(504, "解析超时，请减少合集范围或稍后重试") from None
            except ValueError as error:
                # Media adapters expose curated public errors, never raw upstream text.
                message = str(error)
                if re.search(r"https?://|cookie|sessdata|token|/root/", message, re.I):
                    message = "链接无效或不支持，请使用哔哩哔哩视频、合集或番剧链接"
                raise ServiceError(422, message[:500]) from None
            except RuntimeError as error:
                message = str(error)
                if re.search(r"https?://|cookie|sessdata|token|/root/", message, re.I):
                    message = "解析失败，请检查网络、登录状态或稍后重试"
                raise ServiceError(502, message[:500]) from None
            finally:
                if job:
                    if not job.done():
                        job.cancel()
                    await asyncio.gather(job, return_exceptions=True)
                    parse_jobs.discard(job)
                shutil.rmtree(runtime, ignore_errors=True)

    @api.post("/tasks", status_code=201)
    async def create_tasks(body: NewTasks):
        if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
            raise ServiceError(503, "FFmpeg 或 ffprobe 未安装，无法创建下载任务")
        return {"tasks": [public_task(t) for t in await app.state.manager.admit(body)]}

    @api.post("/tasks/{task_id}/pause")
    async def pause(task_id: str):
        return public_task(await app.state.manager.pause(task_id))

    @api.post("/tasks/{task_id}/resume")
    async def resume(task_id: str):
        return public_task(await app.state.manager.resume(task_id))

    @api.delete("/tasks/{task_id}")
    async def remove(task_id: str):
        await app.state.manager.pause(task_id, remove=True)
        return {"ok": True}

    @api.delete("/tasks/{task_id}/files")
    async def delete_files(task_id: str):
        await app.state.manager.delete_files(task_id)
        return {"ok": True}

    @api.get("/tasks/{task_id}/files")
    async def files(task_id: str):
        return {"files": app.state.manager.files(task_id)}

    @api.get("/tasks/{task_id}/files/{name:path}")
    async def download_file(task_id: str, name: str):
        path = app.state.manager.manifest_path(task_id, name)
        title = app.state.manager.require(task_id)["title"]
        title = re.sub(r'[\\/<>:"|?*\x00-\x1f]', "_", title).strip(". ")[:150] or "video"
        filename = title + path.name[5:] if path.name.startswith("media.") else path.name
        return FileResponse(path, filename=filename, content_disposition_type="attachment")

    def settings_value():
        return {"concurrency": app.state.store.setting("concurrency", 2), "cookie_configured": app.state.account.configured(),
                "download_dir": str(app.state.manager.current_directory()), "default_download_dir": str(config.download_dir.resolve())}

    @api.get("/settings")
    async def settings():
        return settings_value()

    @api.patch("/settings")
    async def update_settings(body: SettingsInput):
        await app.state.manager.configure(body.model_dump(exclude_unset=True))
        return settings_value()

    @api.put("/settings/cookies")
    async def import_cookies(body: CookiesInput):
        try:
            await asyncio.to_thread(app.state.account.import_cookies, body.cookies)
        except RuntimeError:
            raise ServiceError(502, "登录凭据验证失败，请检查 Cookie 是否有效及网络连接") from None
        return settings_value()

    @api.delete("/settings/cookies")
    async def clear_cookies():
        app.state.account.clear_cookies()
        return settings_value()

    @api.get("/system")
    async def system():
        directory = app.state.manager.current_directory()
        try:
            disk = await asyncio.to_thread(shutil.disk_usage, directory)
        except OSError:
            raise ServiceError(503, "当前下载目录无法访问，请检查挂载或在偏好设置中修改目录") from None
        return {"version": "0.1.0", "yt_dlp_version": yt_dlp_version,
                "ffmpeg": bool(shutil.which("ffmpeg") and shutil.which("ffprobe")),
                "disk_total": disk.total, "disk_free": disk.free, "download_dir": str(directory),
                "active_tasks": len(app.state.manager.processes)}

    async def bili_call(operation):
        try:
            return await operation
        except ValueError:
            raise ServiceError(410, "二维码已过期，请重新生成") from None
        except RuntimeError:
            raise ServiceError(502, "无法连接哔哩哔哩或登录验证失败，请稍后重试") from None

    @api.get("/bilibili/account")
    async def bili_account():
        return await bili_call(app.state.account.account())

    @api.post("/bilibili/qr")
    async def bili_qr():
        return await bili_call(app.state.account.create_qr())

    @api.post("/bilibili/qr/{qr_id}/poll")
    async def bili_poll(qr_id: str):
        return await bili_call(app.state.account.poll_qr(qr_id))

    app.include_router(api)

    @app.get("/{path:path}")
    async def frontend(path: str):
        if path == "api" or path.startswith("api/"):
            raise ServiceError(404, "接口不存在")
        root = config.frontend_dir.resolve()
        target = root / path
        if path and target.resolve().is_relative_to(root) and target.is_file():
            return FileResponse(target)
        if path.startswith("assets/") or Path(path).suffix:
            raise ServiceError(404, "静态文件不存在")
        if not (root / "index.html").is_file():
            raise ServiceError(503, "前端尚未构建，请运行 npm run build")
        return FileResponse(root / "index.html", headers={"Cache-Control": "no-cache"})

    return app
