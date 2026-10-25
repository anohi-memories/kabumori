"""監督付き自動起動の準備（TASK 13）: 別プロセスで共有する GitHub API の回数の台帳（候補・未結線）。

RateBudget（rate_budget.py）は1つのプロセスの中だけで正しい。S1（ランごと）・S2（見張り）・制御側（CLAIM・finalize）は
別プロセスなので、同じ認証の主体（GitHub の主な回数制限はユーザーごと）の使用量を、ファイルの台帳で共有する。

- 台帳はファイル1つ（JSON）。読み・判定・予約・書き込みを、排他の flock（`<台帳>.lock`）の下で一体に行う。
  ロックを打ち切り時間内に取れなければ送らない（RateLimited）。
- 台帳が壊れている・形が違う・数が非有限（NaN 等）なら、推測で直さずに送らない（fail-closed）。直すのは人。
- 判定は RateBudget と同じ（直近1時間の送信数、サーバの残り回数と Reset、Retry-After による待機）。自動の再試行はしない。
- 既定ではどこにも結線していない。結線（S1/S2・制御側が同じ台帳を使う）は、実通信の安全ゲートの後の別TASK。
"""
import os
import time

from .fsutil import FileLock, atomic_write_json, is_finite_number, read_json, touch
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


class SharedRateLedger:
    """別プロセスで共有する回数の台帳。インターフェースは RateBudget と同じ（before_request／observe／block）。"""

    def __init__(self, path, limit_per_hour, reserve_fraction=0.2, now=time.time, lock_timeout=LOCK_TIMEOUT):
        if not (isinstance(limit_per_hour, int) and not isinstance(limit_per_hour, bool) and limit_per_hour > 0):
            raise ValueError("limit_per_hour must be a positive int")
        if not (0 <= reserve_fraction < 1):
            raise ValueError("reserve_fraction must be in [0, 1)")
        self.path = path
        self.lock_path = path + ".lock"
        self.limit = limit_per_hour
        self.reserve = max(1, int(limit_per_hour * reserve_fraction))
        self.now = now
        self.lock_timeout = lock_timeout
        touch(self.lock_path)

    def _transaction(self, fn, now):
        with FileLock(self.lock_path, "ex", timeout=self.lock_timeout) as lock:
            if not lock.acquired:
                raise RateLimited("shared rate ledger is locked; not sending", None)
            try:
                state = read_json(self.path) if os.path.exists(self.path) else _empty()
            except ValueError:
                state = None
            if not _valid(state):
                raise RateLimited("shared rate ledger is corrupt; not sending (repair by a human)", None)
            result = fn(state, now)
            self._save(state)
            return result

    def _save(self, state):
        atomic_write_json(self.path, state)

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
