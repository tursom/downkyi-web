import asyncio
import base64
import inspect
import logging
import os
import stat
from http.cookiejar import MozillaCookieJar
from pathlib import Path

import httpx
import pytest

from backend.bilibili import BilibiliAccount
from backend.config import Config


GENERATE = "/x/passport-login/web/qrcode/generate"
POLL = "/x/passport-login/web/qrcode/poll"
NAV = "/x/web-interface/nav"
HEADER = "# Netscape HTTP Cookie File\n"


def cookies(value="test-session", domain=".bilibili.com", *, expires="", httponly=False):
    prefix = "#HttpOnly_" if httponly else ""
    flag = "TRUE" if domain.startswith(".") else "FALSE"
    return HEADER + f"{prefix}{domain}\t{flag}\t/\tTRUE\t{expires}\tSESSDATA\t{value}\n"


def reply(data, *, code=0, headers=None):
    return httpx.Response(200, json={"code": code, "data": data}, headers=headers)


def generated(number=1):
    return reply({
        "qrcode_key": f"key-{number}",
        "url": f"https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key=key-{number}",
    })


def verified(logged_in=True):
    return reply({
        "isLogin": logged_in, "uname": "Test User", "vipStatus": 1,
        "mid": 123456, "access_token": "never-return-this",
    })


def auth_headers(value="new-session"):
    return [("set-cookie", f"SESSDATA={value}; Domain=.bilibili.com; Path=/; Secure; HttpOnly")]


class AccountHarness(BilibiliAccount):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.async_clients = []
        self.sync_clients = []

    def _new_client(self):
        client = super()._new_client()
        self.async_clients.append(client)
        return client

    def _new_sync_client(self):
        client = super()._new_sync_client()
        self.sync_clients.append(client)
        return client


@pytest.fixture
def make_account(tmp_path):
    def make(handler, **kwargs):
        config = Config(tmp_path / "data", tmp_path / "downloads", "test-admin-token-123")
        return AccountHarness(config, transport=httpx.MockTransport(handler), **kwargs)
    return make


def run(coro):
    return asyncio.run(coro)


def read_jar(path):
    jar = MozillaCookieJar(str(path))
    jar.load(ignore_discard=True, ignore_expires=True)
    return jar


def test_method_contract():
    for name in ("account", "create_qr", "poll_qr", "close"):
        assert inspect.iscoroutinefunction(getattr(BilibiliAccount, name))
    for name in ("import_cookies", "clear_cookies", "snapshot", "configured"):
        assert not inspect.iscoroutinefunction(getattr(BilibiliAccount, name))


def test_no_cookies_needs_no_network(make_account, tmp_path):
    def handler(request):
        pytest.fail("No network request was expected")
    account = make_account(handler)
    assert not account.configured()
    assert account.snapshot(tmp_path / "private.txt") is None
    result = run(account.account())
    assert result["logged_in"] is False
    assert result["username"] is None
    assert result["vip"] is False
    run(account.close())


def test_import_verify_account_and_httponly_roundtrip(make_account):
    def handler(request):
        assert request.url.scheme == "https"
        assert request.url.host == "api.bilibili.com"
        assert request.url.path == NAV
        assert request.headers["cookie"] == "SESSDATA=test-session"
        return verified()
    account = make_account(handler)
    account.import_cookies(cookies(httponly=True))
    assert account.configured()
    saved = list(read_jar(account.cookie_path))
    assert len(saved) == 1
    assert saved[0].has_nonstandard_attr("HTTPOnly")
    assert stat.S_IMODE(account.cookie_path.stat().st_mode) == 0o600
    result = run(account.account())
    assert result == {
        "logged_in": True, "username": "Test User", "vip": True,
        "message": "Bilibili login verified.",
    }
    assert all(client.is_closed for client in account.sync_clients + account.async_clients)
    assert "123456" not in str(result)
    assert "never-return-this" not in str(result)
    run(account.close())


@pytest.mark.parametrize("text", [
    "SESSDATA=raw-cookie",
    HEADER,
    "",
    cookies(domain="evil.com"),
    cookies(domain=".bilibili.com.evil.com"),
    cookies(domain=".evilbilibili.com"),
    cookies(domain=".api.bilibili.com"),
    cookies(domain="api.bilibili.com"),
    cookies() + cookies(domain=".evil.com").removeprefix(HEADER),
    cookies(value="bad\x00value"),
    cookies(value="bad;value"),
    cookies(value="bad\u00e9value"),
    cookies(value="x" * (128 * 1024)),
    cookies(expires="1"),
    HEADER + ".bilibili.com\tFALSE\t/\tTRUE\t\tSESSDATA\tsecret\n",
    HEADER + ".bilibili.com\tTRUE\t/\tTRUE\tnot-a-date\tSESSDATA\tsecret\n",
    HEADER + "malformed\tsecret\n",
    "\ud800",
    None,
])
def test_invalid_imports_preserve_old_without_network(make_account, text, caplog, recwarn):
    account = make_account(lambda request: pytest.fail("Invalid import reached the network"))
    account.cookie_path.write_text(cookies("previous"))
    original = account.cookie_path.read_bytes()
    with pytest.raises(ValueError) as error:
        account.import_cookies(text)
    assert "secret" not in str(error.value)
    assert account.cookie_path.read_bytes() == original
    assert not recwarn.list
    assert not caplog.records
    run(account.close())


@pytest.mark.parametrize("domain", ["bilibili.com", ".bilibili.com"])
def test_parent_domains_accepted_without_broadening_host_only_cookies(make_account, domain):
    def handler(request):
        expected = "SESSDATA=test-session" if domain.startswith(".") else None
        assert request.headers.get("cookie") == expected
        return verified()
    account = make_account(handler)
    account.import_cookies(cookies(domain=domain))
    assert list(read_jar(account.cookie_path))[0].domain == domain
    run(account.close())


@pytest.mark.parametrize("failure", ["logged_out", "unauthorized", "timeout", "redirect", "malformed", "false_string"])
def test_import_failure_preserves_existing_file(make_account, failure):
    def handler(request):
        if failure == "logged_out":
            return verified(False)
        if failure == "unauthorized":
            return reply(None, code=-101)
        if failure == "timeout":
            raise httpx.ReadTimeout("secret upstream URL", request=request)
        if failure == "redirect":
            return httpx.Response(302, headers={"location": "https://evil.test/?secret=1"})
        if failure == "false_string":
            return reply({"isLogin": "true"})
        return httpx.Response(200, text="secret malformed upstream content")
    account = make_account(handler)
    account.cookie_path.write_text(cookies("previous"))
    original = account.cookie_path.read_bytes()
    with pytest.raises(RuntimeError) as error:
        account.import_cookies(cookies("candidate"))
    assert "secret" not in str(error.value)
    assert account.cookie_path.read_bytes() == original
    assert all(client.is_closed for client in account.sync_clients)
    run(account.close())


def test_generate_png_waiting_scanned_and_expired(make_account):
    codes = iter([86101, 86090, 86038])
    seen = []
    def handler(request):
        seen.append(request.url.path)
        assert request.url.host == "passport.bilibili.com"
        if request.url.path == GENERATE:
            return generated()
        assert request.url.path == POLL
        assert request.url.params["qrcode_key"] == "key-1"
        return reply({"code": next(codes), "message": "DO NOT ECHO UPSTREAM"})
    account = make_account(handler, clock=lambda: 100.0)
    async def scenario():
        qr = await account.create_qr()
        assert set(qr) == {"id", "url", "image", "expires_in"}
        assert qr["id"] != "key-1"
        assert qr["expires_in"] == 180
        prefix, encoded = qr["image"].split(",", 1)
        assert prefix == "data:image/png;base64"
        assert base64.b64decode(encoded).startswith(b"\x89PNG\r\n\x1a\n")
        for status in ("waiting", "scanned", "expired"):
            result = await account.poll_qr(qr["id"])
            assert result["status"] == status
            assert "DO NOT ECHO" not in result["message"]
        assert account.async_clients[0].is_closed
        assert (await account.poll_qr(qr["id"]))["status"] == "expired"
        assert not account.configured()
        await account.close()
    run(scenario())
    assert seen == [GENERATE, POLL, POLL, POLL]


def test_qr_success_merges_parent_cookies_and_verifies_without_callback(make_account):
    seen = []
    def handler(request):
        seen.append(request.url.path)
        if request.url.path == GENERATE:
            return reply({"qrcode_key": "key-1", "url": "https://passport.bilibili.com/scan"}, headers=[
                ("set-cookie", "qr_session=qr-only; Path=/; Secure"),
                ("set-cookie", "bili_jct=csrf; Domain=.bilibili.com; Path=/; Secure"),
            ])
        if request.url.path == POLL:
            assert "qr_session=qr-only" in request.headers["cookie"]
            assert "bili_jct=csrf" in request.headers["cookie"]
            return reply({"code": 0, "url": "https://evil.test/callback?SESSDATA=exfiltrate"}, headers=
                auth_headers() + [
                    ("set-cookie", "evil=ignored; Domain=.evil.test; Path=/"),
                    ("set-cookie", "sibling=ignored; Domain=api.bilibili.com; Path=/"),
                    ("set-cookie", "passport_only=private; Path=/; Secure"),
                ])
        assert request.url.path == NAV
        assert request.url.host == "api.bilibili.com"
        assert set(request.headers["cookie"].split("; ")) == {"SESSDATA=new-session", "bili_jct=csrf"}
        return verified()
    account = make_account(handler)
    account.cookie_path.write_text(cookies("previous"))
    async def scenario():
        qr = await account.create_qr()
        assert (await account.poll_qr(qr["id"]))["status"] == "confirmed"
        assert account.async_clients[0].is_closed
        assert (await account.poll_qr(qr["id"]))["status"] == "confirmed"
        assert {c.name for c in read_jar(account.cookie_path)} == {"SESSDATA", "bili_jct"}
        assert all(c.domain == ".bilibili.com" for c in read_jar(account.cookie_path))
        assert stat.S_IMODE(account.cookie_path.stat().st_mode) == 0o600
        await account.close()
    run(scenario())
    assert seen == [GENERATE, POLL, NAV]


@pytest.mark.parametrize("failure", ["logged_out", "timeout", "redirect", "malformed", "host_only", "callback_only", "unknown_code"])
def test_qr_failed_auth_never_replaces_old_cookies(make_account, failure):
    seen = []
    def handler(request):
        seen.append(request.url.path)
        if request.url.path == GENERATE:
            return generated()
        if request.url.path == POLL:
            if failure == "unknown_code":
                return reply({"code": 98765, "message": "secret upstream message"})
            headers = auth_headers()
            if failure == "host_only":
                headers = {"set-cookie": "SESSDATA=host-only; Path=/; Secure"}
            if failure == "callback_only":
                headers = {}
            return reply({"code": 0, "url": "https://passport.bilibili.com/callback?SESSDATA=secret"}, headers=headers)
        assert request.url.path == NAV
        if failure == "timeout":
            raise httpx.ReadTimeout("secret", request=request)
        if failure == "redirect":
            return httpx.Response(307, headers={"location": "https://evil.test/?secret=1"})
        if failure == "malformed":
            return reply({"isLogin": 1})
        return verified(False)
    account = make_account(handler)
    account.cookie_path.write_text(cookies("previous"))
    original = account.cookie_path.read_bytes()
    async def scenario():
        qr = await account.create_qr()
        with pytest.raises(RuntimeError) as error:
            await account.poll_qr(qr["id"])
        assert "secret" not in str(error.value)
        assert account.cookie_path.read_bytes() == original
        assert account.async_clients[0].is_closed
        assert not account._sessions
        await account.close()
    run(scenario())
    if failure in ("host_only", "callback_only", "unknown_code"):
        assert seen == [GENERATE, POLL]


@pytest.mark.parametrize("value", [None, "", "unknown", "x" * 129, [], 1])
def test_unknown_or_invalid_id_has_no_network(make_account, value):
    account = make_account(lambda request: pytest.fail("Unexpected request"))
    async def scenario():
        with pytest.raises(ValueError):
            await account.poll_qr(value)
        await account.close()
    run(scenario())


def test_session_isolation_cap_local_expiry_and_close(make_account):
    now = [0.0]
    counter = [0]
    def handler(request):
        if request.url.path == GENERATE:
            counter[0] += 1
            response = generated(counter[0])
            response.headers["set-cookie"] = f"qr_session=session-{counter[0]}; Path=/; Secure"
            assert "cookie" not in request.headers
            return response
        number = request.url.params["qrcode_key"].removeprefix("key-")
        assert request.headers["cookie"] == f"qr_session=session-{number}"
        return reply({"code": 86101})
    account = make_account(handler, clock=lambda: now[0])
    async def scenario():
        codes = [await account.create_qr() for _ in range(10)]
        assert len({code["id"] for code in codes}) == 10
        with pytest.raises(RuntimeError, match="Too many"):
            await account.create_qr()
        assert counter[0] == 10
        await account.poll_qr(codes[0]["id"])
        await account.poll_qr(codes[1]["id"])
        now[0] = 180.0
        assert (await account.poll_qr(codes[0]["id"]))["status"] == "expired"
        fresh = await account.create_qr()
        assert all(client.is_closed for client in account.async_clients[:-1])
        assert (await account.poll_qr(fresh["id"]))["status"] == "waiting"
        timers = [session.timer for session in account._sessions.values()]
        await account.close()
        assert all(client.is_closed for client in account.async_clients)
        assert all(timer.done() for timer in timers)
        await account.close()
        with pytest.raises(RuntimeError, match="closed"):
            await account.create_qr()
    run(scenario())


def test_idle_session_timer_closes_client(make_account):
    account = make_account(lambda request: generated())
    account.QR_TTL = 0.02
    async def scenario():
        qr = await account.create_qr()
        timer = account._sessions[qr["id"]].timer
        await asyncio.wait_for(asyncio.shield(timer), timeout=1)
        assert account.async_clients[0].is_closed
        assert (await account.poll_qr(qr["id"]))["status"] == "expired"
        await account.close()
    run(scenario())


@pytest.mark.parametrize("failure", ["network", "redirect", "http_url", "evil_url", "userinfo", "port", "malformed", "missing_key"])
def test_generate_failures_close_client(make_account, failure):
    def handler(request):
        if failure == "network":
            raise httpx.ConnectError("secret", request=request)
        if failure == "redirect":
            return httpx.Response(302, headers={"location": "https://evil.test/secret"})
        if failure == "malformed":
            return httpx.Response(200, json=[])
        urls = {
            "http_url": "http://passport.bilibili.com/scan",
            "evil_url": "https://passport.bilibili.com.evil.test/scan",
            "userinfo": "https://secret@passport.bilibili.com/scan",
            "port": "https://passport.bilibili.com:444/scan",
        }
        return reply({"qrcode_key": None if failure == "missing_key" else "key-1", "url": urls.get(failure)})
    account = make_account(handler)
    async def scenario():
        with pytest.raises(RuntimeError) as error:
            await account.create_qr()
        assert "secret" not in str(error.value)
        assert not account._sessions
        assert all(client.is_closed for client in account.async_clients)
        await account.close()
    run(scenario())


def test_snapshot_is_private_independent_and_never_overwritten(make_account, tmp_path):
    account = make_account(lambda request: verified())
    account.import_cookies(cookies("old"))
    target = tmp_path / "operation" / "cookies.txt"
    assert account.snapshot(target) == target
    original = target.read_bytes()
    assert stat.S_IMODE(target.stat().st_mode) == 0o600
    assert stat.S_IMODE(target.parent.stat().st_mode) == 0o700
    assert target.stat().st_ino != account.cookie_path.stat().st_ino
    account.import_cookies(cookies("new"))
    assert target.read_bytes() == original
    assert account.cookie_path.read_bytes() != original
    with pytest.raises(ValueError, match="already exists"):
        account.snapshot(target)
    with pytest.raises(ValueError, match="separate"):
        account.snapshot(account.cookie_path)
    account.clear_cookies()
    assert not account.configured()
    assert target.read_bytes() == original
    assert account.snapshot(tmp_path / "missing.txt") is None
    account.clear_cookies()
    assert not list(account.cookie_path.parent.glob(".cookies-*"))
    assert not list(target.parent.glob(".cookies-*"))
    run(account.close())


def test_snapshot_observes_external_atomic_replacement(make_account, tmp_path):
    account = make_account(lambda request: verified())
    account.import_cookies(cookies("old"))
    first = account.snapshot(tmp_path / "one.txt")
    replacement = tmp_path / "replacement.txt"
    replacement.write_text(cookies("external"))
    os.replace(replacement, account.cookie_path)
    second = account.snapshot(tmp_path / "two.txt")
    assert list(read_jar(first))[0].value == "old"
    assert list(read_jar(second))[0].value == "external"
    assert stat.S_IMODE(second.stat().st_mode) == 0o600
    run(account.close())


def test_symlink_cookie_and_snapshot_paths_are_not_followed(make_account, tmp_path):
    account = make_account(lambda request: verified())
    victim = tmp_path / "victim"
    victim.write_text(cookies("victim"))
    account.cookie_path.symlink_to(victim)
    assert not account.configured()
    with pytest.raises(RuntimeError):
        account.snapshot(tmp_path / "copy.txt")
    account.import_cookies(cookies("new"))
    assert not account.cookie_path.is_symlink()
    assert list(read_jar(victim))[0].value == "victim"
    target = tmp_path / "snapshot.txt"
    target.symlink_to(victim)
    with pytest.raises(ValueError):
        account.snapshot(target)
    assert list(read_jar(victim))[0].value == "victim"
    run(account.close())


def test_clear_during_verification_prevents_stale_commit(make_account):
    account = None
    def handler(request):
        if request.url.path == GENERATE:
            return generated()
        if request.url.path == POLL:
            return reply({"code": 0}, headers=auth_headers())
        account.clear_cookies()
        return verified()
    account = make_account(handler)
    account.cookie_path.write_text(cookies("previous"))
    async def scenario():
        qr = await account.create_qr()
        with pytest.raises(RuntimeError, match="changed"):
            await account.poll_qr(qr["id"])
        assert not account.cookie_path.exists()
        assert account.async_clients[0].is_closed
        await account.close()
    run(scenario())


def test_expired_saved_cookies_report_logged_out_without_deleting(make_account):
    account = make_account(lambda request: pytest.fail("Expired cookies reached the network"))
    account.cookie_path.write_text(cookies("old", expires="1"))
    original = account.cookie_path.read_bytes()
    result = run(account.account())
    assert result["logged_in"] is False
    assert result["username"] is None
    assert result["vip"] is False
    assert account.cookie_path.read_bytes() == original
    run(account.close())


def test_auth_requests_do_not_log_keys_or_cookie_headers(make_account, caplog):
    caplog.set_level(logging.DEBUG)
    def handler(request):
        # Emulate httpcore's debug trace of response headers.
        logging.getLogger("httpcore.http11").debug("set-cookie: SESSDATA=private-cookie-value")
        if request.url.path == GENERATE:
            return generated()
        if request.url.path == POLL:
            return reply({"code": 0}, headers=auth_headers("private-cookie-value"))
        return verified()
    account = make_account(handler)
    account.import_cookies(cookies("private-cookie-value"))
    async def scenario():
        qr = await account.create_qr()
        await account.poll_qr(qr["id"])
        await account.account()
        await account.close()
    run(scenario())
    assert "key-1" not in caplog.text
    assert "private-cookie-value" not in caplog.text
    # Suppression must not change unrelated requests' logging configuration.
    logging.getLogger("httpx").info("ordinary request outside authentication")
    assert "ordinary request outside authentication" in caplog.text


def test_atomic_save_failure_keeps_previous_file_and_cleans_temporary(make_account, monkeypatch):
    account = make_account(lambda request: verified())
    account.import_cookies(cookies("previous"))
    original = account.cookie_path.read_bytes()
    def fail_replace(source, target):
        assert stat.S_IMODE(Path(source).stat().st_mode) == 0o600
        assert Path(target) == account.cookie_path
        raise OSError("simulated disk failure")
    monkeypatch.setattr(os, "replace", fail_replace)
    with pytest.raises(OSError, match="simulated"):
        account.import_cookies(cookies("candidate"))
    assert account.cookie_path.read_bytes() == original
    assert not list(account.cookie_path.parent.glob(".cookies-*"))
    run(account.close())


def test_verified_qr_cannot_be_replayed_as_confirmed_after_clear(make_account):
    def handler(request):
        if request.url.path == GENERATE:
            return generated()
        if request.url.path == POLL:
            return reply({"code": 0}, headers=auth_headers())
        return verified()
    account = make_account(handler)
    async def scenario():
        qr = await account.create_qr()
        assert (await account.poll_qr(qr["id"]))["status"] == "confirmed"
        account.clear_cookies()
        assert (await account.poll_qr(qr["id"]))["status"] == "expired"
        assert not account.configured()
        await account.close()
    run(scenario())


@pytest.mark.parametrize("during", ["generate", "poll"])
def test_cancellation_closes_client_and_preserves_cookies(make_account, during):
    async def scenario():
        started = asyncio.Event()
        async def handler(request):
            if during == "poll" and request.url.path == GENERATE:
                return generated()
            started.set()
            await asyncio.Event().wait()
        account = make_account(handler)
        account.cookie_path.write_text(cookies("previous"))
        original = account.cookie_path.read_bytes()
        if during == "generate":
            task = asyncio.create_task(account.create_qr())
        else:
            qr = await account.create_qr()
            task = asyncio.create_task(account.poll_qr(qr["id"]))
        await asyncio.wait_for(started.wait(), timeout=1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert not account._sessions
        assert all(client.is_closed for client in account.async_clients)
        assert account.cookie_path.read_bytes() == original
        await account.close()
    run(scenario())


def test_local_expiry_during_verification_cannot_commit(make_account):
    now = [0.0]
    def handler(request):
        if request.url.path == GENERATE:
            return generated()
        if request.url.path == POLL:
            return reply({"code": 0}, headers=auth_headers())
        now[0] = 180.0
        return verified()
    account = make_account(handler, clock=lambda: now[0])
    account.cookie_path.write_text(cookies("previous"))
    original = account.cookie_path.read_bytes()
    async def scenario():
        qr = await account.create_qr()
        assert (await account.poll_qr(qr["id"]))["status"] == "expired"
        assert account.cookie_path.read_bytes() == original
        assert account.async_clients[0].is_closed
        await account.close()
    run(scenario())


def test_account_logged_out_response_preserves_credentials(make_account):
    account = make_account(lambda request: verified(False))
    account.cookie_path.write_text(cookies("previous"))
    original = account.cookie_path.read_bytes()
    result = run(account.account())
    assert result["logged_in"] is False
    assert result["username"] is None
    assert result["vip"] is False
    assert account.cookie_path.read_bytes() == original
    assert account.async_clients[0].is_closed
    run(account.close())


def test_clients_disable_environment_and_redirects(make_account, monkeypatch):
    monkeypatch.setenv("HTTPS_PROXY", "http://invalid.proxy:1")
    monkeypatch.setenv("SSL_CERT_FILE", "/does/not/exist")
    account = make_account(lambda request: verified())
    options = account._client_options()
    assert options["trust_env"] is False
    assert options["follow_redirects"] is False
    account.import_cookies(cookies())
    run(account.close())
