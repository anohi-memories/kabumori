"""ゲート1追加（TASK 11）: Issue #323 の最後の編集者の根拠を、GitHub GraphQL から読み取り専用で得る取得元（候補）。

- 既定は無効（enabled=False）。起動経路には結線していない。GraphQL は**認証が必須**なので、事前確認を済ませた
  classic の no-scope token（github_source.check_token_shape と verify_token）が無ければ取得しない。
- 送るのは、変数も無い**固定の読み取り問い合わせ1つ**だけ（FIXED_QUERY。mutation・subscription は含まない）。
  宛先は https://api.github.com/graphql の POST（GraphQL の読み取りは仕様上 POST）。本文は {"query": FIXED_QUERY} に
  固定し、それ以外を送ろうとしたら拒否する。リダイレクト・別 URL の応答も拒否する。
- 応答の "errors" は1件でもあれば失敗。リポジトリ名・Issue 番号・state・作成者・本文・updatedAt を検証する。
- 最後の編集者（determine_editor）: 次をすべて満たすときだけ、編集者を確定する。満たさなければ UNKNOWN_EDITOR
  （IssueWitness の証拠の検査で必ず拒否）。推測で「未編集」「信頼済み」にしない。
  - 要求した項目（editor・lastEditedAt・includesCreatedEdit・userContentEdits、各版の editedAt・deletedAt・editor）が
    すべて**ある**こと（項目が無いのを null と同じに扱わない。TASK 12）
  - 未編集: userContentEdits.totalCount＝0、lastEditedAt と editor がともに null、includesCreatedEdit が false → editor＝None
  - 編集あり: 編集履歴が欠けていない（totalCount≦100 かつ取得した件数＝totalCount）、すべての編集の editor が
    信頼済みのアカウント、削除された版（deletedAt）が無い、Issue の editor が信頼済み、lastEditedAt が編集履歴の
    最新の editedAt と一致、includesCreatedEdit が true なら履歴が2件以上 → editor＝信頼済みのアカウント
  ※ 編集履歴の完全性（GitHub が短時間の連続編集をまとめる・版を削除できる等）は GitHub の仕様に依存し、
    実機では未検証（NOT_VERIFIED）。上の条件は、分からないものを通さない側に倒している。
"""
import json
import time
import urllib.error
import urllib.request

from . import github_source as gh
from . import issue as issue_mod
from .fsutil import is_finite_number, loads_strict

GRAPHQL_URL = "https://%s/graphql" % gh.API_HOST
UNKNOWN_EDITOR = "unknown: last editor could not be established from the GraphQL edit history"
MAX_EDITS = 100
FIXED_QUERY = (
    'query G10Issue323 { repository(owner: "anohi-memories", name: "kabumori") { nameWithOwner '
    'issue(number: 323) { number state body updatedAt lastEditedAt includesCreatedEdit '
    'author { login } editor { login } '
    'userContentEdits(last: 100) { totalCount nodes { editedAt deletedAt editor { login } } } } } }'
)
FIXED_PAYLOAD = json.dumps({"query": FIXED_QUERY}, separators=(",", ":")).encode("utf-8")


def _login(actor):
    return actor.get("login") if isinstance(actor, dict) and isinstance(actor.get("login"), str) else None


ISSUE_PROVENANCE_FIELDS = ("lastEditedAt", "editor", "includesCreatedEdit", "userContentEdits")
EDIT_NODE_FIELDS = ("editedAt", "deletedAt", "editor")


def _actor_ok(value):
    """editor の値は null か {login: 文字列}。それ以外の形は不正。"""
    return value is None or (isinstance(value, dict) and isinstance(value.get("login"), str) and value["login"])


def determine_editor(issue, trusted=issue_mod.TRUSTED_LOGIN):
    """(editor, 根拠) を返す。確定できなければ (UNKNOWN_EDITOR, 理由)。

    TASK 12（H2 R1）: 固定の問い合わせで要求した provenance の項目は、まず「あること」と型を確かめる。
    項目が**無い**ことを null（未編集・未削除）と同じに扱わない。includesCreatedEdit と編集履歴の矛盾も不明にする。
    """
    if not isinstance(issue, dict):
        return UNKNOWN_EDITOR, "issue malformed"
    for key in ISSUE_PROVENANCE_FIELDS:
        if key not in issue:
            return UNKNOWN_EDITOR, "provenance field missing: " + key
    last_edited, editor = issue["lastEditedAt"], issue["editor"]
    created_edit, edits = issue["includesCreatedEdit"], issue["userContentEdits"]
    if not isinstance(created_edit, bool):
        return UNKNOWN_EDITOR, "includesCreatedEdit malformed"
    if not (last_edited is None or isinstance(last_edited, str)) or not _actor_ok(editor):
        return UNKNOWN_EDITOR, "edit markers malformed"
    if not isinstance(edits, dict) or "totalCount" not in edits or "nodes" not in edits:
        return UNKNOWN_EDITOR, "edit history missing"
    total, nodes = edits["totalCount"], edits["nodes"]
    if not (isinstance(total, int) and not isinstance(total, bool) and total >= 0 and isinstance(nodes, list)):
        return UNKNOWN_EDITOR, "edit history malformed"
    if total == 0:
        if last_edited is None and editor is None and not nodes and created_edit is False:
            return None, "never edited"
        return UNKNOWN_EDITOR, "no edit history but edit markers are present"
    if total > MAX_EDITS or len(nodes) != total:
        return UNKNOWN_EDITOR, "edit history incomplete (%d of %d)" % (len(nodes), total)
    if created_edit and total < 2:  # 作成時のデータの版＋1回以上の編集があるはず
        return UNKNOWN_EDITOR, "includesCreatedEdit is inconsistent with the edit history"
    times = []
    for node in nodes:
        if not isinstance(node, dict) or any(key not in node for key in EDIT_NODE_FIELDS):
            return UNKNOWN_EDITOR, "edit history node missing fields"
        if node["deletedAt"] is not None:
            return UNKNOWN_EDITOR, "edit history has a deleted revision"
        if not _actor_ok(node["editor"]) or _login(node["editor"]) != trusted:
            return UNKNOWN_EDITOR, "an edit was made by an untrusted or unknown actor"
        try:
            times.append(gh._parse_iso8601_z(node["editedAt"], "edit time"))
        except issue_mod.IssueSourceError:
            return UNKNOWN_EDITOR, "edit time malformed"
    if _login(editor) != trusted:
        return UNKNOWN_EDITOR, "last editor is not the trusted account"
    try:
        last = gh._parse_iso8601_z(last_edited, "lastEditedAt")
    except issue_mod.IssueSourceError:
        return UNKNOWN_EDITOR, "lastEditedAt malformed"
    if last != max(times):
        return UNKNOWN_EDITOR, "lastEditedAt does not match the edit history"
    return trusted, "all %d edits by %s; last at %s" % (total, trusted, last_edited)


class GitHubGraphQLIssueSource:
    """IssueWitness の取得元（fetch(timeout) の契約）。既定は無効。事前確認を済ませた no-scope token が必須。"""

    def __init__(self, token, enabled=False, opener=gh._default_open, now=time.time, budget=None):
        self._token = gh.check_token_shape(token)
        if self._token is None:
            raise ValueError("GraphQL requires a verified no-scope classic token")
        self._token_verified = False
        self.enabled = enabled
        self._open = opener
        self.now = now
        self.budget = budget
        self.last_meta = {}

    def __repr__(self):  # token を表示しない
        return "GitHubGraphQLIssueSource(enabled=%r, auth=token)" % self.enabled

    def verify_token(self, timeout=5.0):
        meta = gh.verify_token(self._token, self._open, timeout, self.now)
        self._token_verified = True
        return meta

    def _request(self, payload=FIXED_PAYLOAD, method="POST"):
        if method != "POST" or payload != FIXED_PAYLOAD:
            raise ValueError("only the fixed read-only GraphQL query may be sent")
        text = FIXED_QUERY.lstrip()
        if not text.startswith("query ") or "mutation" in text or "subscription" in text:
            raise ValueError("the GraphQL document must be a read-only query")
        headers = gh._headers(self._token, accept="application/json")
        headers["Content-Type"] = "application/json"
        req = urllib.request.Request(GRAPHQL_URL, data=payload, headers=headers, method="POST")
        if req.get_method() != "POST" or req.host != gh.API_HOST or req.type != "https":
            raise ValueError("request is not an HTTPS POST to the GitHub GraphQL API")
        return req

    def fetch(self, timeout=None):
        if not self.enabled:
            raise issue_mod.IssueSourceError("github graphql source is disabled")
        if timeout is None or not is_finite_number(timeout) or timeout <= 0:
            raise issue_mod.IssueSourceError("a finite positive timeout is required")
        if not self._token_verified:
            raise issue_mod.IssueSourceError("token scopes have not been verified (call verify_token first)")
        if self.budget is not None:
            self.budget.before_request(self.now())
        try:
            resp = self._open(self._request(), timeout)
        except urllib.error.HTTPError as exc:
            err = gh.http_error(exc, self.now())
            if isinstance(err, gh.RateLimited) and self.budget is not None:
                self.budget.block(err.retry_after, self.now())  # その時刻まで送らない（自動の再試行はしない）
            raise err
        except Exception as exc:
            raise issue_mod.IssueSourceError("github graphql fetch failed: %s" % type(exc).__name__)
        headers, raw = gh.read_body(resp, GRAPHQL_URL)
        self.last_meta = gh.check_response_headers(headers, self.now(), self._token, self.budget)
        try:
            doc = loads_strict(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            raise issue_mod.IssueSourceError("github graphql response is not valid JSON")
        return self._snapshot(doc)

    def _snapshot(self, doc):
        if not isinstance(doc, dict):
            raise issue_mod.IssueSourceError("github graphql response is not an object")
        if doc.get("errors"):
            raise issue_mod.IssueSourceError("github graphql response has errors")
        repo = (doc.get("data") or {}).get("repository") if isinstance(doc.get("data"), dict) else None
        if not isinstance(repo, dict) or repo.get("nameWithOwner") != issue_mod.REPO:
            raise issue_mod.IssueSourceError("github graphql response is for another repository")
        issue = repo.get("issue")
        if not isinstance(issue, dict) or issue.get("number") != issue_mod.ISSUE_NUMBER:
            raise issue_mod.IssueSourceError("github graphql response is for another issue")
        state = issue.get("state")
        if state not in ("OPEN", "CLOSED"):
            raise issue_mod.IssueSourceError("github issue state is unknown")
        author = _login(issue.get("author"))
        if not author:
            raise issue_mod.IssueSourceError("github issue author is missing")
        body = issue.get("body")
        if not isinstance(body, str):
            raise issue_mod.IssueSourceError("github issue body is missing")
        editor, basis = determine_editor(issue)
        self.last_meta["editor_basis"] = basis
        return {"repo": issue_mod.REPO, "number": issue_mod.ISSUE_NUMBER, "state": state, "author": author,
                "editor": editor, "body": body,
                "updated_at": gh._parse_iso8601_z(issue.get("updatedAt"), "issue updatedAt")}
