"""NDJSON transport. StreamingResponse is the sole ASGI receive consumer."""
import asyncio
import json

import anyio
from starlette.responses import StreamingResponse

HEARTBEAT_SECONDS = 15


def wants_progress(request):
    for item in request.headers.get("accept", "").lower().split(","):
        media_type, *parameters = item.strip().split(";")
        if media_type.strip() == "application/x-ndjson":
            try:
                quality = next((float(p.strip()[2:]) for p in parameters
                                if p.strip().startswith("q=")), 1)
            except ValueError:
                continue
            if quality > 0:
                return True
    return False


class ParseResponse(StreamingResponse):
    def __init__(self, job, queue, cleanup, public_error):
        self.cleanup = cleanup

        async def events():
            waiting = None
            try:
                while True:
                    waiting = asyncio.create_task(queue.get())
                    done, _ = await asyncio.wait({waiting, job}, timeout=HEARTBEAT_SECONDS,
                                                 return_when=asyncio.FIRST_COMPLETED)
                    if waiting in done:
                        event = {"event": "progress", "progress": waiting.result()}
                    elif job in done:
                        waiting.cancel()
                        await asyncio.gather(waiting, return_exceptions=True)
                        # Progress queued before completion must precede the terminal.
                        if not queue.empty():
                            continue
                        try:
                            event = {"event": "parsed", "result": job.result()}
                        except asyncio.CancelledError:
                            event = {"event": "error", "message": "解析已取消，请重试", "status": 503}
                        except Exception as exc:
                            error = public_error(exc)
                            event = {"event": "error", "message": error.message, "status": error.status}
                        yield json.dumps(event, ensure_ascii=False, allow_nan=False) + "\n"
                        return
                    else:
                        waiting.cancel()
                        await asyncio.gather(waiting, return_exceptions=True)
                        event = {"event": "heartbeat"}
                    yield json.dumps(event, ensure_ascii=False, allow_nan=False) + "\n"
            finally:
                if waiting:
                    waiting.cancel()
                    with anyio.CancelScope(shield=True):
                        await asyncio.gather(waiting, return_exceptions=True)

        super().__init__(events(), media_type="application/x-ndjson",
                         headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})

    async def __call__(self, scope, receive, send):
        try:
            # Use Starlette's disconnect listener even on ASGI 2.4 servers: a
            # quiet extractor must be cancelled before its next output/heartbeat.
            scope = {**scope, "asgi": {**scope.get("asgi", {}), "spec_version": "2.3"}}
            await super().__call__(scope, receive, send)
        finally:
            with anyio.CancelScope(shield=True):
                await self.body_iterator.aclose()
                await self.cleanup()
