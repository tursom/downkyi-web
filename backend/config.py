import os
import secrets
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Config:
    data_dir: Path
    download_dir: Path
    token: str
    secure_cookie: bool = False
    frontend_dir: Path = Path(__file__).resolve().parents[1] / "frontend" / "dist"
    auth_mode: str = "token"

    @classmethod
    def from_env(cls):
        auth_mode = os.environ.get("DOWNKYI_AUTH_MODE", "token").strip().lower()
        if auth_mode not in {"token", "none"}:
            raise ValueError("DOWNKYI_AUTH_MODE must be token or none")
        data = Path(os.environ.get("DOWNKYI_DATA_DIR", "./data")).resolve()
        downloads = Path(os.environ.get("DOWNKYI_DOWNLOAD_DIR", str(data / "downloads"))).resolve()
        data.mkdir(parents=True, exist_ok=True, mode=0o700)
        token = os.environ.get("DOWNKYI_ADMIN_TOKEN", "").strip() if auth_mode == "token" else ""
        if auth_mode == "token" and not token:
            token_file = data / "admin-token"
            try:
                with open(token_file, "x", opener=lambda p, f: os.open(p, f, 0o600)) as f:
                    f.write(secrets.token_urlsafe(32))
            except FileExistsError:
                pass
            token = token_file.read_text().strip()
        if auth_mode == "token" and len(token) < 16:
            raise ValueError("DOWNKYI_ADMIN_TOKEN must contain at least 16 characters")
        return cls(data, downloads, token, os.environ.get("DOWNKYI_SECURE_COOKIE") == "1", auth_mode=auth_mode)

    def prepare(self):
        self.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        (self.data_dir / "runtime").mkdir(exist_ok=True, mode=0o700)
