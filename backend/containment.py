import fcntl
import os
from pathlib import Path

from .errors import ServiceError


def acquire_task_lock(data_dir: Path, task_id: str) -> int:
    directory = data_dir / "locks"
    directory.mkdir(exist_ok=True, mode=0o700)
    fd = os.open(directory / f"{task_id}.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        raise ServiceError(409, "旧下载进程仍在释放资源，请稍后重试") from None
    except BaseException:
        os.close(fd)
        raise
    return fd
