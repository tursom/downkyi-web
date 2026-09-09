import json

import pytest

from backend import media
from tests.test_video_collection import BV_URL, install_source


def test_retry_does_not_expand_collection_or_request_unselected_videos(monkeypatch):
    requests, videos, collections = install_source(monkeypatch)
    result = media.retry_media([BV_URL])
    assert len(result['entries']) == 1 and result['entries'][0]['available']
    assert result['entries'][0]['url'] == BV_URL
    assert requests == collections == []
    assert videos == [BV_URL]


def test_retry_failure_does_not_discard_other_successes(monkeypatch):
    calls = []
    urls = [BV_URL + '?p=1', BV_URL + '?p=2']

    def parse(url, cookie, *, expand_collection):
        assert not expand_collection
        calls.append(url)
        if url == urls[0]:
            raise RuntimeError('HTTP Error 412 cookie=private')
        return {'entries': [{'url': url, 'available': True}], 'warnings': []}

    monkeypatch.setattr(media, 'parse_media', parse)
    result = media.retry_media(urls)
    assert calls == urls
    assert not result['entries'][0]['available']
    assert result['entries'][0]['error'] == media.RATE_ERROR
    assert result['entries'][1]['available']
    assert 'private' not in json.dumps(result)


def test_changed_identity_is_not_replaced_by_another_part(monkeypatch):
    monkeypatch.setattr(media, 'parse_media', lambda *args, **kwargs: {
        'entries': [{'url': BV_URL + '?p=1', 'available': True}], 'warnings': []})
    result = media.retry_media([BV_URL])
    assert result['entries'][0]['url'] == BV_URL
    assert not result['entries'][0]['available']
    assert result['entries'][0]['error'] == media.RETRY_CHANGED_ERROR


@pytest.mark.parametrize('urls', [None, [], [BV_URL, BV_URL], [BV_URL] * 101,
                                  ['http://127.0.0.1/private'], ['https://example.com/video/x']])
def test_retry_validates_all_targets_before_network(monkeypatch, urls):
    requests, videos, collections = install_source(monkeypatch)
    with pytest.raises(ValueError):
        media.retry_media(urls)
    assert requests == videos == collections == []


def test_retry_cli_protocol(monkeypatch, capsys):
    seen = []

    def retry(urls, cookie):
        seen.append((urls, cookie))
        return {'entries': [{'url': BV_URL, 'available': True}], 'warnings': []}

    monkeypatch.setattr(media, 'retry_media', retry)
    assert media.main(['retry', json.dumps({'urls': [BV_URL], 'cookie_path': None})]) == 0
    event = json.loads(capsys.readouterr().out)
    assert event['event'] == 'parsed'
    assert seen == [([BV_URL], None)]
