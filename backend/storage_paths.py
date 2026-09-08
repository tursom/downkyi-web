import os
import re
import tempfile
from pathlib import Path

from .errors import ServiceError


def check_task_overlap(directory: Path, tasks, fallback: Path):
    for task in tasks:
        if re.fullmatch(r"[a-f0-9]{32}", task["id"]):
            task_dir = Path(task.get("download_dir", str(fallback))) / task["id"]
            if directory.is_relative_to(task_dir):
                raise ServiceError(422, "不能将已有任务的目录或其子目录作为默认下载目录")


def validate_download_directory(value: str, config, tasks) -> Path:
    value = value.strip()
    if not value or any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise ServiceError(422, "下载目录不能为空或包含控制字符")
    directory = Path(value)
    if not directory.is_absolute() or ".." in directory.parts:
        raise ServiceError(422, "请输入服务器上的绝对目录路径，不能包含 ..")
    try:
        resolved = directory.resolve(strict=True)
        if directory != resolved or not resolved.is_dir():
            raise ServiceError(422, "下载路径必须是已存在的真实目录，不能使用文件或符号链接")
        protected = [Path(root) for root in ("/dev", "/proc", "/sys", "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/boot")]
        protected.extend([config.data_dir.resolve() / "runtime", config.data_dir.resolve() / "locks",
                          Path(__file__).resolve().parent, config.frontend_dir.resolve()])
        if resolved == Path("/") or resolved == config.data_dir.resolve() or any(resolved.is_relative_to(root) for root in protected):
            raise ServiceError(422, "不能使用系统目录、应用程序目录或私有数据目录保存下载文件")
        check_task_overlap(resolved, tasks, config.download_dir.resolve())
        # Probe actual filesystem permissions; access() alone misses read-only exports.
        with tempfile.NamedTemporaryFile(prefix=".downkyi-write-check-", dir=resolved) as probe:
            probe.write(b"downkyi")
            probe.flush()
            os.fsync(probe.fileno())
        return resolved
    except FileNotFoundError:
        raise ServiceError(422, "下载目录不存在，请先在服务器或 NAS 上创建目录并挂载") from None
    except (OSError, RuntimeError):
        raise ServiceError(422, "下载目录不可访问或不可写，请检查挂载、只读限制及运行用户的权限") from None
