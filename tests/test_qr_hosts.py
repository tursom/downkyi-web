import asyncio
from urllib.parse import urlsplit

import pytest

from tests.test_bilibili import make_account, reply


@pytest.mark.parametrize("host", ["account.bilibili.com", "passport.bilibili.com"])
def test_qr_accepts_current_and_legacy_official_scan_hosts(make_account, host):
    account = make_account(lambda request: reply({
        "qrcode_key": "fixture-key",
        "url": f"https://{host}/h5-app/passport/login/scan?qrcode_key=fixture-key",
    }))
    async def run():
        try:
            result = await account.create_qr()
            assert urlsplit(result["url"]).hostname == host
            assert result["image"].startswith("data:image/png;base64,")
        finally:
            await account.close()
    asyncio.run(run())


@pytest.mark.parametrize("host", ["account.bilibili.com.evil.test", "evil.bilibili.com", "bilibili.com"])
def test_qr_rejects_other_scan_hosts(make_account, host):
    account = make_account(lambda request: reply({
        "qrcode_key": "fixture-key", "url": f"https://{host}/scan?qrcode_key=fixture-key",
    }))
    async def run():
        try:
            with pytest.raises(RuntimeError):
                await account.create_qr()
        finally:
            await account.close()
    asyncio.run(run())
