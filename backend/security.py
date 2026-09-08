import secrets
import time
from collections import defaultdict, deque

from starlette.responses import JSONResponse

COOKIE_NAME = "downkyi_session"
MAX_BODY = 160 * 1024


class Sessions:
    def __init__(self, token):
        self.token = token
        self.sessions = {}
        self.attempts = defaultdict(deque)

    def valid(self, value):
        expires = self.sessions.get(value, 0)
        return expires > time.time()

    def login(self, token, ip):
        now = time.time()
        if len(self.attempts) > 1000:
            self.attempts = defaultdict(deque, {key: value for key, value in self.attempts.items() if value and value[-1] > now - 60})
        attempts = self.attempts[ip]
        while attempts and attempts[0] <= now - 60:
            attempts.popleft()
        if len(attempts) >= 5:
            return None, 429
        if not secrets.compare_digest(token.encode(), self.token.encode()):
            attempts.append(now)
            return None, 401
        self.sessions = {key: expires for key, expires in self.sessions.items() if expires > now}
        if len(self.sessions) >= 100:
            del self.sessions[min(self.sessions, key=self.sessions.get)]
        key = secrets.token_urlsafe(32)
        self.sessions[key] = now + 7 * 86400
        attempts.clear()
        return key, 200

    def logout(self, value):
        self.sessions.pop(value, None)


class RequestGuard:
    """Bound JSON request bodies before parsing and reject cross-origin mutations."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = {key.lower(): value for key, value in scope["headers"]}
        mutation = scope["method"] in {"POST", "PUT", "PATCH", "DELETE"}
        messages = []
        if mutation:
            from urllib.parse import urlsplit
            origin = headers.get(b"origin")
            if origin:
                try:
                    parsed = urlsplit(origin.decode("ascii"))
                    valid = parsed.scheme in {"http", "https"} and parsed.netloc.encode() == headers.get(b"host") and not parsed.username and not parsed.password
                except (ValueError, UnicodeError):
                    valid = False
                if not valid:
                    return await JSONResponse({"detail": "不允许跨站请求"}, status_code=403)(scope, receive, send)
            if headers.get(b"sec-fetch-site") == b"cross-site":
                return await JSONResponse({"detail": "不允许跨站请求"}, status_code=403)(scope, receive, send)
            size = 0
            while True:
                message = await receive()
                if message["type"] == "http.disconnect":
                    return
                size += len(message.get("body", b""))
                if size > MAX_BODY:
                    return await JSONResponse({"detail": "请求内容过大"}, status_code=413)(scope, receive, send)
                messages.append(message)
                if not message.get("more_body", False):
                    break
            if size and not headers.get(b"content-type", b"").lower().startswith(b"application/json"):
                return await JSONResponse({"detail": "请使用 JSON 请求"}, status_code=415)(scope, receive, send)

        async def replay():
            if messages:
                return messages.pop(0)
            return await receive()

        async def secure_send(message):
            if message["type"] == "http.response.start":
                message["headers"] = list(message.get("headers", [])) + [
                    (b"x-content-type-options", b"nosniff"),
                    (b"x-frame-options", b"DENY"),
                    (b"referrer-policy", b"no-referrer"),
                    (b"permissions-policy", b"camera=(), microphone=(), geolocation=()"),
                    (b"content-security-policy", b"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'"),
                ]
                if scope["path"].startswith("/api"):
                    message["headers"].append((b"cache-control", b"no-store"))
            await send(message)

        await self.app(scope, replay, secure_send)
