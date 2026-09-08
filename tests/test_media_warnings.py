from backend.media import _Logger


def test_subtitle_login_warning_does_not_claim_video_is_inaccessible():
    logger = _Logger()
    logger.warning("Subtitles are only available when logged in. cookie=private-value https://example.com/secret")
    assert logger.warnings == ["字幕需要登录后才能获取，不影响当前可用视频的下载。"]
