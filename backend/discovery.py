"""Metadata-only discovery. Never invoke a video extractor or a player endpoint."""
from urllib.parse import parse_qs, urlencode, urlsplit
import json
import re

from . import media as m


def discover_media(url, cookie_path=None, *, on_progress=None):
    entries, seen = [], set()
    truncated = False
    logger = m._Logger()
    title, thumbnail = "", ""

    def report(final=False):
        if on_progress:
            # Success here means metadata was discovered, not media is playable.
            on_progress({"stage": "listing", "completed": len(entries),
                         "total": len(entries) if final and not truncated else None,
                         "succeeded": len(entries), "failed": 0, "title": m._text(title)})

    if on_progress:
        on_progress({"stage": "resolving", "completed": 0, "total": None,
                     "succeeded": 0, "failed": 0, "title": ""})
    url = m._resolve_url(m.canonical_url(url))
    with m._make_ydl(m._base_options(cookie_path, logger)) as ydl:
        def api(path, **query):
            from yt_dlp.networking import Request
            request = Request("https://api.bilibili.com/" + path + "?" + urlencode(query),
                              headers={"Referer": "https://www.bilibili.com/"})
            with ydl.urlopen(request) as response:
                raw = response.read(8 * 1024 * 1024 + 1)
            if len(raw) > 8 * 1024 * 1024:
                raise RuntimeError(m.GENERIC_ERROR)
            payload = json.loads(raw)
            code = payload.get("code")
            if code != 0:
                raise RuntimeError(m.AUTH_ERROR if code in (-101, -403, -400, 403)
                                   else m.RATE_ERROR if code in (-412, 412, 429)
                                   else m.UNAVAILABLE_ERROR if code in (-404, 404, 62002)
                                   else m.NETWORK_ERROR)
            data = payload.get("data", payload.get("result"))
            if not isinstance(data, (dict, list)):
                raise RuntimeError(m.GENERIC_ERROR)
            return data

        def append(target, metadata, group):
            nonlocal truncated
            target = m.canonical_url(target, allow_short=False)
            if target in seen:
                return
            if len(entries) >= m.MAX_ENTRIES:
                truncated = True
                return
            seen.add(target)
            entry = m._entry(metadata, target, group)
            entry.update(resolution="pending", available=False, error=None,
                         qualities=[], codecs=[], has_subtitles=False)
            entries.append(entry)
            report()

        video_cache = {}

        def view(target):
            identity = urlsplit(target).path.rsplit("/", 1)[-1]
            if identity not in video_cache:
                data = api("x/web-interface/view", **({"bvid": identity} if identity.startswith("BV")
                                                      else {"aid": identity[2:]}))
                video_cache[identity] = data
                if re.fullmatch(m.BV, str(data.get("bvid"))):
                    video_cache[data["bvid"]] = data
            return video_cache[identity]

        def video(target, group="", data=None):
            nonlocal title, thumbnail
            data = data if data is not None else view(target)
            metadata = {"title": data.get("title"), "duration": data.get("duration"),
                        "thumbnail": data.get("pic")}
            if not title:
                title, thumbnail = metadata["title"], metadata["thumbnail"]
            pages = data.get("pages")
            if not isinstance(pages, list) or not pages:
                identity = urlsplit(target).path.rsplit("/", 1)[-1]
                pages = api("x/player/pagelist", **({"bvid": identity} if identity.startswith("BV")
                                                   else {"aid": identity[2:]}))
            if not isinstance(pages, list) or not pages:
                raise RuntimeError(m.UNAVAILABLE_ERROR)
            part = parse_qs(urlsplit(target).query).get("p", [None])[0]
            base = (f"https://www.bilibili.com/video/{data['bvid']}"
                    if re.fullmatch(m.BV, str(data.get("bvid"))) else target.split("?", 1)[0])
            selected = [p for p in pages if str(p.get("page")) == part] if part else pages
            if not selected:
                raise RuntimeError(m.UNAVAILABLE_ERROR)
            for page in selected:
                number = page.get("page")
                if not re.fullmatch(r"[1-9][0-9]*", str(number)):
                    raise RuntimeError(m.GENERIC_ERROR)
                page_url = base + (f"?p={number}" if part or len(pages) > 1 else "")
                append(page_url, {**metadata, "title": page.get("part") if len(pages) > 1 else metadata["title"],
                                  "duration": page.get("duration", metadata["duration"])},
                       group or (metadata["title"] if len(pages) > 1 else ""))
                if truncated:
                    break

        def listing(target):
            nonlocal title, thumbnail, truncated
            parsed = urlsplit(target)
            collection = "/collectiondetail" in parsed.path
            series = "/seriesdetail" in parsed.path
            if collection or series:
                mid = parsed.path.split("/")[1]
                sid = parse_qs(parsed.query)["sid"][0]
                if series:
                    meta = api("x/series/series", series_id=sid).get("meta") or {}
                    title = meta.get("name")
            else:
                fid = parsed.path.rsplit("ml", 1)[-1]
            visited = 0
            # Bounds apply even to duplicate/empty/malformed upstream pages.
            for pn in range(1, 35):
                if collection:
                    data = api("x/polymer/web-space/seasons_archives_list", mid=mid, season_id=sid,
                               page_num=pn, page_size=30)
                    meta = data.get("meta") or {}
                    title, thumbnail = meta.get("name") or title, meta.get("cover") or thumbnail
                    rows, size = data.get("archives") or [], 30
                    total = (data.get("page") or {}).get("total")
                elif series:
                    data = api("x/series/archives", mid=mid, series_id=sid, pn=pn, ps=30)
                    rows, size = data.get("archives") or [], 30
                    total = (data.get("page") or {}).get("total")
                else:
                    data = api("x/v3/fav/resource/list", media_id=fid, pn=pn, ps=20)
                    meta = data.get("info") or {}
                    title, thumbnail = meta.get("title") or title, meta.get("cover") or thumbnail
                    rows, size = data.get("medias") or [], 20
                    total = meta.get("media_count")
                report()
                for row in rows:
                    visited += 1
                    if len(entries) >= m.MAX_ENTRIES or visited > m.MAX_ENTRIES * 10:
                        truncated = True
                        return
                    bvid = row.get("bvid")
                    if not re.fullmatch(m.BV, str(bvid)):
                        logger.warning(m.UNAVAILABLE_ERROR)
                        continue
                    child = f"https://www.bilibili.com/video/{bvid}"
                    try:
                        video(child, m._text(title))
                    except Exception as error:
                        # Retain actual list metadata when a private/deleted item's view fails.
                        logger.warning(error)
                        append(child, {"title": row.get("title"), "duration": row.get("duration"),
                                       "thumbnail": row.get("pic") or row.get("cover")}, m._text(title))
                    if truncated:
                        return
                if (isinstance(total, int) and pn * size >= total) or data.get("has_more") is False:
                    return
                if not rows or (total is None and len(rows) < size):
                    if isinstance(total, int) and pn * size < total:
                        truncated = True
                    return
            truncated = True

        def safe_listing(target):
            nonlocal truncated
            try:
                listing(target)
            except Exception as error:
                if not entries:
                    raise
                truncated = True
                logger.warning(error)

        path = urlsplit(url).path
        if "/video/" in path:
            data = view(url)
            season = data.get("ugc_season") or {}
            sid = season.get("id") or data.get("season_id")
            if sid and "p" not in parse_qs(urlsplit(url).query):
                mid = season.get("mid") or (data.get("owner") or {}).get("mid")
                safe_listing(m.canonical_url(f"https://space.bilibili.com/{mid}/channel/collectiondetail?sid={sid}"))
            else:
                video(url, data=data)
        elif "/bangumi/" in path:
            identity = path.rsplit("/", 1)[-1]
            data = api("pgc/view/web/season", **({"ep_id": identity[2:]} if identity.startswith("ep")
                                                else {"season_id": identity[2:]}))
            title, thumbnail = data.get("title"), data.get("cover")
            episodes = data.get("episodes") or []
            if identity.startswith("ep"):
                episodes = [ep for ep in episodes if str(ep.get("id")) == identity[2:]]
            for ep in episodes:
                append(f"https://www.bilibili.com/bangumi/play/ep{ep['id']}",
                       {"title": ep.get("share_copy") or ep.get("long_title") or ep.get("title"),
                        "duration": m._number(ep.get("duration"), 0) / 1000,
                        "thumbnail": ep.get("cover")}, m._text(title))
                if truncated:
                    break
        else:
            safe_listing(url)
    if not entries:
        raise RuntimeError(m.UNAVAILABLE_ERROR)
    report(final=True)
    warnings = list(logger.warnings)
    if truncated:
        warnings.append("结果超过处理范围，仅显示前 100 个条目；请使用更具体的链接。")
    return {"title": m._text(title) or entries[0]["title"],
            "thumbnail": m._thumbnail(thumbnail) or entries[0]["thumbnail"],
            "entries": entries, "truncated": truncated, "warnings": warnings}
