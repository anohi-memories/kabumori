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
                   "task_sha256", "purpose", "nonce")
# 証拠の用途（TASK 5）: claim＝CLAIM 前の取得、spawn＝ACCEPTED 後・起動直前の再取得、postflight＝finalize での再取得
PURPOSES = ("claim", "spawn", "postflight", "monitor")  # monitor＝実行中の監督の再取得（TASK 7）
# REST の取得元が返す「編集者を確定できない」の値（github_source.UNKNOWN_EDITOR と同じ文字列）
UNKNOWN_EDITOR = "unknown: last editor is not available from the anonymous REST API"


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

    def fetch(self, timeout=None):
        if self.fail:
            raise IssueSourceError(self.fail)
        if self.snapshot is None:
            raise IssueSourceError("issue not available")
        return dict(self.snapshot)


class FileIssueSource:
    """試験用の取得元（ファイル）。制御側と実行側（スタブ＝別プロセス）が同じ模擬 Issue を見るために使う。

    実際の GitHub には触れない。fail（取得の失敗）・delay（応答の遅れ。timeout を超えれば失敗）を模擬できる。
    """

    def __init__(self, path):
        self.path = path

    def _read(self):
        from .fsutil import read_json
        return read_json(self.path) or {}

    def _write(self, doc):
        from .fsutil import atomic_write_json
        atomic_write_json(self.path, doc)

    def publish(self, body, state="OPEN", author=TRUSTED_LOGIN, editor=None, number=ISSUE_NUMBER, repo=REPO,
                updated_at=None):
        self._write({"snapshot": {"repo": repo, "number": number, "state": state, "author": author,
                                  "editor": editor, "body": body,
                                  "updated_at": time.time() if updated_at is None else updated_at}})

    def _set(self, key, value):
        doc = self._read()
        doc[key] = value
        self._write(doc)

    fail = property(lambda self: self._read().get("fail"), lambda self, v: self._set("fail", v))
    delay = property(lambda self: self._read().get("delay", 0), lambda self, v: self._set("delay", v))

    def fetch(self, timeout=None):
        doc = self._read()
        delay = float(doc.get("delay") or 0)
        if delay:
            if timeout is not None and delay > timeout:
                time.sleep(timeout)
                raise IssueSourceError("issue fetch timed out")
            time.sleep(delay)
        if doc.get("fail"):
            raise IssueSourceError(doc["fail"])
        if not doc.get("snapshot"):
            raise IssueSourceError("issue not available")
        return dict(doc["snapshot"])


class IssueWitness:
    """取得係: 取得元から新しく取得し、witness 鍵で事実に署名する（runner 鍵は持たない）。"""

    def __init__(self, source, signer, now=time.time):
        if signer.can_sign("runner"):
            raise ValueError("the issue witness must not hold the runner key")
        self.source = source
        self.signer = signer
        self.now = now

    def observe(self, purpose="claim", nonce=None, timeout=None):
        if purpose not in PURPOSES or not (nonce is None or isinstance(nonce, str)):
            raise ValueError("invalid evidence purpose/nonce")
        fetched_at = self.now()
        if not is_finite_number(fetched_at) or fetched_at <= 0:  # 時計が NaN・Infinity・0以下なら証拠を作らない
            raise IssueSourceError("witness clock is not a finite positive number")
        snap = self.source.fetch(timeout=timeout)
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
                    "body_sha256": sha256_hex(body.encode("utf-8")), "task_sha256": task_sha,
                    "purpose": purpose, "nonce": nonce}
        return {"evidence": evidence, "sig": self.signer.sign("witness", canonical(evidence))}


def evidence_digest(doc):
    return sha256_hex(canonical(doc))


def check_evidence(doc, verifier, body, now, max_age, purpose="claim", nonce=None, go_bodies=()):
    """証拠と本文の結合を検証する。問題があれば理由（文字列）、なければ None。

    purpose・nonce は、その用途・その起動のための取得であること（別の用途・別の起動の証拠の使い回しを拒否）。
    go_bodies（TASK 17）: 人の REAL_CLAUDE_GO が SHA-256 で承認した本文。編集者を確定できない取得元（認証なしの
    REST。editor＝UNKNOWN）でも、本文がこのどれかと完全に同じなら、編集者の代わりに人の署名を根拠に受け付ける。
    """
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
    if ev["purpose"] != purpose or ev["nonce"] != nonce:
        return "issue evidence is for another purpose or run"
    if ev["repo"] != REPO or ev["number"] != ISSUE_NUMBER:
        return "issue evidence is not for Issue #323"
    if ev["state"] != "OPEN":
        return "issue is not open"
    go_approved = ev["editor"] == UNKNOWN_EDITOR and ev["body_sha256"] in go_bodies
    if ev["author"] != TRUSTED_LOGIN or (ev["editor"] not in (None, TRUSTED_LOGIN) and not go_approved):
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


def check_request_evidence(req, verifier, policy, now, go_bodies=()):
    """実行側の検証: 要求の prompt が、新しく取得された Issue #323 の本文と完全に同じであること。"""
    max_age = policy["timing"].get("issue_evidence_max_age")
    if not (is_finite_number(max_age) and max_age > 0):
        return "issue evidence max age not configured"
    return check_evidence(req.get("issue_evidence"), verifier, req.get("prompt"), now, max_age, go_bodies=go_bodies)


# --- 起動直前・終了時の再取得（TASK 5: Issue の鮮度・取消） ---
def spawn_nonce(req, accepted_event_id):
    """起動直前の再取得を、この要求・この ACCEPTED に結び付ける値（事前に作れない・使い回せない）。"""
    return "spawn:%s:%s:%s" % (req["run_id"], req["request_id"], accepted_event_id)


def postflight_nonce(run_id):
    return "postflight:%s" % run_id


def monitor_nonce(run_id):
    """実行中の監督の再取得ごとの値（毎回ちがう。古い監督の証拠の使い回しを拒否）。"""
    import uuid
    return "monitor:%s:%s" % (run_id, uuid.uuid4().hex)


def _same_generation(doc, claim_doc):
    """CLAIM 時の証拠と、世代（updated_at）・本文・state が同じか。"""
    ev, cev = doc["evidence"], (claim_doc or {}).get("evidence") or {}
    if ev["updated_at"] != cev.get("updated_at"):
        return "Issue #323 changed since CLAIM (generation/updated_at)"
    if ev["body_sha256"] != cev.get("body_sha256") or ev["task_sha256"] != cev.get("task_sha256"):
        return "Issue #323 body changed since CLAIM"
    return None


def check_spawn_evidence(doc, claim_doc, verifier, prompt, now, max_age, nonce, accepted_ts, go_bodies=()):
    """起動直前の再取得証拠: 署名・短い有効時間・OPEN・作成者/編集者・本文の完全一致・この起動の nonce・
    ACCEPTED より後の取得・CLAIM 時から世代が変わっていないこと。"""
    reason = check_evidence(doc, verifier, prompt, now, max_age, purpose="spawn", nonce=nonce, go_bodies=go_bodies)
    if reason:
        return reason
    if not (is_finite_number(accepted_ts) and doc["evidence"]["fetched_at"] >= accepted_ts):
        return "spawn evidence was fetched before ACCEPTED"
    return _same_generation(doc, claim_doc)


def check_postflight(doc, claim_doc, verifier, prompt, now, max_age, nonce, go_bodies=()):
    """finalize の再取得証拠: OPEN（CLOSED だけの変更も検出）・本文・世代が CLAIM 時と同じこと。"""
    reason = check_evidence(doc, verifier, prompt, now, max_age, purpose="postflight", nonce=nonce,
                            go_bodies=go_bodies)
    if reason:
        return reason
    return _same_generation(doc, claim_doc)


def check_monitor(doc, claim_doc, verifier, prompt, now, max_age, nonce, go_bodies=()):
    """実行中の監督の再取得証拠（TASK 7）: OPEN・本文・世代が CLAIM 時と同じこと（finalize の再照合と同じ条件）。"""
    reason = check_evidence(doc, verifier, prompt, now, max_age, purpose="monitor", nonce=nonce, go_bodies=go_bodies)
    if reason:
        return reason
    return _same_generation(doc, claim_doc)


def mock_issue_path(root):
    import os
    return os.path.join(root, "mock_issue.json")


def spawn_witness(root, policy):
    """実行側（スタブ）が起動直前に使う取得係。偽Claudeのアダプタのときだけ作る（それ以外は None＝起動しない）。
    TASK 15: 組み立ては wiring.spawn_witness（wiring.json が無ければ従来どおり、試験用の模擬（ファイル）と
    試験用の witness 鍵）。実際の GitHub からの取得は未実装。"""
    from . import wiring
    return wiring.spawn_witness(root, policy)
