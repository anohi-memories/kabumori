"""監督付き自動起動の結線（TASK 15・オフラインのみ・偽Claude のときだけ）。

ルートに wiring.json（自分が所有し、グループ・他人が書けない通常ファイル）があるときだけ、次の部品を起動経路に
つなぐ。無ければ従来どおり（試験用 HMAC 鍵・模擬 Issue ファイル）で、動作は変わらない。偽Claude 以外の
アダプタでは取得係を作らない（起動しない）。

1. 署名の段階的切替（mode）。hmac → dual → ecdsa の順に1段ずつだけ進める（mode_transition_allowed）。
   - hmac: 従来の試験用 HMAC だけ。
   - dual: 署名は ECDSA。検証は ECDSA と HMAC の両方を受け付ける（切替期間に、古い HMAC の記録を検証するため）。
   - ecdsa: ECDSA だけ。HMAC の署名は、鍵が漏れていても受け付けない。HMAC の鍵ファイル（test_keys.json）が
     ルートに残っていたら組み立てを拒否する（その中の runner・human の鍵で署名を作れてしまうため）。
     古い HMAC の記録が残る記録簿は検証に失敗し、実行側は止まる（fail-closed。ecdsa へ進む前に記録簿を新しくする）。
   - 実行側（スタブ・S1・S2・受理）が持てるのは、agent の秘密鍵と、4つの役割の公開鍵だけ。runner・human の
     秘密鍵の場所は設定できない（設定の規則で拒否）。witness の秘密鍵は、偽Claude の試験で実行側の中に取得係を
     作るときだけ。実運用の取得係は別のプロセス・別のユーザーで動かす（NOT_VERIFIED）。
   - 証拠の目的（purpose）・nonce・有効時間・本文の一致は、署名方式に関係なく issue.check_evidence が検証する。
2. Issue #323 の取得元: file（従来の模擬）または graphql_fixture（GitHubGraphQLIssueSource を、ネットワークに
   触れない FixtureOpener で動かす。token は形だけの FIXTURE_TOKEN で、どこにも送られない）。
3. 共有の回数台帳（SharedRateLedger）: 取得の前に予約する。上限は、同じ認証の主体の予算（Phase 1 の監視を含む）
   から計算した許容量（ledger_allowance）以下でなければ組み立てを拒否する。予約できなければ取得しない。

実 GitHub への接続・実鍵の設置・専用ユーザー・launchd は、ここでは扱わない（別承認）。
"""
import email.utils
import hashlib
import json
import os
import stat
import threading
import time
import urllib.error

from . import ecdsa_signing as ec, github_graphql as gq, github_source as gh, issue as issue_mod
from . import policy as policy_mod, rate_budget as rb, signing
from .fsutil import atomic_write_json, loads_strict, read_json
from .shared_ledger import SharedRateLedger

WIRING_FILE = "wiring.json"
VERSION = "wiring-v1"
SIG_MODES = ("hmac", "dual", "ecdsa")
EXECUTION_SIDE_PRIVATE_ROLES = ("agent", "witness")
SOURCE_KINDS = ("file", "graphql_fixture")
FIXTURE_TOKEN = "ghp_" + "0" * 36  # fixture 専用の形だけの値（実在しない。FixtureOpener の外へは出ない）
MAX_WIRING_BYTES = 65536
_TOP_KEYS = {"version", "mode", "public_keys", "private_keys", "issue_source", "ledger"}
_LEDGER_KEYS = {"path", "limit_per_hour", "reserve_fraction", "watchdog_interval"}


class WiringError(ValueError):
    pass


def mode_transition_allowed(old, new):
    """署名方式の切替は、同じか、1段先（hmac→dual→ecdsa）だけ。飛ばす・戻すは不可（戻すのは人の別判断）。"""
    if old not in SIG_MODES or new not in SIG_MODES:
        return False
    return SIG_MODES.index(new) - SIG_MODES.index(old) in (0, 1)


class MigratingVerifier:
    """署名方式に応じて検証する。署名の接頭辞で方式を見分け、その方式が今の mode で有効なときだけ検証する。"""

    def __init__(self, mode, hmac_verifier=None, ecdsa_verifier=None):
        if mode not in SIG_MODES:
            raise WiringError("unknown signature mode")
        if (mode in ("hmac", "dual")) != (hmac_verifier is not None) or \
                (mode in ("dual", "ecdsa")) != (ecdsa_verifier is not None):
            raise WiringError("verifiers do not match the signature mode")
        self.mode = mode
        self._hmac = hmac_verifier
        self._ecdsa = ecdsa_verifier
        self._ok = set()  # 検証に成功した (役割, データの SHA-256, 署名)。鍵は固定なので結果は変わらない
        self._lock = threading.Lock()

    def verify(self, role, data, sig):
        if not isinstance(sig, str):
            return False
        if sig.startswith("hmac-sha256:"):
            return self._hmac is not None and self._hmac.verify(role, data, sig)
        if not sig.startswith(ec.PREFIX) or self._ecdsa is None:
            return False
        key = (role, hashlib.sha256(data).hexdigest(), sig)
        with self._lock:
            if key in self._ok:
                return True
        ok = self._ecdsa.verify(role, data, sig)
        if ok:
            with self._lock:
                if len(self._ok) > 4096:
                    self._ok.clear()
                self._ok.add(key)
        return ok


# --- 設定（wiring.json） ---
def _read_owned_json(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return None
    except OSError:
        raise WiringError("wiring file cannot be opened without following symlinks")
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_uid != os.getuid() or st.st_mode & 0o022:
            raise WiringError("wiring file must be a regular file owned by this user and not writable by others")
        data = os.read(fd, MAX_WIRING_BYTES + 1)
    finally:
        os.close(fd)
    if len(data) > MAX_WIRING_BYTES:
        raise WiringError("wiring file too large")
    try:
        return loads_strict(data.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise WiringError("wiring file is not valid JSON")


def _abs(p):
    return isinstance(p, str) and os.path.isabs(p)


def validate(doc):
    """設定の規則。違反は WiringError。"""
    if not isinstance(doc, dict) or set(doc) != _TOP_KEYS or doc["version"] != VERSION:
        raise WiringError("wiring keys must be exactly %s (version %s)" % (sorted(_TOP_KEYS), VERSION))
    mode, pub, priv = doc["mode"], doc["public_keys"], doc["private_keys"]
    if mode not in SIG_MODES:
        raise WiringError("unknown signature mode")
    if not isinstance(pub, dict) or not isinstance(priv, dict):
        raise WiringError("key maps must be objects")
    if mode == "hmac":
        if pub or priv:
            raise WiringError("hmac mode takes no key paths")
    else:
        if set(pub) != set(signing.ROLES):
            raise WiringError("public keys for every role are required")
        if not set(priv) <= set(EXECUTION_SIDE_PRIVATE_ROLES) or "agent" not in priv:
            raise WiringError("only the agent (and the fake-mode witness) private keys may be configured "
                              "on the execution side")
        paths = list(pub.values()) + list(priv.values())
        if not all(_abs(p) for p in paths):
            raise WiringError("key paths must be absolute")
        if set(pub.values()) & set(priv.values()):
            raise WiringError("a private key path is also a public key path")
    src = doc["issue_source"]
    if not isinstance(src, dict) or src.get("kind") not in SOURCE_KINDS:
        raise WiringError("unknown issue source")
    if src["kind"] == "file" and set(src) != {"kind"}:
        raise WiringError("file issue source takes no options")
    if src["kind"] == "graphql_fixture" and (set(src) != {"kind", "fixture"} or not _abs(src["fixture"])):
        raise WiringError("graphql_fixture needs an absolute fixture path")
    led = doc["ledger"]
    if led is not None:
        if not isinstance(led, dict) or set(led) != _LEDGER_KEYS or not _abs(led["path"]):
            raise WiringError("ledger keys must be exactly %s with an absolute path" % sorted(_LEDGER_KEYS))
        limit, frac, wd = led["limit_per_hour"], led["reserve_fraction"], led["watchdog_interval"]
        if not (isinstance(limit, int) and not isinstance(limit, bool) and limit > 0):
            raise WiringError("ledger limit must be a positive int")
        if not (isinstance(frac, (int, float)) and not isinstance(frac, bool) and 0 <= frac < 1):
            raise WiringError("ledger reserve_fraction must be in [0, 1)")
        if not (isinstance(wd, (int, float)) and not isinstance(wd, bool) and wd > 0):
            raise WiringError("ledger watchdog_interval must be positive")
    return doc


def load(root):
    """wiring.json を読む。無ければ None（従来の経路）。あって規則に合わなければ WiringError。"""
    doc = _read_owned_json(os.path.join(root, WIRING_FILE))
    return None if doc is None else validate(doc)


def write(root, doc):
    """試験・dry-run 用: 規則を確かめてから 0600 で書く。"""
    validate(doc)
    path = os.path.join(root, WIRING_FILE)
    atomic_write_json(path, doc)
    os.chmod(path, 0o600)


# --- 署名器・検証器 ---
def _hmac_keys(root, cfg):
    if cfg["mode"] == "ecdsa":
        if os.path.lexists(os.path.join(root, signing.TEST_KEYS_FILE)):
            raise WiringError("ecdsa mode: the HMAC test key file must be removed "
                              "(it can forge runner/human signatures)")
        return None
    return signing.load_test_keys(root)


def verifier(root, cfg):
    keys = _hmac_keys(root, cfg)
    hmac_v = signing.HmacTestVerifier(keys) if keys is not None else None
    ecdsa_v = ec.EcdsaVerifier(cfg["public_keys"]) if cfg["mode"] != "hmac" else None
    return MigratingVerifier(cfg["mode"], hmac_v, ecdsa_v)


def signer(root, cfg, role):
    """実行側の署名器（agent、または偽Claude の試験の witness）。runner・human では作れない。"""
    if role not in EXECUTION_SIDE_PRIVATE_ROLES:
        raise WiringError("the execution side cannot sign as " + role)
    if cfg["mode"] == "hmac":
        return signing.HmacTestSigner({role: signing.load_test_keys(root)[role]})
    _hmac_keys(root, cfg)  # ecdsa で HMAC の鍵ファイルが残っていれば、どの組み立ても拒否する
    path = cfg["private_keys"].get(role)
    if path is None:
        raise WiringError("no %s private key configured" % role)
    return ec.EcdsaSigner({role: path})


def agent_side(root):
    """実行側のプロセス（スタブ・S1・S2）が使う署名器（agent のみ）と検証器。wiring.json が無ければ従来どおり。"""
    cfg = load(root)
    if cfg is None:
        return signing.agent_side(root)
    return signer(root, cfg, "agent"), verifier(root, cfg)


# --- 回数台帳 ---
def ledger_allowance(policy, watchdog_interval, phase1_per_hour=None, safety=rb.DEFAULT_SAFETY):
    """同じ認証の主体（token のユーザー）の予算から、G10 の台帳に許す1時間あたりの GraphQL 取得回数。

    Phase 1 の監視と G10 の最悪の見積もりの合計が予算に収まらなければ WiringError（その設定では動かさない）。"""
    p1 = rb.phase1_watch_per_hour() if phase1_per_hour is None else phase1_per_hour
    worst = rb.worst_case(policy, "token", watchdog_interval, api="graphql")["consumed_per_hour"]
    reason = rb.principal_check([("phase1 watch", p1), ("g10 worst case", worst)], "token", "graphql", safety)
    if reason:
        raise WiringError(reason)
    return int((rb.LIMITS["token"] * safety - p1) // rb.GRAPHQL_POINTS_PER_QUERY)


def ledger(cfg, policy):
    led = cfg["ledger"]
    if led is None:
        return None
    allowance = ledger_allowance(policy, led["watchdog_interval"])
    if led["limit_per_hour"] > allowance:
        raise WiringError("ledger limit %d/h exceeds the shared principal allowance %d/h"
                          % (led["limit_per_hour"], allowance))
    return SharedRateLedger(led["path"], led["limit_per_hour"], led["reserve_fraction"])


class BudgetedSource:
    """取得の前に台帳で予約する（予約できなければ RateLimited で取得しない）。"""

    def __init__(self, source, budget):
        self.source, self.budget = source, budget

    def fetch(self, timeout=None):
        self.budget.before_request()
        return self.source.fetch(timeout=timeout)


# --- GraphQL の fixture（ネットワークに触れない） ---
class _FixtureResponse:
    def __init__(self, raw, headers, url):
        self.status, self.headers, self._raw, self._url = 200, headers, raw, url

    def read(self, n=-1):
        return self._raw

    def geturl(self):
        return self._url

    def close(self):
        pass


class FixtureOpener:
    """GitHubGraphQLIssueSource の opener の代わり。ファイルの内容を GitHub の応答の形で返す（偽Claude の試験専用）。

    受け付けるのは FIXTURE_TOKEN の付いた、/rate_limit の GET と固定の GraphQL 問い合わせの POST だけ。
    ネットワークには一切触れない（urllib の送信を呼ばない）。"""

    def __init__(self, path):
        self.path = path

    def __call__(self, req, timeout):
        if req.get_header("Authorization") != "Bearer " + FIXTURE_TOKEN:
            raise issue_mod.IssueSourceError("fixture opener accepts only the fixture token")
        doc = read_json(self.path) or {}
        delay = float(doc.get("delay") or 0)
        if delay:
            if delay > timeout:
                time.sleep(timeout)
                raise issue_mod.IssueSourceError("fixture fetch timed out")
            time.sleep(delay)
        if doc.get("fail"):
            raise issue_mod.IssueSourceError(str(doc["fail"]))
        url, method = req.full_url, req.get_method()
        if doc.get("rate_limited") and url == gq.GRAPHQL_URL:
            raise urllib.error.HTTPError(url, 429, "rate limited", {"Retry-After": "60"}, None)
        if url == gh.RATE_LIMIT_URL and method == "GET":
            body = {"resources": {"core": {"limit": 5000, "remaining": 4999},
                                  "graphql": {"limit": 5000, "remaining": 5000}}}
        elif url == gq.GRAPHQL_URL and method == "POST" and req.data == gq.FIXED_PAYLOAD and "issue" in doc:
            body = {"data": {"repository": {"nameWithOwner": doc.get("repo", issue_mod.REPO), "issue": doc["issue"]}}}
        else:
            raise issue_mod.IssueSourceError("fixture opener: unexpected request")
        raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
        now = time.time()
        headers = {"Date": email.utils.formatdate(now, usegmt=True), "X-RateLimit-Limit": "5000",
                   "X-RateLimit-Remaining": str(doc.get("remaining", 4999)),
                   "X-RateLimit-Reset": str(int(now + 3600)), "X-OAuth-Scopes": "", "Content-Length": str(len(raw))}
        return _FixtureResponse(raw, headers, url)


def _iso(ts):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))


class GraphQLFixtureFile:
    """FixtureOpener が読むファイルを書く（FileIssueSource.publish と同じ呼び方）。試験専用。"""

    def __init__(self, path):
        self.path = path

    def _read(self):
        return read_json(self.path) or {}

    def _set(self, key, value):
        doc = self._read()
        doc[key] = value
        atomic_write_json(self.path, doc)

    def publish(self, body, state="OPEN", author=issue_mod.TRUSTED_LOGIN, editor=None,
                number=issue_mod.ISSUE_NUMBER, repo=issue_mod.REPO, updated_at=None):
        iso = _iso(time.time() if updated_at is None else updated_at)
        node = {"number": number, "state": state, "body": body, "updatedAt": iso, "lastEditedAt": None,
                "includesCreatedEdit": False, "author": {"login": author}, "editor": None,
                "userContentEdits": {"totalCount": 0, "nodes": []}}
        if editor is not None:
            node.update(lastEditedAt=iso, editor={"login": editor},
                        userContentEdits={"totalCount": 1, "nodes": [{"editedAt": iso, "deletedAt": None,
                                                                       "editor": {"login": editor}}]})
        doc = self._read()
        doc.update(repo=repo, issue=node)
        atomic_write_json(self.path, doc)

    fail = property(lambda self: self._read().get("fail"), lambda self, v: self._set("fail", v))
    delay = property(lambda self: self._read().get("delay", 0), lambda self, v: self._set("delay", v))
    rate_limited = property(lambda self: self._read().get("rate_limited"),
                            lambda self, v: self._set("rate_limited", v))


# --- 取得係 ---
def issue_source(root, cfg, policy):
    budget = ledger(cfg, policy)
    src = cfg["issue_source"]
    if src["kind"] == "file":
        base = issue_mod.FileIssueSource(issue_mod.mock_issue_path(root))
        return BudgetedSource(base, budget) if budget is not None else base
    gql = gq.GitHubGraphQLIssueSource(FIXTURE_TOKEN, enabled=True, opener=FixtureOpener(src["fixture"]),
                                      budget=budget)
    gql.verify_token(timeout=policy_mod.timing(policy, "issue_fetch_timeout"))
    return gql


def witness(root, cfg, policy, now=time.time):
    return issue_mod.IssueWitness(issue_source(root, cfg, policy), signer(root, cfg, "witness"), now)


def spawn_witness(root, policy):
    """実行側（スタブ・S1・S2）が使う取得係。偽Claude のときだけ。wiring.json が無ければ従来の模擬と HMAC。"""
    if policy.get("adapter") != "fake":
        return None
    cfg = load(root)
    if cfg is None:
        keys = signing.load_test_keys(root)
        if "witness" not in keys:
            return None
        return issue_mod.IssueWitness(issue_mod.FileIssueSource(issue_mod.mock_issue_path(root)),
                                      signing.HmacTestSigner({"witness": keys["witness"]}))
    return witness(root, cfg, policy)
