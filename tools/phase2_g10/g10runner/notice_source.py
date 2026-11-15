"""お知らせイシュー（#639）のコメントを匿名 REST で取得する（notice-dispatch 用）。

github_source と同じ安全策を再利用する: 固定 URL（api.github.com・https・GET のみ）、200 以外や
別 URL・部分応答・大きすぎる応答は拒否、回数制限と時刻ずれを検査。トークンは使わない（匿名 60req/時）。
応答（コメント本文）は untrusted data。解釈は dispatch 側（slot のみ採用）。

量が増えたら `since`（ISO8601）で取得範囲を絞る（dispatch 側の時刻カーソルを渡す）。ページングは
当面 per_page=100 の1ページのみ（お知らせは登録ごとに1コメントで緩やかに増える）。
"""
import json
import urllib.error
import urllib.parse
import urllib.request

from . import github_source as gh
from . import issue as issue_mod

NOTICE_ISSUE = 639
_BASE = "https://%s/repos/%s/issues/%d/comments" % (gh.API_HOST, issue_mod.REPO, NOTICE_ISSUE)


class NoticeSourceError(RuntimeError):
    pass


def comments_url(since=None, per_page=100):
    q = {"per_page": str(int(per_page))}
    if since:
        q["since"] = since
    return _BASE + "?" + urllib.parse.urlencode(sorted(q.items()))


def fetch_comments(since=None, opener=None, timeout=5.0, now=None):
    """#639 のコメントを [{id, created_at, body}] で返す（並び順は問わない; dispatch が id で並べる）。"""
    import time as _t
    now = _t.time() if now is None else (now() if callable(now) else now)
    url = comments_url(since)
    opener = opener or gh._default_open
    req = urllib.request.Request(url, headers=gh._headers(None), method="GET")
    if req.get_method() != "GET" or req.host != gh.API_HOST or req.type != "https":
        raise NoticeSourceError("request must be an https GET to the GitHub API host")
    try:
        resp = opener(req, timeout)
    except urllib.error.HTTPError as exc:
        raise gh.http_error(exc, now)                 # RateLimited / IssueSourceError
    except Exception as exc:
        raise NoticeSourceError("github request failed: %s" % type(exc).__name__)
    headers, raw = gh.read_body(resp, url)            # 200 / URL / size / partial の検査
    gh.check_response_headers(headers, now, None)     # 回数制限・時刻ずれ（anonymous）
    try:
        data = json.loads(raw.decode("utf-8"))
    except Exception:
        raise NoticeSourceError("comments response is not valid JSON")
    if not isinstance(data, list):
        raise NoticeSourceError("comments response is not a JSON list")
    out = []
    for c in data:
        if isinstance(c, dict) and isinstance(c.get("id"), int):
            out.append({"id": c["id"], "created_at": c.get("created_at"), "body": c.get("body") or ""})
    return out
