import asyncio
import copy
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from backend.app import create_app
from backend.media import PARTIAL_WARNING, RATE_ERROR
from tests.test_app import FakeAccount, config_at, login

BASE = 'https://www.bilibili.com/video/BV1xx411c7mD'


def entry(key, part, available):
    return {'id': key, 'url': BASE + f'?p={part}', 'title': f'Episode {part}',
            'duration': 90, 'thumbnail': 'https://i0.hdslb.com/cover.jpg', 'group': 'Collection',
            'available': available, 'error': None if available else RATE_ERROR,
            'qualities': [720] if available else [], 'codecs': ['auto', 'avc'] if available else [],
            'has_subtitles': False}


class RetryMedia:
    def __init__(self):
        self.calls = []
        self.snapshot = None
        self.fail_urls = set()
        self.error = None
        self.bad_result = False

    async def parse(self, url, cookie):
        return {'title': 'Collection', 'thumbnail': '', 'truncated': False,
                'warnings': [PARTIAL_WARNING], 'entries': [
                    entry('good', 1, True), entry('failed', 2, False), entry('other', 3, False)]}

    async def retry(self, urls, cookie):
        self.calls.append(urls)
        self.snapshot = cookie
        if cookie:
            assert cookie.read_text() == 'private-cookie-value'
        if self.error:
            raise self.error
        if self.bad_result:
            return {'entries': [], 'warnings': []}
        return {'entries': [dict(entry('worker-id', int(url[-1]), url not in self.fail_urls),
                                 group='', title='Fresh title' if url not in self.fail_urls else '')
                            for url in urls], 'warnings': []}


@pytest.fixture
def setup(tmp_path):
    source = RetryMedia()
    account = FakeAccount()
    app = create_app(config_at(tmp_path), account=account, media=source, worker_module='tests.fake_worker')
    with TestClient(app) as client:
        login(client)
        parsed = client.post('/api/parse', json={'url': BASE}).json()
        yield client, source, account, parsed


def retry(client, parsed, ids):
    return client.post(f"/api/parse/{parsed['id']}/retry", json={'entry_ids': ids})


def test_retry_merges_only_failed_entries_and_issues_immutable_parse_id(setup):
    client, source, account, parsed = setup
    account.cookies = True
    before = copy.deepcopy(parsed)
    response = retry(client, parsed, ['failed'])
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['id'] != parsed['id']
    assert source.calls == [[BASE + '?p=2']]
    assert result['title'] == parsed['title']
    assert result['entries'][0] == parsed['entries'][0]
    assert result['entries'][2] == parsed['entries'][2]
    recovered = result['entries'][1]
    assert recovered['available'] and recovered['error'] is None
    assert recovered['id'] == 'failed' and recovered['url'] == BASE + '?p=2'
    assert recovered['group'] == 'Collection' and recovered['qualities'] == [720]
    assert PARTIAL_WARNING in result['warnings']
    assert client.app.state.store.get_parse(parsed['id'])['entries'] == before['entries']
    assert client.app.state.store.get_parse(result['id'])['entries'] == result['entries']
    assert source.snapshot is not None and not source.snapshot.exists()
    assert not list((client.app.state.config.data_dir / 'runtime').iterdir())
    assert 'private-cookie-value' not in response.text


def test_recovered_entries_can_be_admitted_using_new_result_only(setup):
    client, source, _, parsed = setup
    result = retry(client, parsed, ['failed', 'other']).json()
    assert PARTIAL_WARNING not in result['warnings']
    assert client.post('/api/tasks', json={'parse_id': parsed['id'], 'entry_ids': ['failed']}).status_code == 422
    admitted = client.post('/api/tasks', json={'parse_id': result['id'], 'entry_ids': ['good', 'failed']})
    assert admitted.status_code == 201, admitted.text
    assert [task['url'] for task in admitted.json()['tasks']] == [BASE + '?p=1', BASE + '?p=2']


def test_still_failed_entry_keeps_metadata_and_can_be_retried_again(setup):
    client, source, _, parsed = setup
    source.fail_urls.add(BASE + '?p=2')
    result = retry(client, parsed, ['failed']).json()
    assert result['entries'][1] == parsed['entries'][1]
    source.fail_urls.clear()
    recovered = retry(client, result, ['failed']).json()
    assert recovered['entries'][1]['available']
    assert source.calls == [[BASE + '?p=2'], [BASE + '?p=2']]


@pytest.mark.parametrize('body', [
    {'entry_ids': []}, {'entry_ids': ['failed', 'failed']}, {'entry_ids': ['unknown']},
    {'entry_ids': ['good']}, {'entry_ids': ['failed'], 'url': 'http://127.0.0.1'},
    {'entry_ids': ['failed'] * 101},
])
def test_retry_rejects_untrusted_or_successful_selections_without_work(setup, body):
    client, source, _, parsed = setup
    assert client.post(f"/api/parse/{parsed['id']}/retry", json=body).status_code == 422
    assert source.calls == []


def test_expired_parse_returns_410_without_work(setup):
    client, source, _, parsed = setup
    client.app.state.store.db.execute('UPDATE parses SET expires=0 WHERE id=?', (parsed['id'],))
    response = retry(client, parsed, ['failed'])
    assert response.status_code == 410 and '过期' in response.json()['detail']
    assert source.calls == []


def test_retry_keeps_authentication_and_origin_protection(setup):
    client, source, _, parsed = setup
    assert client.post(f"/api/parse/{parsed['id']}/retry", json={'entry_ids': ['failed']},
                       headers={'Origin': 'https://evil.test'}).status_code == 403
    client.post('/api/logout')
    assert retry(client, parsed, ['failed']).status_code == 401
    assert source.calls == []


def test_retry_is_available_in_no_token_mode(tmp_path):
    app = create_app(replace(config_at(tmp_path), auth_mode='none'), account=FakeAccount(),
                     media=RetryMedia(), worker_module='tests.fake_worker')
    with TestClient(app) as client:
        parsed = client.post('/api/parse', json={'url': BASE}).json()
        assert retry(client, parsed, ['failed']).status_code == 200


@pytest.mark.parametrize('bad_result', [False, True])
def test_failed_operation_keeps_original_result_and_cleans_snapshot(setup, bad_result):
    client, source, account, parsed = setup
    account.cookies = True
    source.bad_result = bad_result
    source.error = None if bad_result else RuntimeError('https://private/?cookie=secret /root/private')
    response = retry(client, parsed, ['failed'])
    assert response.status_code == 502
    assert all(text not in response.text for text in ('secret', '/root/', 'https://private'))
    assert client.app.state.store.get_parse(parsed['id'])['entries'] == parsed['entries']
    assert client.app.state.store.db.execute('SELECT count(*) FROM parses').fetchone()[0] == 1
    assert not list((client.app.state.config.data_dir / 'runtime').iterdir())


def test_retry_shares_parse_concurrency_limit_and_cleans_up(setup):
    client, source, _, parsed = setup
    started = asyncio.Event()
    release = asyncio.Event()
    running = 0
    original = source.retry

    async def blocked(urls, cookie):
        nonlocal running
        running += 1
        if running == 2:
            started.set()
        await release.wait()
        return await original(urls, cookie)

    source.retry = blocked
    import concurrent.futures
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        calls = [pool.submit(retry, client, parsed, ['failed']) for _ in range(2)]
        try:
            client.portal.call(asyncio.wait_for, started.wait(), 5)
            assert retry(client, parsed, ['failed']).status_code == 429
            assert client.post('/api/parse', json={'url': BASE}).status_code == 429
        finally:
            client.portal.call(release.set)
        assert all(call.result(timeout=5).status_code == 200 for call in calls)
    assert not list((client.app.state.config.data_dir / 'runtime').iterdir())
