"""監督付き自動起動の準備（TASK 13・14）: 別プロセスで共有する GitHub API の回数の台帳（候補・未結線）。

RateBudget（rate_budget.py）は1つのプロセスの中だけで正しい。S1（ランごと）・S2（見張り）・制御側（CLAIM・finalize）は
別プロセスなので、同じ認証の主体（GitHub の主な回数制限はユーザーごと）の使用量を、ファイルの台帳で共有する。

- 台帳はファイル1つ（JSON）。読み・判定・予約・書き込みを、排他の flock（`<台帳>.lock`）の下で一体に行う。
  ロックを打ち切り時間内に取れなければ送らない（RateLimited）。
- 台帳が壊れている・形が違う・数が非有限（NaN 等）なら、推測で直さずに送らない（fail-closed）。直すのは人。
- 判定は RateBudget と同じ（直近1時間の送信数、サーバの残り回数と Reset、Retry-After による待機）。自動の再試行はしない。
- TASK 14（H2 R1）: 全員が**同じ安定したファイル**を使うことを、入口と使用の時点で確かめる。
  - 台帳のパスは正規の絶対パス（どこにもシンボリックリンクを含まない＝realpath と一致）。別名のパスで台帳を分裂させない。
  - 置き場所のフォルダは、自分が所有し、グループ・他人が書き込めないこと（他人が差し替えられない）。
  - 台帳とロックは、自分が所有する通常ファイル（シンボリックリンク・dangling・ディレクトリ等は不可）で、ハードリンクが無い（nlink=1）こと。
    開くときは O_NOFOLLOW で、開いた記述子の fstat で確かめる（lstat の後に通常の open をする TOCTOU を作らない）。
  - ロックは、作成時に記録した実体（dev・inode）と一致する記述子だけを使う。保存の直前に、ロックのパスがまだ同じ実体を
    指していることを確かめ、差し替えられていたら保存しない（予約は成功にしない）。
  - 同じユーザーの権限を持つ者がフォルダの中を書き換えることは防げない（信頼の範囲。専用ユーザーの分離は F0 の別ゲート）。
- 既定ではどこにも結線していない。結線（S1/S2・制御側が同じ台帳を使う）は、実通信の安全ゲートの後の別TASK。
"""
import errno
import fcntl
import json
import os
import stat
import threading
import time

from .fsutil import fsync_dir, is_finite_number, loads_strict
from .github_source import RateLimited

LOCK_TIMEOUT = 5.0


def _empty():
    return {"sent": [], "blocked_until": None, "server_remaining": None, "server_reset": None}


def _valid(state):
    if not isinstance(state, dict) or set(state) != set(_empty()):
        return False
    sent = state["sent"]
    if not isinstance(sent, list) or not all(is_finite_number(t) for t in sent):
        return False
    for key in ("blocked_until", "server_reset"):
        if state[key] is not None and not is_finite_number(state[key]):
            return False
    rem = state["server_remaining"]
    return rem is None or (isinstance(rem, int) and not isinstance(rem, bool) and rem >= 0)


def _check_dir(path):
    st = os.lstat(path)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o022:
        raise ValueError("ledger directory must be a real directory owned by this user and not writable by others")


def _check_file(st):
    """通常ファイル・自分の所有・グループ／他人が書けない・ハードリンクなし。"""
    return stat.S_ISREG(st.st_mode) and st.st_uid == os.getuid() and not st.st_mode & 0o022 and st.st_nlink == 1


class SharedRateLedger:
    """別プロセスで共有する回数の台帳。インターフェースは RateBudget と同じ（before_request／observe／block）。"""

    def __init__(self, path, limit_per_hour, reserve_fraction=0.2, now=time.time, lock_timeout=LOCK_TIMEOUT):
        if not (isinstance(limit_per_hour, int) and not isinstance(limit_per_hour, bool) and limit_per_hour > 0):
            raise ValueError("limit_per_hour must be a positive int")
        if not (0 <= reserve_fraction < 1):
            raise ValueError("reserve_fraction must be in [0, 1)")
        if not (isinstance(path, str) and os.path.isabs(path) and os.path.realpath(path) == path):
            raise ValueError("ledger path must be canonical (absolute, no symlinks anywhere)")
        _check_dir(os.path.dirname(path))
        self.path = path
        self.lock_path = path + ".lock"
        self.limit = limit_per_hour
        self.reserve = max(1, int(limit_per_hour * reserve_fraction))
        self.now = now
        self.lock_timeout = lock_timeout
        if os.path.lexists(path) and not _check_file(os.lstat(path)):
            raise ValueError("ledger file must be a regular file owned by this user (no symlink/hard link)")
        if not os.path.lexists(self.lock_path):
            try:
                os.close(os.open(self.lock_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600))
            except FileExistsError:
                pass  # 同時に作られた: 下で同じ規則を確かめる
        st = os.lstat(self.lock_path)
        if not _check_file(st):
            raise ValueError("ledger lock must be a regular file owned by this user (no symlink/hard link)")
        self._lock_id = (st.st_dev, st.st_ino)

    # --- ロック（作成時に記録した実体の記述子だけを使う） ---
    def _acquire(self):
        try:
            fd = os.open(self.lock_path, os.O_RDONLY | os.O_NOFOLLOW)
        except OSError:
            raise RateLimited("shared rate ledger lock is missing or replaced; not sending", None)
        try:
            st = os.fstat(fd)
            if not _check_file(st) or (st.st_dev, st.st_ino) != self._lock_id:
                raise RateLimited("shared rate ledger lock was replaced; not sending", None)
            deadline = time.monotonic() + self.lock_timeout
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    return fd
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise RateLimited("shared rate ledger is locked; not sending", None)
                    time.sleep(0.02)
        except BaseException:
            os.close(fd)
            raise

    def _lock_still_ours(self, fd):
        try:
            path_st = os.lstat(self.lock_path)
        except OSError:
            return False
        fd_st = os.fstat(fd)
        return (path_st.st_dev, path_st.st_ino) == (fd_st.st_dev, fd_st.st_ino) == self._lock_id

    def _read(self):
        try:
            fd = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW)
        except FileNotFoundError:
            return _empty()
        except OSError:
            return None  # シンボリックリンク等: 壊れている扱い
        try:
            if not _check_file(os.fstat(fd)):
                return None
            chunks = []
            while True:
                chunk = os.read(fd, 65536)
                if not chunk:
                    break
                chunks.append(chunk)
        finally:
            os.close(fd)
        try:
            return loads_strict(b"".join(chunks).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None

    def _save(self, state, lock_fd):
        """保存の直前に、ロックのパスがまだ同じ実体を指していることを確かめる（差し替えられていたら保存しない）。"""
        if not self._lock_still_ours(lock_fd):
            raise RateLimited("shared rate ledger lock was replaced during the transaction; not saving", None)
        tmp = "%s.tmp.%d.%d" % (self.path, os.getpid(), threading.get_ident())
        data = json.dumps(state, ensure_ascii=False, sort_keys=True, allow_nan=False).encode("utf-8")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        try:
            os.write(fd, data)
            os.fsync(fd)
        finally:
            os.close(fd)
        if not self._lock_still_ours(lock_fd):
            os.unlink(tmp)
            raise RateLimited("shared rate ledger lock was replaced during the transaction; not saving", None)
        os.replace(tmp, self.path)
        fsync_dir(os.path.dirname(self.path))

    def _transaction(self, fn, now):
        lock_fd = self._acquire()
        try:
            state = self._read()
            if not _valid(state):
                raise RateLimited("shared rate ledger is corrupt; not sending (repair by a human)", None)
            result = fn(state, now)
            self._save(state, lock_fd)
            return result
        finally:
            try:
                fcntl.flock(lock_fd, fcntl.LOCK_UN)
            finally:
                os.close(lock_fd)

    def before_request(self, now=None):
        return self._transaction(self._reserve, self.now() if now is None else now)

    def _reserve(self, state, now):
        state["sent"] = [t for t in state["sent"] if now - t < 3600.0]
        if state["blocked_until"] is not None and now < state["blocked_until"]:
            raise RateLimited("shared rate ledger: backing off", state["blocked_until"] - now)
        if len(state["sent"]) >= self.limit - self.reserve:
            raise RateLimited("shared rate ledger: hourly budget exhausted", 3600.0 - (now - state["sent"][0]))
        if state["server_remaining"] is not None and (state["server_reset"] is None or now < state["server_reset"]) \
                and state["server_remaining"] <= self.reserve:
            raise RateLimited("shared rate ledger: server remaining is at the reserve", None)
        state["sent"].append(now)

    def observe(self, headers, now=None):
        def update(state, now):
            remaining = str(headers.get("X-RateLimit-Remaining", "")).strip()
            reset = str(headers.get("X-RateLimit-Reset", "")).strip()
            if remaining.isdigit():
                state["server_remaining"] = int(remaining)
            if reset.isdigit():
                state["server_reset"] = float(reset)
            ra = str(headers.get("Retry-After", "")).strip()
            if ra.isdigit():
                self._apply_block(state, float(ra), now)
        return self._transaction(update, self.now() if now is None else now)

    def block(self, retry_after, now=None):
        return self._transaction(lambda state, now: self._apply_block(state, retry_after, now),
                                 self.now() if now is None else now)

    @staticmethod
    def _apply_block(state, retry_after, now):
        wait = retry_after if is_finite_number(retry_after) and retry_after > 0 else 60.0
        until = now + wait
        if state["blocked_until"] is None or until > state["blocked_until"]:
            state["blocked_until"] = until
