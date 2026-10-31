"""専用ユーザー方式のジョブ受け口（設計 §14.2-14.3）。_kaburun 側で動くエージェント本体。

yuya（制御プレーン）が handoff/in に署名付きジョブ（JSON 1ファイル）を置く。_kaburun の受け口は、それを
fail-closed で検証し、at-most-once で CLAIM してから、実 CLI のアダプタに渡せる形にする（起動はしない）。

信頼の土台（レビュー向けの要点）:
- ジョブの正真性は **署名** が土台。ファイルの所有者ではなく、人（human）の鍵で canonical バイトに署名されているか
  だけを信じる（chainlog と同じ canonical）。handoff/in のファイルは yuya 所有なので、uid での所有確認はしない。
- in フォルダは ACL で向きを固定する前提（yuya=書き、_kaburun=読み取りのみ）。コード側は多層目として、
  in が正規の絶対パスのフォルダで、グループ／他人が書けないこと、ジョブファイルがシンボリックリンク・ハードリンクで
  ないこと（O_NOFOLLOW・nlink=1）を確かめる。_kaburun は in に書けない（ACL）ので、自分でジョブを仕込めない。
- CLAIM は _kaburun が所有する claims フォルダに claims/<job_id>.claim を O_CREAT|O_EXCL|O_NOFOLLOW で作る。
  作成に成功＝今 CLAIM した。既にあれば二重＝受けない。O_EXCL が at-most-once の直列化点（GO の max_runs=1 と対）。
- 検証を通してから CLAIM する。失敗したジョブは CLAIM しない。いったん CLAIM したら、以降が失敗しても再実行しない
  （fail-closed・再試行なし。これも max_runs=1 と同じ考え）。
- ここでは実 CLI を起動しない。検証済みのジョブ・GO・要求・ソースの選び方を返すだけ（起動は GO ゲートの別段）。
"""
import os
import re
import stat
import time

from . import real_claude
from .fsutil import canonical, loads_strict, sha256_hex

# 署名の対象（sig を除く）。chainlog と同じく「sig 以外の全キーの canonical」に署名する
JOB_FIELDS = {"job_id", "go", "request", "issued_at", "expires_at", "role"}
REQUEST_FIELDS = {"approval_id", "task_sha256", "prompt", "base_ref", "base_sha"}
ALLOWED_JOB_ROLES = ("human",)  # ジョブを承認できる役割はこれだけ（人の承認）。role は検証する鍵を選ぶので load-bearing
_JOB_ID = re.compile(r"[A-Za-z0-9._-]{1,64}")
_SHA = re.compile(r"[0-9a-f]{64}")
_BASE_SHA = re.compile(r"[0-9a-f]{40}")


class HandoffError(ValueError):
    pass


class Decision:
    """受理の結果（fail-closed）。ok が False のときは reason に理由（起動しない）。"""

    def __init__(self, ok, reason=None, job=None, go=None, request=None, source_kind=None):
        self.ok = ok
        self.reason = reason
        self.job = job
        self.go = go
        self.request = request
        self.source_kind = source_kind  # "bundle" または "git"

    def __repr__(self):
        return "Decision(ok=%r, reason=%r, source_kind=%r)" % (self.ok, self.reason, self.source_kind)


def _is_number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _safe_source_dir(path):
    """ジョブの置き場（in）: 正規の絶対パスのフォルダで、グループ／他人が書けない。所有者は問わない（yuya 所有・ACL 前提）。"""
    if not (isinstance(path, str) and os.path.isabs(path) and os.path.realpath(path) == path):
        raise HandoffError("handoff dir must be a canonical absolute path (no symlinks anywhere)")
    st = os.lstat(path)
    if not stat.S_ISDIR(st.st_mode) or st.st_mode & 0o022:
        raise HandoffError("handoff dir must be a real directory not writable by group/other")


def _safe_owned_dir(path):
    """CLAIM の置き場（claims）: 正規の絶対パスで、この利用者（_kaburun）が所有し、グループ／他人が書けない。"""
    if not (isinstance(path, str) and os.path.isabs(path) and os.path.realpath(path) == path):
        raise HandoffError("claims dir must be a canonical absolute path (no symlinks anywhere)")
    st = os.lstat(path)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o022:
        raise HandoffError("claims dir must be a real directory owned by this user and not writable by group/other")


def _read_source_file(dir_path, filename):
    """in フォルダのジョブを安全に読む。basename のみ・O_NOFOLLOW・通常ファイル・ハードリンクなし・他者書き込み不可。"""
    if not (isinstance(filename, str) and filename and os.path.basename(filename) == filename
            and filename not in (".", "..")):
        raise HandoffError("job filename must be a bare basename")
    path = os.path.join(dir_path, filename)
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError as exc:
        raise HandoffError("cannot open job file: %s" % type(exc).__name__)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1 or st.st_mode & 0o022:
            raise HandoffError("job file must be a regular file with one link, not writable by group/other")
        chunks = []
        while True:
            chunk = os.read(fd, 65536)
            if not chunk:
                break
            chunks.append(chunk)
            if sum(len(c) for c in chunks) > 1 << 20:  # 1 MiB 上限（肥大化の拒否）
                raise HandoffError("job file is too large")
    finally:
        os.close(fd)
    return b"".join(chunks)


def _verify_job(raw, verifier, now):
    """生バイトを検証して、形の整ったジョブを返す。問題があれば HandoffError。CLAIM はしない。"""
    try:
        doc = loads_strict(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        raise HandoffError("job is not valid JSON")
    if not isinstance(doc, dict) or set(doc) != JOB_FIELDS | {"sig"}:
        raise HandoffError("job fields invalid")
    if not (isinstance(doc.get("job_id"), str) and _JOB_ID.fullmatch(doc["job_id"])):
        raise HandoffError("job_id invalid")
    for key in ("issued_at", "expires_at"):
        if not (_is_number(doc.get(key)) and doc[key] > 0):
            raise HandoffError("job %s invalid" % key)
    # 役割: ジョブを承認できるのは許可した役割だけ。role は検証に使う鍵を選ぶ（chainlog と同じ考え）
    role = doc.get("role")
    if role not in ALLOWED_JOB_ROLES:
        raise HandoffError("job role is not allowed to authorize a run")
    # 署名: sig を除いた canonical バイトに、その役割の鍵で署名されていること
    body = {k: v for k, v in doc.items() if k != "sig"}
    if not isinstance(doc.get("sig"), str) or not verifier.verify(role, canonical(body), doc["sig"]):
        raise HandoffError("job signature does not verify")
    # GO
    go = doc.get("go")
    if not isinstance(go, dict) or real_claude.go_problem(go) is not None:
        raise HandoffError("job GO is not a valid REAL_CLAUDE_GO")
    # 要求（実行に要る最小の項目）
    req = doc.get("request")
    if not isinstance(req, dict) or not (REQUEST_FIELDS <= set(req)):
        raise HandoffError("job request is missing required fields")
    if not (isinstance(req["approval_id"], str) and req["approval_id"]):
        raise HandoffError("request approval_id invalid")
    if not (isinstance(req["task_sha256"], str) and _SHA.fullmatch(req["task_sha256"])):
        raise HandoffError("request task_sha256 invalid")
    if not isinstance(req["prompt"], str):
        raise HandoffError("request prompt invalid")
    if not (isinstance(req["base_sha"], str) and _BASE_SHA.fullmatch(req["base_sha"])):
        raise HandoffError("request base_sha invalid")
    if not (isinstance(req["base_ref"], str) and req["base_ref"]):
        raise HandoffError("request base_ref invalid")
    # GO と要求の一致（find_go と同じ規則）
    if go["approval_id"] != req["approval_id"] or go["task_sha256"] != req["task_sha256"] \
            or go["body_sha256"] != sha256_hex(req["prompt"].encode("utf-8")):
        raise HandoffError("job GO does not match the request (approval/task/body)")
    # 期限（ジョブ・GO の両方が未来であること）
    if now >= doc["expires_at"] or now >= go["expires_at"]:
        raise HandoffError("job or GO has expired")
    return doc


class HandoffInbox:
    """_kaburun 側の受け口。in（yuya 所有・ACL 読み取り）と claims（_kaburun 所有）を分ける。"""

    def __init__(self, in_dir, claims_dir, verifier, now=time.time):
        _safe_source_dir(in_dir)
        _safe_owned_dir(claims_dir)
        self.in_dir = in_dir
        self.claims_dir = claims_dir
        self.verifier = verifier
        self.now = now

    def _claim(self, job_id):
        """at-most-once の CLAIM。今 CLAIM できたら True。既に CLAIM 済みなら False。"""
        if not _JOB_ID.fullmatch(job_id):
            raise HandoffError("job_id invalid")
        path = os.path.join(self.claims_dir, job_id + ".claim")
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        except FileExistsError:
            return False
        except OSError as exc:
            raise HandoffError("cannot create claim marker: %s" % type(exc).__name__)
        try:
            os.write(fd, canonical({"job_id": job_id, "claimed_at": self.now()}))
            os.fsync(fd)
        finally:
            os.close(fd)
        return True

    def accept(self, filename):
        """ジョブ1件を読み、検証し、CLAIM する。起動はしない。結果は Decision（fail-closed）。"""
        now = self.now()
        try:
            raw = _read_source_file(self.in_dir, filename)
            doc = _verify_job(raw, self.verifier, now)
        except HandoffError as exc:
            return Decision(False, reason=str(exc))
        # 検証を通ってから CLAIM（失敗したジョブは CLAIM しない）
        try:
            claimed = self._claim(doc["job_id"])
        except HandoffError as exc:
            return Decision(False, reason=str(exc))
        if not claimed:
            return Decision(False, reason="job already claimed (at-most-once)")
        source_kind = "bundle" if doc["go"].get("source_bundle") else "git"
        return Decision(True, job=doc, go=doc["go"], request=doc["request"], source_kind=source_kind)
