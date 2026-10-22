"""Issue #323 との結合（H4 P1 の修正）。仕様 v5 §5-4（Issue の新規取得・信頼条件）。

ENVELOPE は「範囲内の、Issue #323 に正式に発行された現役TASK」を承認するものであり、
runner 鍵が作った任意のTASK本文の実行までは承認しない。そこで、

1. 取得係（IssueWitness）が、Issue #323 の正規本文・state・作成者・編集者・更新時刻を**新しく**取得し、
   runner とは別の鍵（witness 役割）で、その事実（本文の SHA-256 を含む）に署名する。
2. 制御側は CLAIM の前に取得係から証拠を受け取り、要求に同梱する。
3. 実行側（agent の受理前・スタブの開始時・臨界区間の最終判定）は、証拠の署名・鮮度・Issue の条件
   （OPEN・#323・作成者／編集者が信頼済み）と、要求の prompt が証拠の本文と**完全に同じ**であること
   （生の SHA-256 と NORM-1 の両方）を検証する。TASK側の条件（status: ready・slot: G10・owner: claude・
   task_id）は、本文そのものを meta.validate_task で検証する（binding.check_request）。

runner 鍵だけでは、Issue に無いTASK・古い本文・別のIssueの本文を受理させられない。

本TASKでは、実際の GitHub からの取得は実装しない（実機統合は NOT_VERIFIED）。取得元は差し替え可能な
インターフェース（MockIssueSource は試験用）。witness の鍵も試験用 HMAC のみ（signing.py）。
"""
import time

from . import jstclock, norm
from .fsutil import canonical, is_finite_number, sha256_hex

REPO = "anohi-memories/kabumori"
ISSUE_NUMBER = 323
TRUSTED_LOGIN = "anohi-memories"
EVIDENCE_FIELDS = ("repo", "number", "state", "author", "editor", "updated_at", "fetched_at", "body_sha256",
                   "task_sha256")


class IssueSourceError(RuntimeError):
    """Issue を取得できない。"""


class MockIssueSource:
    """試験用の取得元。publish した内容だけを返す（実際の GitHub には触れない）。"""

    def __init__(self):
        self.snapshot = None
        self.fail = None

    def publish(self, body, state="OPEN", author=TRUSTED_LOGIN, editor=None, number=ISSUE_NUMBER, repo=REPO,
                updated_at=None):
        self.snapshot = {"repo": repo, "number": number, "state": state, "author": author, "editor": editor,
                         "body": body, "updated_at": time.time() if updated_at is None else updated_at}

    def fetch(self):
        if self.fail:
            raise IssueSourceError(self.fail)
        if self.snapshot is None:
            raise IssueSourceError("issue not available")
        return dict(self.snapshot)


class IssueWitness:
    """取得係: 取得元から新しく取得し、witness 鍵で事実に署名する（runner 鍵は持たない）。"""

    def __init__(self, source, signer, now=time.time):
        if signer.can_sign("runner"):
            raise ValueError("the issue witness must not hold the runner key")
        self.source = source
        self.signer = signer
        self.now = now

    def observe(self):
        fetched_at = self.now()
        if not is_finite_number(fetched_at) or fetched_at <= 0:  # 時計が NaN・Infinity・0以下なら証拠を作らない
            raise IssueSourceError("witness clock is not a finite positive number")
        snap = self.source.fetch()
        body = snap.get("body")
        if not isinstance(body, str):
            raise IssueSourceError("issue body missing")
        try:
            task_sha = norm.compute_hash(body)
        except norm.NormError:
            task_sha = None
        evidence = {"repo": snap.get("repo"), "number": snap.get("number"), "state": snap.get("state"),
                    "author": snap.get("author"), "editor": snap.get("editor"),
                    "updated_at": snap.get("updated_at"), "fetched_at": fetched_at,
                    "body_sha256": sha256_hex(body.encode("utf-8")), "task_sha256": task_sha}
        return {"evidence": evidence, "sig": self.signer.sign("witness", canonical(evidence))}


def evidence_digest(doc):
    return sha256_hex(canonical(doc))


def check_evidence(doc, verifier, body, now, max_age):
    """証拠と本文の結合を検証する。問題があれば理由（文字列）、なければ None。"""
    if not isinstance(doc, dict) or set(doc) != {"evidence", "sig"} or not isinstance(doc["evidence"], dict):
        return "issue evidence malformed"
    ev = doc["evidence"]
    if set(ev) != set(EVIDENCE_FIELDS):
        return "issue evidence fields invalid"
    try:
        signed = canonical(ev)
    except ValueError:  # NaN・Infinity を含む証拠（H3 C3 R2）: 署名の検証より前に拒否
        return "issue evidence contains non-finite numbers"
    if not verifier.verify("witness", signed, doc["sig"]):
        return "issue evidence signature invalid"
    if ev["repo"] != REPO or ev["number"] != ISSUE_NUMBER:
        return "issue evidence is not for Issue #323"
    if ev["state"] != "OPEN":
        return "issue is not open"
    if ev["author"] != TRUSTED_LOGIN or ev["editor"] not in (None, TRUSTED_LOGIN):
        return "issue author/editor not trusted"
    # H3 C3 R2: 時刻・期間は有限の正の数だけ（NaN では比較がすべて偽になり、鮮度の検査をすり抜ける）
    if not (is_finite_number(ev["fetched_at"]) and is_finite_number(ev["updated_at"])
            and ev["fetched_at"] > 0 and ev["updated_at"] > 0):
        return "issue evidence times invalid"
    if not (is_finite_number(now) and now > 0):
        return "verifier clock invalid"
    if not (is_finite_number(max_age) and max_age > 0):
        return "issue evidence max age invalid"
    if ev["updated_at"] > ev["fetched_at"] + jstclock.CLOCK_TOLERANCE_SECONDS:
        return "issue evidence times inconsistent"
    age = now - ev["fetched_at"]
    if age > max_age or age < -jstclock.CLOCK_TOLERANCE_SECONDS:
        return "issue evidence is stale or from the future"
    if not isinstance(body, str) or sha256_hex(body.encode("utf-8")) != ev["body_sha256"]:
        return "task body differs from the current Issue #323 body"
    try:
        computed = norm.compute_hash(body)
    except norm.NormError:
        return "task body hash cannot be computed"
    if ev["task_sha256"] != computed:
        return "issue evidence task hash mismatch"
    return None


def check_request_evidence(req, verifier, policy, now):
    """実行側の検証: 要求の prompt が、新しく取得された Issue #323 の本文と完全に同じであること。"""
    max_age = policy["timing"].get("issue_evidence_max_age")
    if not (is_finite_number(max_age) and max_age > 0):
        return "issue evidence max age not configured"
    return check_evidence(req.get("issue_evidence"), verifier, req.get("prompt"), now, max_age)
