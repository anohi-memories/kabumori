"""ゲート1追加（TASK 11）: GitHub API の回数の予算（事前の見積もりと、実行時の歯止め）。スケジューラには結線しない。

GitHub の回数制限（公開資料の値。実機では認証なしの 60回／時だけを確認済み。他は NOT_VERIFIED）:
- 認証なしの REST: 1時間に60回（IP ごと）。条件付き取得の 304 も数えられる。
- 認証ありの REST: 1時間に5000回（token ごと）。認証ありの 304 は主な回数制限に数えられない。
- GraphQL: 1時間に5000点（token ごと）。この問い合わせの点数は 1点の見込み（安全のため2点で見積もる）。
- 二次制限（短時間の集中）: 429／403 と Retry-After。自動の再試行はせず、その時刻まで送らない。

最悪の見積もり（1時間あたり、同時実行数ぶん）:
  S1 の監督 3600/issue_monitor_interval ＋ S2 の予備（S1 が止まっていれば毎周期）3600/watchdog_interval
  ＋ 1ランごとの固定（CLAIM・起動直前・finalize の3回）× 1時間の最大起動数（rate_guard から）
"""
import threading
import time

from . import policy as policy_mod
from .github_source import RateLimited

LIMITS = {"anonymous": 60, "token": 5000}
GRAPHQL_POINTS_PER_QUERY = 2  # 見込み1点を、安全のため2点で数える
FIXED_FETCHES_PER_RUN = 3     # CLAIM・起動直前（spawn）・finalize（postflight）
DEFAULT_SAFETY = 0.5          # 上限の半分までに抑える（他の利用・誤差の余裕）


def worst_case(policy, mode, watchdog_interval, api="rest"):
    """1時間あたりの最悪の消費（REST は回数、GraphQL は点数）と内訳を返す。"""
    if mode not in LIMITS:
        raise ValueError("unknown auth mode")
    if api not in ("rest", "graphql"):
        raise ValueError("unknown api")
    if not (isinstance(watchdog_interval, (int, float)) and not isinstance(watchdog_interval, bool)
            and watchdog_interval > 0):
        raise ValueError("watchdog_interval must be a positive number")
    interval = policy_mod.timing(policy, "issue_monitor_interval")
    concurrent = int(policy["max_concurrent"])
    guard = policy["rate_guard"]
    starts_per_hour = float(guard["max_starts"]) * 3600.0 / float(guard["window_seconds"])
    s1 = 3600.0 / interval
    s2 = 3600.0 / float(watchdog_interval)
    fixed = FIXED_FETCHES_PER_RUN * starts_per_hour
    fetches = concurrent * (s1 + s2) + fixed
    cost = GRAPHQL_POINTS_PER_QUERY if api == "graphql" else 1
    return {"mode": mode, "api": api, "s1_per_hour": concurrent * s1, "s2_per_hour": concurrent * s2,
            "fixed_per_hour": fixed, "fetches_per_hour": fetches, "consumed_per_hour": fetches * cost,
            "limit_per_hour": LIMITS[mode]}


def check(policy, mode, watchdog_interval, api="rest", safety=DEFAULT_SAFETY):
    """見積もりが上限×safety を超えるなら理由（文字列）、収まるなら None。"""
    w = worst_case(policy, mode, watchdog_interval, api)
    allowed = w["limit_per_hour"] * safety
    if w["consumed_per_hour"] > allowed:
        return ("github api budget exceeded: worst case %.0f/h > %.0f/h (%s %s, limit %d/h x %.2f)"
                % (w["consumed_per_hour"], allowed, w["mode"], w["api"], w["limit_per_hour"], safety))
    return None


def min_monitor_interval(policy, mode, watchdog_interval, api="rest", safety=DEFAULT_SAFETY):
    """予算に収まる最小の監督間隔（秒）。どんな間隔でも収まらなければ None。"""
    concurrent = int(policy["max_concurrent"])
    guard = policy["rate_guard"]
    fixed = FIXED_FETCHES_PER_RUN * float(guard["max_starts"]) * 3600.0 / float(guard["window_seconds"])
    cost = GRAPHQL_POINTS_PER_QUERY if api == "graphql" else 1
    room = LIMITS[mode] * safety / cost - fixed - concurrent * 3600.0 / float(watchdog_interval)
    if room <= 0:
        return None
    return concurrent * 3600.0 / room


PHASE1_WATCH_INTERVAL = 120.0  # Phase 1 の監視（gh の GraphQL）: 2分ごと


def principal_check(consumers, mode, api="graphql", safety=DEFAULT_SAFETY):
    """同じ認証の主体（GitHub の主な回数制限はユーザーごと）を使う利用者の合計で、予算を確かめる（TASK 13）。

    consumers: [(名前, 1時間あたりの消費)]。Phase 1 の監視（同じユーザーの gh）と G10 の取得係が同じユーザーなら、
    両方を入れる。合計が上限×safety を超えるなら理由（文字列）、収まるなら None。"""
    if mode not in LIMITS:
        raise ValueError("unknown auth mode")
    total = 0.0
    for name, per_hour in consumers:
        if not (isinstance(per_hour, (int, float)) and not isinstance(per_hour, bool) and per_hour >= 0):
            raise ValueError("consumer usage must be a non-negative number: %s" % name)
        total += per_hour
    allowed = LIMITS[mode] * safety
    if total > allowed:
        names = ", ".join("%s %.0f" % (n, u) for n, u in consumers)
        return "shared principal budget exceeded: %.0f/h > %.0f/h (%s)" % (total, allowed, names)
    return None


def phase1_watch_per_hour(interval=PHASE1_WATCH_INTERVAL, points_per_query=1):
    return 3600.0 / interval * points_per_query


class RateBudget:
    """実行時の歯止め: 直近1時間の送信数・サーバの残り回数・Retry-After を見て、超えそうなら送らない（RateLimited）。

    TASK 12（H2 R2）: 同じ予算を複数のスレッドが共有しても、古い記録の切り捨て・判定・枠の予約（記録）、および
    observe／block は、1つのロックの下で一体に行う（残り1枠を2つの呼び出しが同時に取ることはない）。
    別のプロセス（S1 と S2 が別プロセスの場合など）での共有は対象外（共有の台帳は、結線のときの別設計）。"""

    def __init__(self, limit_per_hour, reserve_fraction=0.2, now=time.time):
        if not (isinstance(limit_per_hour, int) and not isinstance(limit_per_hour, bool) and limit_per_hour > 0):
            raise ValueError("limit_per_hour must be a positive int")
        if not (0 <= reserve_fraction < 1):
            raise ValueError("reserve_fraction must be in [0, 1)")
        self.limit = limit_per_hour
        self.reserve = max(1, int(limit_per_hour * reserve_fraction))
        self.now = now
        self.sent = []
        self.server_remaining = None
        self.server_reset = None
        self.blocked_until = None
        self._lock = threading.RLock()  # observe の中から block を呼ぶので再入可能

    def _prune(self, now):
        self.sent = [t for t in self.sent if now - t < 3600.0]

    def before_request(self, now=None):
        now = self.now() if now is None else now
        with self._lock:
            self._reserve(now)

    def _reserve(self, now):
        self._prune(now)
        if self.blocked_until is not None and now < self.blocked_until:
            raise RateLimited("rate budget: backing off", self.blocked_until - now)
        if len(self.sent) >= self.limit - self.reserve:
            raise RateLimited("rate budget: local hourly budget exhausted", 3600.0 - (now - self.sent[0]))
        if self.server_remaining is not None and (self.server_reset is None or now < self.server_reset) \
                and self.server_remaining <= self.reserve:
            raise RateLimited("rate budget: server remaining is at the reserve",
                              None if self.server_reset is None else self.server_reset - now)
        self.sent.append(now)

    def observe(self, headers, now=None):
        now = self.now() if now is None else now
        with self._lock:
            self._observe(headers, now)

    def _observe(self, headers, now):
        remaining = str(headers.get("X-RateLimit-Remaining", "")).strip()
        reset = str(headers.get("X-RateLimit-Reset", "")).strip()
        if remaining.isdigit():
            self.server_remaining = int(remaining)
        if reset.isdigit():
            self.server_reset = float(reset)
        ra = str(headers.get("Retry-After", "")).strip()
        if ra.isdigit():
            self._block(float(ra), now)

    def block(self, retry_after, now=None):
        now = self.now() if now is None else now
        with self._lock:
            self._block(retry_after, now)

    def _block(self, retry_after, now):
        wait = retry_after if isinstance(retry_after, (int, float)) and retry_after > 0 else 60.0
        until = now + wait
        if self.blocked_until is None or until > self.blocked_until:
            self.blocked_until = until
