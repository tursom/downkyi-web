import json
import sqlite3
import threading
import time
from datetime import datetime, timezone
from pathlib import Path


def now_iso():
    return datetime.now(timezone.utc).isoformat()


class Store:
    """SQLite owns durable queue state; workers never own the only task copy."""

    def __init__(self, path: Path):
        self.lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS tasks (
                id TEXT PRIMARY KEY, status TEXT NOT NULL,
                record_removed INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL, payload TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS task_queue ON tasks(status, record_removed, created_at);
            CREATE TABLE IF NOT EXISTS parses (
                id TEXT PRIMARY KEY, expires REAL NOT NULL, payload TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        """)
        self.db.commit()

    def close(self):
        with self.lock:
            self.db.close()

    def all_tasks(self):
        with self.lock:
            return [json.loads(row[0]) for row in self.db.execute(
                "SELECT payload FROM tasks ORDER BY created_at DESC, id DESC"
            )]

    def get(self, task_id):
        with self.lock:
            row = self.db.execute("SELECT payload FROM tasks WHERE id=?", (task_id,)).fetchone()
            return json.loads(row[0]) if row else None

    def insert_many(self, tasks):
        with self.lock, self.db:
            self.db.executemany(
                "INSERT INTO tasks(id,status,record_removed,created_at,payload) VALUES(?,?,?,?,?)",
                [(t["id"], t["status"], int(t["record_removed"]), t["created_at"], json.dumps(t)) for t in tasks],
            )

    def update(self, task_id, **changes):
        with self.lock, self.db:
            task = self.get(task_id)
            if task is None:
                raise KeyError(task_id)
            task.update(changes)
            task["updated_at"] = now_iso()
            self.db.execute(
                "UPDATE tasks SET status=?,record_removed=?,payload=? WHERE id=?",
                (task["status"], int(task["record_removed"]), json.dumps(task), task_id),
            )
            return task

    def pin_download_directories(self, default_directory):
        with self.lock, self.db:
            legacy = self.setting("legacy_download_dir", self.setting("download_dir", str(default_directory)))
            self.db.execute("INSERT OR IGNORE INTO settings VALUES(?,?)", ("legacy_download_dir", json.dumps(legacy)))
            for task in self.all_tasks():
                if "download_dir" not in task:
                    task["download_dir"] = legacy
                    self.db.execute("UPDATE tasks SET payload=? WHERE id=?", (json.dumps(task), task["id"]))

    def recover(self):
        with self.lock:
            for task in self.all_tasks():
                if task["status"] in {"resolving", "downloading", "merging"}:
                    self.update(task["id"], status="paused" if task["record_removed"] else "queued", speed=None, eta=None)

    def save_parse(self, parse_id, payload):
        with self.lock, self.db:
            self.db.execute("DELETE FROM parses WHERE expires < ?", (time.time(),))
            self.db.execute("INSERT INTO parses VALUES(?,?,?)", (parse_id, time.time() + 3600, json.dumps(payload)))
            self.db.execute("DELETE FROM parses WHERE id NOT IN (SELECT id FROM parses ORDER BY expires DESC LIMIT 50)")

    def get_parse(self, parse_id):
        with self.lock:
            row = self.db.execute("SELECT payload FROM parses WHERE id=? AND expires>?", (parse_id, time.time())).fetchone()
            return json.loads(row[0]) if row else None

    def setting(self, key, default=None):
        with self.lock:
            row = self.db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
            return json.loads(row[0]) if row else default

    def set_setting(self, key, value):
        self.set_settings({key: value})

    def set_settings(self, changes):
        with self.lock, self.db:
            self.db.executemany("INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [(key, json.dumps(value)) for key, value in changes.items()])
