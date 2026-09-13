import asyncio
import copy
import io
import json
import sys
from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient

from backend import media
from backend.discovery import discover_media
from backend.app import create_app
from tests.test_app import FakeAccount, config_at, login
from tests.test_parse_retry import BASE, RetryMedia, entry

BV2 = 'BV1xx411c7mE'
COLLECTION = 'https://space.bilibili.com/123/channel/collectiondetail?sid=456'


class MetadataSource:
    def __init__(self, handler):
        self.handler = handler
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def extract_info(self, *args, **kwargs):
        pytest.fail('Discovery must never invoke even a flat video extractor')

    def urlopen(self, request):
        parsed = urlsplit(request.url)
        assert parsed.hostname == 'api.bilibili.com'
        assert parsed.path in {
            '/x/web-interface/view', '/x/player/pagelist',
            '/x/polymer/web-space/seasons_archives_list', '/x/series/series',
            '/x/series/archives', '/x/v3/fav/resource/list', '/pgc/view/web/season'}
        query = parse_qs(parsed.query)
        self.calls.append((parsed.path, query))
        return io.BytesIO(json.dumps(self.handler(parsed.path, query)).encode())


def view_data(parts=2, **extra):
    return {'title': 'Video', 'pic': 'https://i0.hdslb.com/a.jpg', 'duration': 30,
            'pages': [{'page': p, 'part': f'Part {p}', 'duration': p * 10}
                      for p in range(1, parts + 1)], **extra}


def install(monkeypatch, handler):
    source = MetadataSource(handler)
    monkeypatch.setattr(media, '_make_ydl', lambda options: source)
    return source


def pending(result):
    assert result['entries']
    for item in result['entries']:
        assert item['resolution'] == 'pending'
        assert item['available'] is False and item['error'] is None
        assert item['qualities'] == item['codecs'] == []
    assert media.PARTIAL_WARNING not in result['warnings']


@pytest.mark.parametrize('url,count', [(BASE, 2), (BASE + '?p=2', 1), ('av123', 2)])
def test_metadata_only_multipart_and_explicit_part(monkeypatch, url, count):
    source = install(monkeypatch, lambda path, query: {'code': 0, 'data': view_data()})
    events = []
    result = discover_media(url, on_progress=events.append)
    pending(result)
    assert len(result['entries']) == count
    assert [item['duration'] for item in result['entries']] == ([10, 20] if count == 2 else [20])
    assert len(source.calls) == 1
    assert events[-1]['completed'] == events[-1]['succeeded'] == count
    assert events[-1]['failed'] == 0
    for event in events:
        media.validate_parse_progress(event)


def test_single_never_automatically_extracts_and_pagelist_fallback(monkeypatch):
    def handler(path, query):
        return {'code': 0, 'data': (view_data(1)['pages'] if path.endswith('pagelist')
                                  else view_data(0))}
    source = install(monkeypatch, handler)
    result = discover_media(BASE)
    pending(result)
    assert result['entries'][0]['url'] == BASE
    assert [call[0] for call in source.calls] == ['/x/web-interface/view', '/x/player/pagelist']


@pytest.mark.parametrize('root', [BASE, COLLECTION, 'https://b23.tv/abc'])
def test_collection_priority_expands_parts_without_play_requests(monkeypatch, root):
    if 'b23' in root:
        monkeypatch.setattr(media, '_resolve_url', lambda url: BASE if 'b23.tv' in url else url)
    def handler(path, query):
        if path.endswith('view'):
            # Child videos also belong to a collection: must not recurse into it.
            return {'code': 0, 'data': view_data(2, ugc_season={'id': 456, 'mid': 123})}
        return {'code': 0, 'data': {'meta': {'name': 'Collection'}, 'page': {'total': 2},
                                  'archives': [{'bvid': BASE.rsplit('/', 1)[1]}, {'bvid': BV2}]}}
    source = install(monkeypatch, handler)
    result = discover_media(root)
    pending(result)
    assert len(result['entries']) == 4
    assert {item['group'] for item in result['entries']} == {'Collection'}
    assert sum(path.endswith('seasons_archives_list') for path, _ in source.calls) == 1
    assert len({item['id'] for item in result['entries']}) == 4
    source.calls.clear()
    part = discover_media(BASE + '?p=2')
    assert len(part['entries']) == 1
    assert all(path.endswith('view') for path, _ in source.calls)


@pytest.mark.parametrize('kind', ['collection', 'series', 'favorites'])
def test_paginated_lists_stop_at_100_and_preserve_titles(monkeypatch, kind):
    def handler(path, query):
        if path.endswith('/view'):
            return {'code': 0, 'data': view_data(1)}
        if path.endswith('/series'):
            return {'code': 0, 'data': {'meta': {'name': 'Series'}}}
        pn = int(query.get('pn', query.get('page_num', ['1']))[0])
        size = 20 if kind == 'favorites' else 30
        rows = [{'bvid': f'BV{i:010d}'} for i in range((pn - 1) * size, pn * size)]
        return {'code': 0, 'data': {'archives': rows, 'medias': rows, 'page': {'total': 1000},
                                  'meta': {'name': 'Collection'}, 'info': {'title': 'Favorites', 'media_count': 1000}}}
    source = install(monkeypatch, handler)
    url = COLLECTION if kind == 'collection' else COLLECTION.replace('collection', 'series') if kind == 'series' else 'https://www.bilibili.com/medialist/detail/ml123'
    result = discover_media(url)
    pending(result)
    assert result['truncated'] and len(result['entries']) == 100
    pages = [query for path, query in source.calls if not path.endswith(('/view', '/series'))]
    assert len(pages) <= 6


@pytest.mark.parametrize('identity,count', [('ss123', 2), ('ep2', 1)])
def test_bangumi_metadata_only(monkeypatch, identity, count):
    install(monkeypatch, lambda path, query: {'code': 0, 'result': {'title': 'Season',
        'episodes': [{'id': 1, 'title': 'One', 'duration': 10000}, {'id': 2, 'title': 'Two', 'duration': 20000}]}})
    result = discover_media(identity)
    pending(result)
    assert len(result['entries']) == count
    assert result['entries'][-1]['duration'] == 20


def test_private_favorites_error_is_safe(monkeypatch):
    install(monkeypatch, lambda path, query: {'code': -403, 'message': 'private-cookie-secret'})
    with pytest.raises(RuntimeError, match=media.AUTH_ERROR):
        discover_media('https://www.bilibili.com/medialist/detail/ml123')


class TwoPhaseMedia(RetryMedia):
    async def discover(self, url, cookie, *, on_progress=None):
        result = {'title': 'Collection', 'thumbnail': '', 'truncated': False, 'warnings': [],
                  'entries': [{**entry(str(p), p, False), 'resolution': 'pending', 'error': None}
                              for p in range(1, 4)]}
        if on_progress:
            await on_progress({'stage': 'listing', 'completed': 3, 'total': 3,
                               'succeeded': 3, 'failed': 0, 'title': 'Collection'})
        return result

    async def retry(self, urls, cookie, *, on_progress=None):
        result = await super().retry(urls, cookie)
        if on_progress:
            succeeded = sum(e['available'] for e in result['entries'])
            await on_progress({'stage': 'extracting', 'completed': len(urls), 'total': len(urls),
                               'succeeded': succeeded, 'failed': len(urls) - succeeded, 'title': ''})
        return result


@pytest.fixture
def api(tmp_path):
    source = TwoPhaseMedia()
    account = FakeAccount()
    account.cookies = True
    app = create_app(config_at(tmp_path), media=source, account=account, worker_module='tests.fake_worker')
    with TestClient(app) as client:
        login(client)
        yield client, source


def unpack(response, streaming):
    assert response.status_code == 200, response.text
    if streaming:
        events = [json.loads(line) for line in response.text.splitlines()]
        assert events[0]['event'] == 'progress'
        assert events[-1]['event'] == 'parsed'
        return events[-1]['result']
    return response.json()


@pytest.mark.parametrize('streaming', [False, True])
def test_discover_resolve_merge_progress_and_admission(api, streaming):
    client, source = api
    headers = {'Accept': 'application/x-ndjson'} if streaming else {}
    parsed = unpack(client.post('/api/discover', json={'url': BASE}, headers=headers), streaming)
    pending(parsed)
    before = copy.deepcopy(parsed)
    assert source.calls == []
    assert client.post('/api/tasks', json={'parse_id': parsed['id'], 'entry_ids': ['1']}).status_code == 422
    assert client.post(f"/api/parse/{parsed['id']}/retry", json={'entry_ids': ['1']}).status_code == 422
    result = unpack(client.post(f"/api/parse/{parsed['id']}/resolve", json={'entry_ids': ['2']}, headers=headers), streaming)
    assert source.calls == [[BASE + '?p=2']]
    assert result['id'] != parsed['id']
    assert result['entries'][1]['resolution'] == 'ready'
    assert result['entries'][1]['id'] == '2' and result['entries'][1]['group'] == 'Collection'
    assert result['entries'][0] == parsed['entries'][0]
    assert result['entries'][2] == parsed['entries'][2]
    assert media.PARTIAL_WARNING not in result['warnings']
    assert client.app.state.store.get_parse(parsed['id'])['entries'] == before['entries']
    assert client.post('/api/tasks', json={'parse_id': result['id'], 'entry_ids': ['2']}).status_code == 201
    assert not source.snapshot.exists()
    assert not list((client.app.state.config.data_dir / 'runtime').glob('parse-*'))


@pytest.mark.parametrize('ids', [[], ['unknown'], ['1', '1'], ['1'] * 51])
def test_resolve_rejects_ids_before_work(api, ids):
    client, source = api
    parsed = client.post('/api/discover', json={'url': BASE}).json()
    assert client.post(f"/api/parse/{parsed['id']}/resolve", json={'entry_ids': ids}).status_code == 422
    assert source.calls == []


def test_resolve_expired_ready_and_failed_retry(api):
    client, source = api
    parsed = client.post('/api/discover', json={'url': BASE}).json()
    source.fail_urls.add(BASE + '?p=1')
    failed = client.post(f"/api/parse/{parsed['id']}/resolve", json={'entry_ids': ['1']}).json()
    assert failed['entries'][0]['resolution'] == 'failed'
    assert media.PARTIAL_WARNING in failed['warnings']
    source.fail_urls.clear()
    ready = client.post(f"/api/parse/{failed['id']}/retry", json={'entry_ids': ['1']}).json()
    assert ready['entries'][0]['resolution'] == 'ready'
    assert media.PARTIAL_WARNING not in ready['warnings']
    assert client.post(f"/api/parse/{ready['id']}/resolve", json={'entry_ids': ['1']}).status_code == 422
    client.app.state.store.db.execute('UPDATE parses SET expires=0 WHERE id=?', (parsed['id'],))
    for identity in [parsed['id'], 'missing']:
        assert client.post(f'/api/parse/{identity}/resolve', json={'entry_ids': ['1']}).status_code == 410
    assert len(source.calls) == 2


def test_av_discovery_uses_bv_identity_for_resolution(monkeypatch):
    install(monkeypatch, lambda path, query: {'code': 0, 'data': view_data(1, bvid=BASE.rsplit('/', 1)[1])})
    result = discover_media('av123')
    assert result['entries'][0]['url'] == BASE


@pytest.mark.parametrize('collection', [False, True])
def test_resolve_worker_only_extracts_selected_discovered_parts(monkeypatch, collection):
    from tests.test_media import FakeExtractor, fixture_info
    def handler(path, query):
        if path.endswith('view'):
            return {'code': 0, 'data': view_data()}
        return {'code': 0, 'data': {'meta': {'name': 'Collection'}, 'page': {'total': 2},
                                  'archives': [{'bvid': BASE.rsplit('/', 1)[1]}, {'bvid': BV2}]}}
    install(monkeypatch, handler)
    discovered = discover_media(COLLECTION if collection else BASE)
    selected = [discovered['entries'][-1]['url']]
    extractor = FakeExtractor({selected[0]: fixture_info(id=selected[0].split('/video/')[1].split('?')[0] + '_p2')})
    def make(options):
        assert options['noplaylist'] is True
        assert options['downkyi_expand_collection'] is False
        return extractor
    monkeypatch.setattr(media, '_make_ydl', make)
    resolved = media.retry_media(selected)
    assert extractor.calls == selected
    assert resolved['entries'][0]['resolution'] == 'ready'
    assert resolved['entries'][0]['url'] == selected[0]


def test_partial_pagination_failure_retains_real_metadata(monkeypatch):
    def handler(path, query):
        if path.endswith('view'):
            return {'code': 0, 'data': view_data(1)}
        if query['page_num'] != ['1']:
            raise ConnectionError('private-secret')
        return {'code': 0, 'data': {'page': {'total': 60}, 'meta': {'name': 'Collection'},
                                  'archives': [{'bvid': f'BV{i:010d}'} for i in range(30)]}}
    install(monkeypatch, handler)
    result = discover_media(COLLECTION)
    pending(result)
    assert result['truncated'] and len(result['entries']) == 30
    assert media.NETWORK_ERROR in result['warnings']
    assert 'private-secret' not in json.dumps(result)


def test_real_discover_cli_and_service_protocol(monkeypatch):
    original = asyncio.create_subprocess_exec
    script = '''
from backend import media
from tests.test_discovery import MetadataSource, view_data
media._make_ydl = lambda options: MetadataSource(lambda path, query: {'code': 0, 'data': view_data()})
raise SystemExit(media.main())
'''
    async def spawn(*args, **kwargs):
        assert args[3] == 'discover'
        return await original(sys.executable, '-c', script, *args[3:], **kwargs)
    monkeypatch.setattr(asyncio, 'create_subprocess_exec', spawn)
    async def check():
        events = []
        async def report(value):
            events.append(value)
        result = await media.MediaService(None).discover(BASE, on_progress=report)
        pending(result)
        assert events[-1]['total'] == events[-1]['succeeded'] == 2
    asyncio.run(check())
