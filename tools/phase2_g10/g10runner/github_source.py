"""ゲート1（TASK 10）: 実 GitHub の Issue #323 を読み取り専用で取得する取得元（候補）。

- 既定は無効（enabled=False）。起動経路（spawn_witness・S1/S2 の監督）には結線していない。実Claude にもつながない。
- 取得するのは、固定の1つの URL（https://api.github.com/repos/anohi-memories/kabumori/issues/323）だけ。
  GET 以外の方法・他のホスト・他のリポジトリ・他の Issue 番号・リダイレクトは拒否する。
- 認証: 公開リポジトリなので、既定は**認証なし**（token を一切使わない＝最小権限）。token を渡す場合は、
  classic token の X-OAuth-Scopes が空（公開情報の読み取りだけ）のときだけ受け付ける。scope の見えない
  fine-grained token は検証できないので拒否する。環境変数・gh の認証情報は読まない。
- 厳格に検証して、不明なものを推測しない:
  - HTTP 200 以外・JSON の不正・部分応答・打ち切り・接続の失敗・API の回数制限の残り0 → IssueSourceError
  - HTTP の Date ヘッダが無い・読めない・ローカル時刻と5分を超えてずれる → IssueSourceError
  - Issue の番号・リポジトリ・PR でないこと・state（open／closed）・作成者・本文・updated_at の形を検証
  - **最後の編集者**: REST の Issue には編集者の情報が無い（GraphQL の editor／userContentEdits は認証が必須）。
    そのため本取得元は、編集者を UNKNOWN_EDITOR として返す。IssueWitness の証拠の検査（editor は None か
    信頼済みのみ）で必ず拒否されるので、編集者が不明な本文で起動することはない（fail-closed）。
"""
import calendar
import email.utils
import time
import urllib.error
import urllib.request

from . import issue as issue_mod
from .fsutil import is_finite_number, loads_strict

API_HOST = "api.github.com"
ISSUE_URL = "https://%s/repos/%s/issues/%d" % (API_HOST, issue_mod.REPO, issue_mod.ISSUE_NUMBER)
UNKNOWN_EDITOR = "unknown: last editor is not available from the anonymous REST API"
MAX_CLOCK_SKEW = 300.0
MAX_BODY_BYTES = 1024 * 1024
USER_AGENT = "kabumori-g10-gate1-readonly-witness"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, "redirect refused", headers, fp)


def _default_open(request, timeout):
    opener = urllib.request.build_opener(_NoRedirect())
    return opener.open(request, timeout=timeout)


def _parse_iso8601_z(value):
    if not isinstance(value, str) or len(value) != 20 or not value.endswith("Z"):
        raise issue_mod.IssueSourceError("issue updated_at has an unexpected format")
    try:
        return float(calendar.timegm(time.strptime(value, "%Y-%m-%dT%H:%M:%SZ")))
    except (ValueError, OverflowError):
        raise issue_mod.IssueSourceError("issue updated_at is not a valid time")


class GitHubIssueSource:
    """IssueWitness の取得元（FileIssueSource と同じ fetch(timeout) の契約）。既定は無効。"""

    def __init__(self, repo=issue_mod.REPO, number=issue_mod.ISSUE_NUMBER, enabled=False, token=None,
                 opener=_default_open, now=time.time):
        if repo != issue_mod.REPO or number != issue_mod.ISSUE_NUMBER:
            raise ValueError("only %s issue #%d is allowed" % (issue_mod.REPO, issue_mod.ISSUE_NUMBER))
        if token is not None and (not isinstance(token, str) or not token):
            raise ValueError("token must be a non-empty string or None")
        self.enabled = enabled
        self._token = token
        self._open = opener
        self.now = now
        self.last_meta = {}

    def __repr__(self):  # token を表示しない
        return "GitHubIssueSource(enabled=%r, auth=%s)" % (self.enabled, "token" if self._token else "anonymous")

    def _request(self, method="GET"):
        if method != "GET":
            raise ValueError("only GET is allowed")
        headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
                   "User-Agent": USER_AGENT}
        if self._token:
            headers["Authorization"] = "Bearer " + self._token
        req = urllib.request.Request(ISSUE_URL, headers=headers, method="GET")
        if req.get_method() != "GET" or req.host != API_HOST or req.type != "https":
            raise ValueError("request is not an HTTPS GET to the GitHub API")
        return req

    def fetch(self, timeout=None):
        if not self.enabled:
            raise issue_mod.IssueSourceError("github source is disabled")
        if timeout is None or not is_finite_number(timeout) or timeout <= 0:
            raise issue_mod.IssueSourceError("a finite positive timeout is required")
        try:
            resp = self._open(self._request(), timeout)
        except urllib.error.HTTPError as exc:
            raise issue_mod.IssueSourceError("github http error %d" % exc.code)
        except Exception as exc:  # 接続の失敗・打ち切り・TLS など（例外の本文は出さない）
            raise issue_mod.IssueSourceError("github fetch failed: %s" % type(exc).__name__)
        try:
            status = getattr(resp, "status", None)
            headers = resp.headers
            if status != 200:
                raise issue_mod.IssueSourceError("github http status %r" % status)
            final_url = resp.geturl() if hasattr(resp, "geturl") else ISSUE_URL
            if final_url != ISSUE_URL:
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
        if length is not None and (not length.isdigit() or int(length) != len(raw)):
            raise issue_mod.IssueSourceError("github response is partial")
        self._check_headers(headers)
        try:
            doc = loads_strict(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise issue_mod.IssueSourceError("github response is not valid JSON")
        return self._snapshot(doc)

    def _check_headers(self, headers):
        remaining = headers.get("X-RateLimit-Remaining")
        if remaining is not None and remaining.strip() == "0":
            raise issue_mod.IssueSourceError("github api rate limit exhausted")
        if self._token is not None:
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
        local = self.now()
        if not is_finite_number(local) or abs(local - reference) > MAX_CLOCK_SKEW:
            raise issue_mod.IssueSourceError("clock skew against the GitHub Date header exceeds 5 minutes")
        self.last_meta = {"reference_time": reference, "rate_remaining": remaining,
                          "rate_limit": headers.get("X-RateLimit-Limit"),
                          "auth": "token" if self._token else "anonymous"}

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
