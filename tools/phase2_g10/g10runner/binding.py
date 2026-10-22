"""起動要求と、承認済みTASK・インストール済みポリシーの結合の検証。H3 レビュー R1 の修正。

runner の署名は「制御側が発行した」ことしか示さない。実行側は制御側を信用せず（仕様 v5.3 §2-3）、
要求の中の prompt（TASK本文）を自分で再検証・再ハッシュし、要求の実行項目がすべて、
その正式メタデータ・人の承認（CONFIRM の task_sha256／ENVELOPE の範囲）・インストール済みポリシーと
一致することを確認する。runner の鍵だけでは、内容（本文・モデル・予算・時間・範囲・本番権限・基点・
承認ID）を変えたり広げたりできない。

型・形式・数値・時刻・パスの包含も、ACCEPTED・ファイルの書き込み・起動の前に検証する。
"""
import re

from . import meta, norm
from .layout import RUN_ID_RE

REQUEST_ID_RE = re.compile(r"^req-[0-9a-f]{16}$")
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
ENVELOPE_ID_RE = re.compile(r"^env-[0-9a-f]{12}$")

# 要求の項目 → 正式メタデータの項目
EXEC_FIELDS = (
    ("approval_id", "phase2_approval_id"),
    ("task_id", "task_id"),
    ("model", "model"),
    ("model_id", "phase2_model_id"),
    ("effort", "effort"),
    ("max_minutes", "max_minutes"),
    ("max_budget_usd", "max_budget_usd"),
    ("base_ref", "base_ref"),
    ("base_sha", "base_sha"),
    ("phase2_scope", "phase2_scope"),
    ("production_permission", "production_permission"),
    ("report_mode", "phase2_report_mode"),
)
STRING_FIELDS = ("request_id", "run_id", "approval_id", "task_id", "session_id", "task_sha256", "prompt",
                 "base_ref", "base_sha", "model", "model_id", "effort", "max_minutes", "max_budget_usd",
                 "policy_sha256", "authorization", "phase2_scope", "production_permission", "report_mode")
NUMBER_FIELDS = ("issued_at", "reference_time", "expires_at")


def _is_number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def check_request(req, policy):
    """問題があれば理由（文字列）を返す。問題なければ (None, 正式メタデータ)。"""
    if not isinstance(req, dict):
        return "request is not an object", None
    for key in STRING_FIELDS:
        if not isinstance(req.get(key), str):
            return "request field has wrong type: " + key, None
    for key in NUMBER_FIELDS:
        if not _is_number(req.get(key)):
            return "request field has wrong type: " + key, None
    if not (isinstance(req.get("claim_seq"), int) and not isinstance(req.get("claim_seq"), bool)
            and req["claim_seq"] >= 1):
        return "request field has wrong type: claim_seq", None
    if not RUN_ID_RE.match(req["run_id"]):
        return "invalid run_id", None
    if not REQUEST_ID_RE.match(req["request_id"]):
        return "invalid request_id", None
    if not UUID_RE.match(req["session_id"]):
        return "invalid session_id", None
    if req["authorization"] not in ("confirm", "envelope"):
        return "invalid authorization mode", None
    if req["authorization"] == "envelope" and not (isinstance(req.get("envelope_id"), str)
                                                   and ENVELOPE_ID_RE.match(req["envelope_id"])):
        return "invalid envelope_id", None
    ttl = float(policy["timing"]["request_ttl"])
    if not (req["issued_at"] < req["expires_at"] <= req["issued_at"] + ttl + 1e-6):
        return "invalid request validity window", None
    if req["policy_sha256"] != policy["_digest"]:
        return "policy digest mismatch", None
    if not isinstance(req.get("issue_evidence"), dict):
        return "request field has wrong type: issue_evidence", None  # 内容の検証は issue.check_request_evidence

    # 本文を自分で検証し、再ハッシュする
    result = meta.validate_task(req["prompt"], policy)
    if not result.ok:
        return "prompt is not a valid approved TASK: " + "; ".join(result.problems[:5]), None
    try:
        computed = norm.compute_hash(req["prompt"])
    except norm.NormError as exc:
        return "prompt hash: %s" % exc, None
    fields = result.fields
    if computed != fields["phase2_task_sha256"] or computed != req["task_sha256"]:
        return "prompt hash does not match the approved task hash", None
    for req_key, meta_key in EXEC_FIELDS:
        if req[req_key] != fields[meta_key]:
            return "request field differs from the approved TASK: " + req_key, None
    if policy.get("models", {}).get(req["model"]) != req["model_id"]:
        return "model_id is not the policy model for this alias", None
    return None, fields


def request_matches_claim(req, claim_payload):
    """終了判定（finalize）用: 要求が、制御側の台帳に記録した CLAIM（承認済みの内容）と一致するか。"""
    keys = ("run_id", "request_id", "approval_id", "task_id", "task_sha256", "model", "model_id", "effort",
            "max_minutes", "max_budget_usd", "base_ref", "base_sha", "policy_sha256")
    if not all(req.get(k) == claim_payload.get(k) for k in keys):
        return False
    from . import issue
    ev = req.get("issue_evidence")
    return isinstance(ev, dict) and issue.evidence_digest(ev) == claim_payload.get("issue_evidence_sha256")
