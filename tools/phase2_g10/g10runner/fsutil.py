"""ファイル操作の共通部品（原子的な書き込み・fsync・flock・正規化JSON）。"""
import fcntl
import hashlib
import json
import os
import time


def canonical(obj):
    """署名・ハッシュ用の正規化JSON（キー順・区切り固定・UTF-8）。"""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def sha256_hex(data):
    if isinstance(data, str):
        data = data.encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def fsync_dir(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_write_bytes(path, data):
    tmp = "%s.tmp.%d" % (path, os.getpid())
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
    fsync_dir(os.path.dirname(path) or ".")


def atomic_write_json(path, obj):
    atomic_write_bytes(path, json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=True).encode("utf-8") + b"\n")


def read_json(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def touch(path):
    """存在しなければ空ファイルを作る（ロック用ファイルなど）。"""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT, 0o644)
    os.close(fd)


class FileLock:
    """flock による共有／排他ロック。

    - ファイルは読み取り専用で開く（読み取り権限だけで共有・排他のどちらも取れる）。
    - 記述子は close-on-exec（Python の既定。子プロセスへ継承しない）。
    - timeout=None は取得できるまで待つ（打ち切らない）。abort_check() が True を返したら中止。
    """

    def __init__(self, path, mode, timeout=None, poll=0.02, abort_check=None):
        if mode not in ("sh", "ex"):
            raise ValueError("mode must be sh or ex")
        self.path = path
        self.mode = mode
        self.timeout = timeout
        self.poll = poll
        self.abort_check = abort_check
        self.fd = None
        self.acquired = False

    def __enter__(self):
        self.fd = os.open(self.path, os.O_RDONLY)
        op = (fcntl.LOCK_SH if self.mode == "sh" else fcntl.LOCK_EX) | fcntl.LOCK_NB
        deadline = None if self.timeout is None else time.monotonic() + self.timeout
        while True:
            try:
                fcntl.flock(self.fd, op)
                self.acquired = True
                return self
            except BlockingIOError:
                if self.abort_check is not None and self.abort_check():
                    return self
                if deadline is not None and time.monotonic() >= deadline:
                    return self
                time.sleep(self.poll)

    def __exit__(self, *exc):
        if self.fd is not None:
            try:
                if self.acquired:
                    fcntl.flock(self.fd, fcntl.LOCK_UN)
            finally:
                os.close(self.fd)
                self.fd = None
        return False
