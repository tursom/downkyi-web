"""Headless Bilibili authentication; credentials never leave private cookie files."""

import asyncio
import base64
import copy
import io
import logging
import os
import re
import secrets
import stat
import tempfile
import threading
import time
import warnings
from collections import OrderedDict
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from http.cookiejar import CookieJar, MozillaCookieJar
from pathlib import Path
from urllib.parse import urlsplit

import httpx
import qrcode


_GENERATE = "https://passport.bilibili.com/x/passport-login/web/qrcode/generate"
_POLL = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll"
_NAV = "https://api.bilibili.com/x/web-interface/nav"
_MAX_COOKIE_BYTES = 128 * 1024
_PARENT_DOMAINS = {"bilibili.com", ".bilibili.com"}
_COOKIE_NAME = re.compile(r"[!#$%&'*+\-.^_`|~0-9A-Za-z]+\Z")
_UPSTREAM_ERROR = "Bilibili authentication service is unavailable. Please retry."
_AUTH_ERROR = "Bilibili did not verify this login. Existing cookies were kept."
_AUTH_HTTP = ContextVar("bilibili_auth_http", default=False)


class _AuthLogFilter(logging.Filter):
    def filter(self, record):
        return not _AUTH_HTTP.get()


_AUTH_LOG_FILTER = _AuthLogFilter()


@contextmanager
def _quiet_http():
    # HTTPX logs full query strings; httpcore DEBUG logs Set-Cookie headers.
    # Suppress only this authentication task/thread, not other HTTP traffic.
    for name in ("httpx", "httpcore.connection", "httpcore.http11", "httpcore.http2",
                 "httpcore.proxy", "httpcore.socks", "http.cookiejar"):
        logging.getLogger(name).addFilter(_AUTH_LOG_FILTER)
    token = _AUTH_HTTP.set(True)
    try:
        yield
    finally:
        _AUTH_HTTP.reset(token)


@dataclass(repr=False)
class _QRSession:
    client: httpx.AsyncClient
    key: str
    cookies: MozillaCookieJar
    expires_at: float
    revision: int
    timer: asyncio.Task | None = None


def _safe_cookie(cookie):
    return (
        cookie.name is not None
        and _COOKIE_NAME.fullmatch(cookie.name) is not None
        and cookie.value is not None
        and all(32 <= ord(char) < 127 for char in cookie.value)
        and ";" not in cookie.value
        and cookie.path.startswith("/")
        and all(ord(char) >= 32 and ord(char) != 127 for char in cookie.path)
    )


def _parse_cookies(text: str) -> MozillaCookieJar:
    if not isinstance(text, str):
        raise ValueError("Cookies must be a Netscape cookie file.")
    try:
        encoded = text.encode("utf-8")
    except UnicodeError:
        raise ValueError("Cookies must be valid UTF-8 text.") from None
    if not encoded or len(encoded) > _MAX_COOKIE_BYTES:
        raise ValueError("Cookie files must be nonempty and at most 128 KiB.")
    jar = MozillaCookieJar()
    # The standard parser preserves #HttpOnly_ and Netscape domain semantics.
    # Its malformed-file warnings can contain credentials, so suppress them.
    try:
        with warnings.catch_warnings(), _quiet_http():
            warnings.simplefilter("ignore")
            jar._really_load(io.StringIO(text), "<cookie import>", True, True)
    except (ValueError, OSError, AssertionError):
        raise ValueError("Invalid Netscape cookie file.") from None
    if not list(jar):
        raise ValueError("The cookie file contains no cookies.")
    for cookie in jar:
        if cookie.domain not in _PARENT_DOMAINS or not _safe_cookie(cookie):
            raise ValueError("Only valid bilibili.com parent-domain cookies are allowed.")
        cookie.secure = True
    jar.clear_expired_cookies()
    if not list(jar):
        raise ValueError("The cookie file contains only expired cookies.")
    return jar


def _scoped_cookies(jar: CookieJar, host: str) -> MozillaCookieJar:
    scoped = MozillaCookieJar()
    for cookie in jar:
        domain = cookie.domain.lstrip(".")
        matches = host == domain or (
            cookie.domain_specified and host.endswith("." + domain)
        )
        if matches and not cookie.is_expired():
            scoped.set_cookie(copy.copy(cookie))
    return scoped


def _merge_response_cookies(jar: CookieJar, response: httpx.Response):
    host = response.request.url.host
    for cookie in response.cookies.jar:
        domain = cookie.domain.lstrip(".")
        # A passport response cannot mint cookies for an API sibling or any
        # unrelated domain. Host-only cookies remain host-only when verifying.
        if (
            (cookie.domain in _PARENT_DOMAINS or domain == host)
            and (cookie.domain_specified or domain == host)
            and _safe_cookie(cookie)
        ):
            saved = copy.copy(cookie)
            saved.secure = True
            jar.set_cookie(saved)
    jar.clear_expired_cookies()


def _payload(response: httpx.Response) -> dict:
    try:
        response.raise_for_status()
        body = response.json()
    except (httpx.HTTPError, ValueError):
        raise RuntimeError(_UPSTREAM_ERROR) from None
    if not isinstance(body, dict):
        raise RuntimeError(_UPSTREAM_ERROR)
    return body


def _data(response: httpx.Response) -> dict:
    body = _payload(response)
    if type(body.get("code")) is not int or body["code"] != 0:
        raise RuntimeError(_UPSTREAM_ERROR)
    if not isinstance(body.get("data"), dict):
        raise RuntimeError(_UPSTREAM_ERROR)
    return body["data"]


def _account_result(response: httpx.Response) -> dict:
    body = _payload(response)
    if body.get("code") == -101:
        data = {}
    elif type(body.get("code")) is int and body["code"] == 0:
        data = body.get("data")
        if not isinstance(data, dict) or type(data.get("isLogin")) is not bool:
            raise RuntimeError(_UPSTREAM_ERROR)
    else:
        raise RuntimeError(_UPSTREAM_ERROR)
    if data.get("isLogin") is not True:
        return {
            "logged_in": False,
            "username": None,
            "vip": False,
            "message": "Not logged in, or the saved login has expired.",
        }
    username = data.get("uname")
    if not isinstance(username, str):
        username = None
    else:
        username = "".join(c for c in username if c.isprintable())[:100] or None
    vip = data.get("vip")
    vip_status = vip.get("status") if isinstance(vip, dict) else data.get("vipStatus")
    return {
        "logged_in": True,
        "username": username,
        "vip": type(vip_status) is int and vip_status == 1,
        "message": "Bilibili login verified.",
    }


class BilibiliAccount:
    QR_TTL = 180
    MAX_SESSIONS = 10

    def __init__(self, config, *, transport=None, clock=time.monotonic):
        self.cookie_path = Path(config.data_dir) / "cookies.txt"
        self.cookie_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        self._transport = transport
        self._clock = clock
        self._sessions: dict[str, _QRSession] = {}
        self._terminal: OrderedDict[str, tuple[str, int]] = OrderedDict()
        self._qr_lock = asyncio.Lock()
        self._file_lock = threading.RLock()
        self._revision = 0
        self._closed = False

    def _client_options(self):
        return dict(
            transport=self._transport,
            trust_env=False,
            follow_redirects=False,
            timeout=httpx.Timeout(15.0),
            headers={
                "User-Agent": "Mozilla/5.0 DownKyi-Web/0.1",
                "Referer": "https://www.bilibili.com/",
                "Accept": "application/json",
            },
        )

    def _new_client(self):
        return httpx.AsyncClient(**self._client_options())

    def _new_sync_client(self):
        return httpx.Client(**self._client_options())

    def _ensure_open(self):
        if self._closed:
            raise RuntimeError("Bilibili account service is closed.")

    def _read_stored(self) -> bytes | None:
        try:
            fd = os.open(self.cookie_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except FileNotFoundError:
            return None
        try:
            with os.fdopen(fd, "rb") as source:
                info = os.fstat(source.fileno())
                if not stat.S_ISREG(info.st_mode) or info.st_size > _MAX_COOKIE_BYTES:
                    raise ValueError("Invalid stored cookie file.")
                content = source.read(_MAX_COOKIE_BYTES + 1)
                if len(content) > _MAX_COOKIE_BYTES:
                    raise ValueError("Invalid stored cookie file.")
                return content
        except OSError:
            raise RuntimeError("Unable to read the stored cookie file.") from None

    def _stored_jar(self) -> MozillaCookieJar | None:
        content = self._read_stored()
        if content is None:
            return None
        try:
            return _parse_cookies(content.decode("utf-8"))
        except (ValueError, UnicodeError):
            raise RuntimeError("The stored cookie file is invalid or expired.") from None

    @staticmethod
    def _atomic_file(target: Path, *, content=None, jar=None, replace=True):
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        fd, name = tempfile.mkstemp(prefix=".cookies-", dir=target.parent)
        temporary = Path(name)
        try:
            with os.fdopen(fd, "wb") as output:
                os.fchmod(output.fileno(), 0o600)
                if content is not None:
                    output.write(content)
                else:
                    jar.save(temporary, ignore_discard=True, ignore_expires=False)
                output.flush()
                os.fsync(output.fileno())
            if temporary.stat().st_size > _MAX_COOKIE_BYTES:
                raise ValueError("Cookie files must be at most 128 KiB.")
            if replace:
                os.replace(temporary, target)
            else:
                # Publish without overwriting an earlier operation's snapshot.
                os.link(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)

    def _commit(self, jar: MozillaCookieJar, revision: int):
        with self._file_lock:
            self._ensure_open()
            if revision != self._revision:
                raise RuntimeError("Login changed during verification. Please retry.")
            self._atomic_file(self.cookie_path, jar=jar)
            self._revision += 1

    async def _get(self, client, url, jar, **kwargs):
        client.cookies = httpx.Cookies(_scoped_cookies(jar, urlsplit(url).hostname))
        try:
            with _quiet_http():
                response = await client.get(url, **kwargs)
        except httpx.HTTPError:
            raise RuntimeError(_UPSTREAM_ERROR) from None
        finally:
            client.cookies.clear()
        _merge_response_cookies(jar, response)
        return response

    async def account(self) -> dict:
        with self._file_lock:
            self._ensure_open()
            try:
                jar = self._stored_jar()
            except (OSError, ValueError, RuntimeError):
                return {
                    "logged_in": False,
                    "username": None,
                    "vip": False,
                    "message": "保存的登录凭据无效或已过期，请重新登录。",
                }
        if jar is None:
            return {
                "logged_in": False,
                "username": None,
                "vip": False,
                "message": "尚未登录哔哩哔哩。",
            }
        async with self._new_client() as client:
            return _account_result(await self._get(client, _NAV, jar))

    def import_cookies(self, text: str) -> None:
        with self._file_lock:
            self._ensure_open()
            revision = self._revision
        jar = _parse_cookies(text)
        with self._new_sync_client() as client:
            client.cookies = httpx.Cookies(_scoped_cookies(jar, "api.bilibili.com"))
            try:
                with _quiet_http():
                    response = client.get(_NAV)
            except httpx.HTTPError:
                raise RuntimeError(_UPSTREAM_ERROR) from None
            result = _account_result(response)
        if not result["logged_in"]:
            raise RuntimeError(_AUTH_ERROR)
        self._commit(jar, revision)

    def clear_cookies(self) -> None:
        with self._file_lock:
            self._ensure_open()
            self.cookie_path.unlink(missing_ok=True)
            self._revision += 1

    def configured(self) -> bool:
        with self._file_lock:
            try:
                return self._stored_jar() is not None
            except (OSError, ValueError, RuntimeError):
                return False

    def snapshot(self, target: Path) -> Path | None:
        target = Path(target)
        with self._file_lock:
            self._ensure_open()
            try:
                content = self._read_stored()
                if content is None:
                    return None
                _parse_cookies(content.decode("utf-8"))
            except (OSError, ValueError, UnicodeError):
                raise RuntimeError("The stored cookie file is invalid or expired.") from None
            if target.resolve() == self.cookie_path.resolve():
                raise ValueError("A snapshot must use a separate private path.")
            try:
                self._atomic_file(target, content=content, replace=False)
            except FileExistsError:
                raise ValueError("The snapshot path already exists.") from None
            return target

    async def _discard(self, identifier: str, status="expired"):
        session = self._sessions.pop(identifier, None)
        if session is None:
            return
        self._terminal[identifier] = (status, self._revision)
        while len(self._terminal) > 100:
            self._terminal.popitem(last=False)
        if session.timer is not None and session.timer is not asyncio.current_task():
            session.timer.cancel()
            await asyncio.gather(session.timer, return_exceptions=True)
        await session.client.aclose()

    async def _expire(self, identifier: str, delay: float):
        await asyncio.sleep(delay)
        async with self._qr_lock:
            await self._discard(identifier)

    async def create_qr(self) -> dict:
        async with self._qr_lock:
            self._ensure_open()
            for identifier, session in list(self._sessions.items()):
                if self._clock() >= session.expires_at:
                    await self._discard(identifier)
            if len(self._sessions) >= self.MAX_SESSIONS:
                raise RuntimeError("Too many active QR codes. Wait for a code to expire.")
            client = self._new_client()
            jar = MozillaCookieJar()
            with self._file_lock:
                revision = self._revision
            started = self._clock()
            try:
                data = _data(await self._get(client, _GENERATE, jar))
                key, url = data.get("qrcode_key"), data.get("url")
                if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,256}", key):
                    raise RuntimeError(_UPSTREAM_ERROR)
                if not isinstance(url, str) or len(url) > 2048 or not url.isascii():
                    raise RuntimeError(_UPSTREAM_ERROR)
                try:
                    parsed = urlsplit(url)
                    valid = (
                        parsed.scheme == "https"
                        and parsed.hostname in {"passport.bilibili.com", "account.bilibili.com"}
                        and parsed.port in (None, 443)
                        and parsed.username is None
                        and parsed.password is None
                        and not any(ord(c) < 32 or ord(c) == 127 for c in url)
                    )
                except ValueError:
                    valid = False
                if not valid:
                    raise RuntimeError(_UPSTREAM_ERROR)
                image = io.BytesIO()
                qrcode.make(url).save(image, format="PNG")
                ttl = min(self.QR_TTL, 300)
                remaining = max(0, ttl - (self._clock() - started))
                if remaining == 0:
                    raise RuntimeError("The QR code expired. Create a new code.")
            except BaseException:
                await client.aclose()
                raise
            identifier = secrets.token_urlsafe(24)
            session = _QRSession(client, key, jar, started + ttl, revision)
            self._sessions[identifier] = session
            session.timer = asyncio.create_task(self._expire(identifier, remaining))
            return {
                "id": identifier,
                "url": url,
                "image": "data:image/png;base64," + base64.b64encode(image.getvalue()).decode("ascii"),
                "expires_in": int(remaining),
            }

    @staticmethod
    def _poll_result(status):
        return {"status": status, "message": {
            "waiting": "等待扫码",
            "scanned": "已扫码，请在哔哩哔哩客户端确认登录",
            "expired": "二维码已过期，请重新生成",
            "confirmed": "哔哩哔哩登录已验证",
        }[status]}

    async def poll_qr(self, identifier: str) -> dict:
        if not isinstance(identifier, str) or not identifier or len(identifier) > 128:
            raise ValueError("Invalid QR session ID.")
        async with self._qr_lock:
            self._ensure_open()
            if identifier in self._terminal:
                status, revision = self._terminal[identifier]
                if status == "confirmed" and revision != self._revision:
                    status = "expired"
                return self._poll_result(status)
            session = self._sessions.get(identifier)
            if session is None:
                raise ValueError("Unknown QR session ID.")
            if self._clock() >= session.expires_at or session.revision != self._revision:
                await self._discard(identifier)
                return self._poll_result("expired")
            try:
                data = _data(await self._get(
                    session.client, _POLL, session.cookies, params={"qrcode_key": session.key}
                ))
                code = data.get("code")
                if type(code) is not int:
                    raise RuntimeError(_UPSTREAM_ERROR)
                if self._clock() >= session.expires_at or code == 86038:
                    await self._discard(identifier)
                    return self._poll_result("expired")
                if code in (86101, 86090):
                    return self._poll_result("waiting" if code == 86101 else "scanned")
                if code != 0:
                    raise RuntimeError(_UPSTREAM_ERROR)
                # Never visit data.url (a callback URL) or consume its query.
                # Verify only cookies that can actually be persisted for downloads.
                candidate = MozillaCookieJar()
                for cookie in session.cookies:
                    if cookie.domain in _PARENT_DOMAINS:
                        candidate.set_cookie(copy.copy(cookie))
                if not list(candidate):
                    raise RuntimeError(_AUTH_ERROR)
                result = _account_result(await self._get(session.client, _NAV, candidate))
                if not result["logged_in"]:
                    raise RuntimeError(_AUTH_ERROR)
                if self._clock() >= session.expires_at:
                    await self._discard(identifier)
                    return self._poll_result("expired")
                persisted = MozillaCookieJar()
                for cookie in candidate:
                    if cookie.domain in _PARENT_DOMAINS:
                        persisted.set_cookie(copy.copy(cookie))
                if not list(persisted):
                    raise RuntimeError(_AUTH_ERROR)
                self._commit(persisted, session.revision)
                await self._discard(identifier, "confirmed")
                return self._poll_result("confirmed")
            except BaseException:
                await self._discard(identifier)
                raise

    async def close(self) -> None:
        async with self._qr_lock:
            with self._file_lock:
                self._closed = True
            for identifier in list(self._sessions):
                await self._discard(identifier)
            self._terminal.clear()
