"""Video links should discover their UGC collection before listing entries."""
import io
import json

import pytest

from backend import media
from tests.test_media import fixture_info

VIDEO = 'https://www.bilibili.com/video/av116605745239789'
BV_URL = 'https://www.bilibili.com/video/BV1HqL16BEeF'
COLLECTION = 'https://space.bilibili.com/70942172/channel/collectiondetail?sid=7839144'
CHILD = 'https://www.bilibili.com/video/BV1J2SRB5EDa'


def install_source(monkeypatch, payload=None, error=None):
    from yt_dlp import YoutubeDL
    from yt_dlp.extractor.bilibili import BiliBiliIE, BilibiliCollectionListIE
    requests, videos, collections = [], [], []
    if payload is None:
        payload = {'code': 0, 'data': {'season_id': 7839144, 'owner': {'mid': 70942172},
                    'ugc_season': {'id': 7839144, 'mid': 70942172, 'title': '人民的名义-2026版'}}}

    def urlopen(self, request):
        requests.append(request if isinstance(request, str) else request.url)
        if error:
            raise error
        return io.BytesIO(json.dumps(payload).encode())

    def video(self, url):
        videos.append(url)
        bvid = 'BV1J2SRB5EDa' if url == CHILD else 'BV1HqL16BEeF'
        return fixture_info(id=bvid, webpage_url=url)

    def collection(self, url):
        collections.append(url)
        return {'_type': 'playlist', 'title': '人民的名义-2026版', 'entries': [
            {'_type': 'url', 'url': CHILD}, {'_type': 'url', 'url': BV_URL}]}

    monkeypatch.setattr(YoutubeDL, 'urlopen', urlopen)
    monkeypatch.setattr(BiliBiliIE, '_real_extract', video)
    monkeypatch.setattr(BilibiliCollectionListIE, '_real_extract', collection)
    return requests, videos, collections


@pytest.mark.parametrize('url,query', [(VIDEO, 'aid=116605745239789'), (BV_URL, 'bvid=BV1HqL16BEeF')])
def test_video_expands_collection_once_and_preserves_individual_download_urls(monkeypatch, url, query):
    requests, videos, collections = install_source(monkeypatch)
    result = media.parse_media(url)
    assert len(result['entries']) == 2
    assert result['title'] == '人民的名义-2026版'
    assert [entry['url'] for entry in result['entries']] == [CHILD, BV_URL]
    assert all(entry['available'] and entry['qualities'] == [1080] for entry in result['entries'])
    assert videos == [CHILD, BV_URL]
    assert collections == [COLLECTION]
    assert len(requests) == 1 and query in requests[0]


def test_short_link_discovers_collection_after_resolution(monkeypatch):
    install_source(monkeypatch)
    monkeypatch.setattr(media, '_resolve_url', lambda url: VIDEO)
    assert len(media.parse_media('https://b23.tv/abc')['entries']) == 2


@pytest.mark.parametrize('url', [BV_URL + '?p=1', VIDEO + '?p=2'])
def test_explicit_part_does_not_expand_collection(monkeypatch, url):
    requests, videos, collections = install_source(monkeypatch)
    result = media.parse_media(url)
    assert len(result['entries']) == 1
    assert videos == [url]
    assert requests == collections == []


def test_direct_collection_link_does_not_rediscover_child_collections(monkeypatch):
    requests, videos, collections = install_source(monkeypatch)
    assert len(media.parse_media(COLLECTION)['entries']) == 2
    assert requests == []
    assert videos == [CHILD, BV_URL]
    assert collections == [COLLECTION]


def test_video_without_collection_remains_single(monkeypatch):
    requests, videos, collections = install_source(monkeypatch, {'code': 0, 'data': {'season_id': 0}})
    result = media.parse_media(VIDEO)
    assert len(result['entries']) == 1
    assert collections == [] and videos == [VIDEO]
    assert len(requests) == 1
    assert not result['warnings']


def test_season_id_and_owner_work_without_embedded_episode_list(monkeypatch):
    install_source(monkeypatch, {'code': 0, 'data': {'season_id': 7839144, 'owner': {'mid': 70942172}}})
    assert len(media.parse_media(VIDEO)['entries']) == 2


def test_discovery_failure_preserves_video_with_safe_warning(monkeypatch):
    install_source(monkeypatch, error=RuntimeError('https://private/?SESSDATA=secret'))
    result = media.parse_media(VIDEO)
    assert len(result['entries']) == 1 and result['entries'][0]['available']
    assert any('合集' in warning for warning in result['warnings'])
    assert 'secret' not in json.dumps(result)


@pytest.mark.parametrize('mid,sid', [('evil.test', 7839144), (70942172, '../etc'), (True, 7839144)])
def test_invalid_collection_identity_cannot_redirect_extraction(monkeypatch, mid, sid):
    requests, videos, collections = install_source(monkeypatch, {'code': 0, 'data': {'ugc_season': {'id': sid, 'mid': mid}}})
    result = media.parse_media(VIDEO)
    assert len(result['entries']) == 1
    assert collections == []
    assert len(requests) == 1


@pytest.mark.parametrize('payload', [
    {'code': -412, 'message': 'upstream secret'},
    {'code': 0, 'data': None},
    {'code': 0, 'data': {'ugc_season': 'malformed'}},
])
def test_invalid_discovery_response_falls_back_explicitly(monkeypatch, payload):
    install_source(monkeypatch, payload)
    result = media.parse_media(VIDEO)
    assert len(result['entries']) == 1 and result['entries'][0]['available']
    assert any('合集' in warning for warning in result['warnings'])
    assert 'upstream secret' not in json.dumps(result)


def test_failed_child_retains_collection_title_duration_and_cover(monkeypatch):
    from yt_dlp.extractor.bilibili import BiliBiliIE
    install_source(monkeypatch, {'code': 0, 'data': {'ugc_season': {
        'id': 7839144, 'mid': 70942172, 'sections': [{'episodes': [{
            'bvid': 'BV1J2SRB5EDa', 'title': '合集里的第一集',
            'arc': {'duration': 125, 'pic': 'https://i0.hdslb.com/bfs/archive/cover.jpg'},
        }]}],
    }}})
    original = BiliBiliIE._real_extract

    def extract(self, url):
        if url == CHILD:
            raise RuntimeError('HTTP Error 412')
        return original(self, url)

    monkeypatch.setattr(BiliBiliIE, '_real_extract', extract)
    result = media.parse_media(VIDEO)
    failed = result['entries'][0]
    assert failed['title'] == '合集里的第一集'
    assert failed['duration'] == 125
    assert failed['thumbnail'] == 'https://i0.hdslb.com/bfs/archive/cover.jpg'
    assert failed['available'] is False and failed['error'] == media.RATE_ERROR
    assert failed['qualities'] == []
    assert result['entries'][1]['available'] is True


def test_discovered_collection_retains_entry_limit(monkeypatch):
    from yt_dlp.extractor.bilibili import BilibiliCollectionListIE
    requests, videos, collections = install_source(monkeypatch)
    monkeypatch.setattr(BilibiliCollectionListIE, '_real_extract', lambda self, url: {
        '_type': 'playlist', 'title': 'Large collection', 'entries': (
            {'_type': 'url', 'url': BV_URL + f'?p={part}'} for part in range(1, 150))})
    result = media.parse_media(VIDEO)
    assert len(result['entries']) == media.MAX_ENTRIES
    assert result['truncated'] is True
    assert len(videos) == media.MAX_ENTRIES
    assert len(requests) == 1


def test_download_extractor_keeps_requested_video(monkeypatch):
    requests, videos, collections = install_source(monkeypatch)
    options = media._base_options(None, media._Logger())
    options['noplaylist'] = True
    with media._make_ydl(options) as ydl:
        info = ydl.extract_info(BV_URL, download=False, process=False)
    assert info.get('_type', 'video') == 'video'
    assert videos == [BV_URL]
    assert requests == collections == []
