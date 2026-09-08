import os

import uvicorn


if __name__ == "__main__":
    uvicorn.run(
        "backend.app:create_app",
        factory=True,
        host=os.environ.get("DOWNKYI_HOST", "127.0.0.1"),
        port=int(os.environ.get("DOWNKYI_PORT", "8511")),
        workers=1,
        proxy_headers=False,
        timeout_graceful_shutdown=15,
    )
