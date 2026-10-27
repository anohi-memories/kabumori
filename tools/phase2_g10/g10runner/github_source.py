"""ゲート1（TASK 10・11）: 実 GitHub の Issue #323 を読み取り専用で取得する取得元（候補）。

- 既定は無効（enabled=False）。起動経路（spawn_witness・S1/S2 の監督）には結線していない。実Claude にもつながない。
- 取得するのは、固定の1つの URL（https://api.github.com/repos/anohi-memories/kabumori/issues/323）だけ。
  GET 以外の方法・他のホスト・他のリポジトリ・他の Issue 番号・リダイレクトは拒否する。
- 認証（TASK 11）: 公開リポジトリなので、既定は**認証なし**（token を一切使わない＝最小権限）。環境変数・gh の
  認証情報は読まない。token を使う場合は、次の順でだけ受け付ける（どれかに外れたら使わない）。
  1. 送信の前: token の形が classic の個人用 token（`ghp_` ＋36文字）であること。gh CLI の OAuth token（`gho_`）・
     fine-grained token（`github_pat_`。scope が応答に出ないので検証できない）・App の token などは、通信の前に拒否。
  2. scope の確認: データを返さない読み取り専用の `GET /rate_limit` だけに送り、`X-OAuth-Scopes` が**空**
     （公開情報の読み取りだけ）であることを確かめる（verify_token）。確かめるまで Issue の取得はしない。
     ※ token の scope を「送る前に」証明する方法は GitHub に無い。確認のための送信は、副作用の無い GET の
       1回だけで、宛先は api.github.com に限る。
  3. 取得のたびに、応答の `X-OAuth-Scopes` が空であることを再確認する。
- 厳格に検証して、不明なものを推測しない:
  - HTTP 200（または条件付き取得の 304）以外・JSON の不正・部分応答・打ち切り・接続の失敗・API の回数制限の残り0
    → IssueSourceError（429・二次制限の 403 は Retry-After／Reset を持つ RateLimited）
  - HTTP の Date ヘッダが無い・読めない・ローカル時刻と5分を超えてずれる → IssueSourceError
  - Issue の番号・リポジトリ・PR でないこと・state（open／closed）・作成者・本文・updated_at の形を検証
  - **最後の編集者**: REST の Issue には編集者の情報が無い。そのため REST の取得元は、編集者を UNKNOWN_EDITOR として返し、
    IssueWitness の証拠の検査で必ず拒否される（fail-closed）。編集者の根拠は github_graphql.py（認証が必須）。
- 回数の予算（TASK 11）: 任意の RateBudget を渡すと、送信の前に予算を確かめ（超えるなら送らない）、応答の
  残り回数・リセット時刻・Retry-After を記録する。条件付き取得（ETag／If-None-Match）で、変化が無ければ 304 を
  受け取り、前回の内容を使い回す（認証ありなら 304 は主な回数制限に数えられない。認証なしでは数えられる）。
"""
import calendar
import email.utils
import re
import time
import urllib.error
import urllib.request

from . import issue as issue_mod
from .fsutil import is_finite_number, loads_strict

API_HOST = "api.github.com"
ISSUE_URL = "https://%s/repos/%s/issues/%d" % (API_HOST, issue_mod.REPO, issue_mod.ISSUE_NUMBER)
RATE_LIMIT_URL = "https://%s/rate_limit" % API_HOST
UNKNOWN_EDITOR = issue_mod.UNKNOWN_EDITOR  # 証拠の検査（issue.check_evidence）と同じ値
MAX_CLOCK_SKEW = 300.0
MAX_BODY_BYTES = 1024 * 1024
USER_AGENT = "kabumori-g10-gate1-readonly-witness"
CLASSIC_PAT_RE = re.compile(r"ghp_[A-Za-z0-9]{36}")


class RateLimited(issue_mod.IssueSourceError):
    """回数制限（429・二次制限の 403・残り0）。retry_after 秒より前に再試行しない（自動の再試行はしない）。"""

    def __init__(self, message, retry_after=None):
        super().__init__(message)
        self.retry_after = retry_after


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, "redirect refused", headers, fp)


def _default_open(request, timeout):
    opener = urllib.request.build_opener(_NoRedirect())
    return opener.open(request, timeout=timeout)


def _parse_iso8601_z(value, what="issue updated_at"):
    if not isinstance(value, str) or len(value) != 20 or not value.endswith("Z"):
        raise issue_mod.IssueSourceError("%s has an unexpected format" % what)
    try:
        return float(calendar.timegm(time.strptime(value, "%Y-%m-%dT%H:%M:%SZ")))
    except (ValueError, OverflowError):
        raise issue_mod.IssueSourceError("%s is not a valid time" % what)


def check_token_shape(token):
    """送信の前の判定: classic の個人用 token（ghp_＋36文字）だけを受け付ける。値は表示しない。"""
    if token is None:
        return None
    if not isinstance(token, str) or not CLASSIC_PAT_RE.fullmatch(token):  # fullmatch: 末尾の改行も通さない
        raise ValueError("only a classic personal access token (ghp_...) with no scopes can be used; "
                         "OAuth (gho_), fine-grained (github_pat_) and other tokens are refused before sending")
    return token


def _headers(token, accept="application/vnd.github+json"):
    h = {"Accept": accept, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": USER_AGENT}
    if token:
        h["Authorization"] = "Bearer " + token
    return h


def _retry_after(headers, now):
    ra = headers.get("Retry-After") if headers is not None else None
    if ra is not None and str(ra).strip().isdigit():
        return float(str(ra).strip())
    reset = headers.get("X-RateLimit-Reset") if headers is not None else None
    if reset is not None and str(reset).strip().isdigit():
        return max(0.0, float(str(reset).strip()) - now)
    return None


def http_error(exc, now):
    """HTTPError を、決まった理由の IssueSourceError に変える（回数制限は RateLimited）。"""
    headers = getattr(exc, "headers", None)
    if exc.code == 429 or (exc.code == 403 and headers is not None and (
            str(headers.get("X-RateLimit-Remaining", "")).strip() == "0" or headers.get("Retry-After") is not None)):
        return RateLimited("github rate limited (http %d)" % exc.code, _retry_after(headers, now))
    return issue_mod.IssueSourceError("github http error %d" % exc.code)


def check_response_headers(headers, now, token, budget=None):
    """回数制限・token の scope・Date の時刻のずれを検査し、記録用の情報を返す。"""
    if budget is not None:
        budget.observe(headers, now)
    remaining = headers.get("X-RateLimit-Remaining")
    if remaining is not None and str(remaining).strip() == "0":
        raise RateLimited("github api rate limit exhausted", _retry_after(headers, now))
    if token is not None:
        scopes = headers.get("X-OAuth-Scopes")
        if scopes is None:
            raise issue_mod.IssueSourceError("token scopes cannot be verified (fine-grained token refused)")
        if scopes.strip():
            raise issue_mod.IssueSourceError("token has scopes; only a no-scope (public read) token is allowed")
    date = headers.get("Date")
    parsed = email.utils.parsedate_tz(date) if date else None
    if not parsed:
        raise issue_mod.IssueSourceError("github response has no valid Date header")
    reference = float(email.utils.mktime_tz(parsed))
    if not is_finite_number(now) or abs(now - reference) > MAX_CLOCK_SKEW:
        raise issue_mod.IssueSourceError("clock skew against the GitHub Date header exceeds 5 minutes")
    return {"reference_time": reference, "rate_remaining": remaining, "rate_limit": headers.get("X-RateLimit-Limit"),
            "rate_resource": headers.get("X-RateLimit-Resource"), "auth": "token" if token else "anonymous"}


def read_body(resp, expected_url):
    """応答の本文を読む（200 以外・別 URL・部分応答・大きすぎる応答は拒否）。"""
    try:
        status = getattr(resp, "status", None)
        headers = resp.headers
        if status != 200:
            raise issue_mod.IssueSourceError("github http status %r" % status)
        final_url = resp.geturl() if hasattr(resp, "geturl") else expected_url
        if final_url != expected_url:
            raise issue_mod.IssueSourceError("github response came from an unexpected url")
        raw = resp.read(MAX_BODY_BYTES + 1)
    except issue_mod.IssueSourceError:
        raise
    except Exception as exc:  # 部分応答（IncompleteRead）など
        raise issue_mod.IssueSourceError("github response read failed: %s" % type(exc).__name__)
    finally:
        try:
            resp.close()
        except Exception:
            pass
    if len(raw) > MAX_BODY_BYTES:
        raise issue_mod.IssueSourceError("github response too large")
    length = headers.get("Content-Length")
    if length is not None and (not str(length).isdigit() or int(length) != len(raw)):
        raise issue_mod.IssueSourceError("github response is partial")
    return headers, raw


def verify_token(token, opener=_default_open, timeout=5.0, now=time.time):
    """token の scope の確認（送信の前の形の判定を通ったものだけ）。GET /rate_limit（データを返さない・
    主な回数制限に数えられない）に1回だけ送り、X-OAuth-Scopes が空であることを確かめる。"""
    check_token_shape(token)
    if token is None:
        raise ValueError("no token to verify")
    req = urllib.request.Request(RATE_LIMIT_URL, headers=_headers(token), method="GET")
    if req.get_method() != "GET" or req.host != API_HOST or req.type != "https":
        raise ValueError("request is not an HTTPS GET to the GitHub API")
    try:
        resp = opener(req, timeout)
    except urllib.error.HTTPError as exc:
        raise http_error(exc, now())
    except Exception as exc:
        raise issue_mod.IssueSourceError("github token check failed: %s" % type(exc).__name__)
    headers, raw = read_body(resp, RATE_LIMIT_URL)
    meta = check_response_headers(headers, now(), token)
    try:
        doc = loads_strict(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise issue_mod.IssueSourceError("github rate_limit response is not valid JSON")
    resources = doc.get("resources") if isinstance(doc, dict) else None
    if not isinstance(resources, dict):
        raise issue_mod.IssueSourceError("github rate_limit response is malformed")
    meta["limits"] = {k: (v.get("limit"), v.get("remaining")) for k, v in resources.items()
                      if k in ("core", "graphql") and isinstance(v, dict)}
    return meta


class GitHubIssueSource:
    """IssueWitness の取得元（FileIssueSource と同じ fetch(timeout) の契約）。既定は無効。"""

    def __init__(self, repo=issue_mod.REPO, number=issue_mod.ISSUE_NUMBER, enabled=False, token=None,
                 opener=_default_open, now=time.time, budget=None, conditional=True):
        if repo != issue_mod.REPO or number != issue_mod.ISSUE_NUMBER:
            raise ValueError("only %s issue #%d is allowed" % (issue_mod.REPO, issue_mod.ISSUE_NUMBER))
        self.enabled = enabled
        self._token = check_token_shape(token)
        self._token_verified = False
        self._open = opener
        self.now = now
        self.budget = budget
        self.conditional = conditional
        self._etag = None
        self._cached = None
        self.last_meta = {}

    def __repr__(self):  # token を表示しない
        return "GitHubIssueSource(enabled=%r, auth=%s)" % (self.enabled, "token" if self._token else "anonymous")

    def verify_token(self, timeout=5.0):
        if self._token is None:
            raise ValueError("anonymous source has no token to verify")
        meta = verify_token(self._token, self._open, timeout, self.now)
        self._token_verified = True
        return meta

    def _request(self, method="GET"):
        if method != "GET":
            raise ValueError("only GET is allowed")
        headers = _headers(self._token)
        if self.conditional and self._etag and self._cached is not None:
            headers["If-None-Match"] = self._etag
        req = urllib.request.Request(ISSUE_URL, headers=headers, method="GET")
        if req.get_method() != "GET" or req.host != API_HOST or req.type != "https":
            raise ValueError("request is not an HTTPS GET to the GitHub API")
        return req

    def fetch(self, timeout=None):
        if not self.enabled:
            raise issue_mod.IssueSourceError("github source is disabled")
        if timeout is None or not is_finite_number(timeout) or timeout <= 0:
            raise issue_mod.IssueSourceError("a finite positive timeout is required")
        if self._token is not None and not self._token_verified:
            raise issue_mod.IssueSourceError("token scopes have not been verified (call verify_token first)")
        if self.budget is not None:
            self.budget.before_request(self.now())
        try:
            resp = self._open(self._request(), timeout)
        except urllib.error.HTTPError as exc:
            if exc.code == 304 and self._cached is not None:
                return self._not_modified(exc.headers)
            err = http_error(exc, self.now())
            if isinstance(err, RateLimited) and self.budget is not None:
                self.budget.block(err.retry_after, self.now())  # その時刻まで送らない（自動の再試行はしない）
            raise err
        except Exception as exc:  # 接続の失敗・打ち切り・TLS など（例外の本文は出さない）
            raise issue_mod.IssueSourceError("github fetch failed: %s" % type(exc).__name__)
        if getattr(resp, "status", None) == 304 and self._cached is not None:
            headers = resp.headers
            try:
                resp.close()
            except Exception:
                pass
            return self._not_modified(headers)
        headers, raw = read_body(resp, ISSUE_URL)
        self.last_meta = check_response_headers(headers, self.now(), self._token, self.budget)
        try:
            doc = loads_strict(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise issue_mod.IssueSourceError("github response is not valid JSON")
        snap = self._snapshot(doc)
        etag = headers.get("ETag")
        self._etag, self._cached = (etag, dict(snap)) if isinstance(etag, str) and etag else (None, None)
        return snap

    def _not_modified(self, headers):
        """304: サーバが「前回から変化なし」と答えた。Date などは同じく検査し、前回の内容を返す。"""
        if headers is None:
            raise issue_mod.IssueSourceError("github 304 response has no headers")
        self.last_meta = check_response_headers(headers, self.now(), self._token, self.budget)
        etag = headers.get("ETag")
        if etag is not None and etag != self._etag:
            raise issue_mod.IssueSourceError("github 304 response has a different ETag")
        self.last_meta["not_modified"] = True
        return dict(self._cached)

    def _snapshot(self, doc):
        if not isinstance(doc, dict):
            raise issue_mod.IssueSourceError("github response is not an object")
        if doc.get("number") != issue_mod.ISSUE_NUMBER:
            raise issue_mod.IssueSourceError("github response is for another issue")
        if doc.get("repository_url") != "https://%s/repos/%s" % (API_HOST, issue_mod.REPO):
            raise issue_mod.IssueSourceError("github response is for another repository")
        if "pull_request" in doc:
            raise issue_mod.IssueSourceError("github response is a pull request, not an issue")
        state = {"open": "OPEN", "closed": "CLOSED"}.get(doc.get("state"))
        if state is None:
            raise issue_mod.IssueSourceError("github issue state is unknown")
        user = doc.get("user")
        author = user.get("login") if isinstance(user, dict) else None
        if not isinstance(author, str) or not author:
            raise issue_mod.IssueSourceError("github issue author is missing")
        body = doc.get("body")
        if not isinstance(body, str):
            raise issue_mod.IssueSourceError("github issue body is missing")
        return {"repo": issue_mod.REPO, "number": issue_mod.ISSUE_NUMBER, "state": state, "author": author,
                "editor": UNKNOWN_EDITOR, "body": body, "updated_at": _parse_iso8601_z(doc.get("updated_at"))}
