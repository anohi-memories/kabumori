"""無人 producer（専用ユーザー分割の yuya 側・B6）。

有効な ENVELOPE（人が日次で承認する同意の窓）の下で、Issue #323 の ready・未claim・窓内の phase2 TASK を
**署名ジョブ**として handoff/in へ emit する。実行は exec の resident（固定版）。per-run の人 GO は要らない
（ENVELOPE が同意境界。envelope_covers が scope/model/effort/分数/予算/base_ref/policy/NO_GO/local_only を窓に限定）。

冪等: 既に claim 済みの approval は出さない（同じ TASK を二重に走らせない）。HALT/STOP・ENVELOPE 無しでは何もしない。
実 Claude は呼ばない（起動は exec）。autorun（単一プロセス）の評価を流用し、launch の代わりに emit する。
"""
import time

from . import autorun, emit, meta, source_bundle, state
from .fsutil import sha256_hex


def _probe(fields):
    """envelope_covers に渡す、起動要求相当の最小 dict（承認済み TASK の値から作る）。"""
    return {"phase2_scope": fields["phase2_scope"], "model": fields["model"],
            "model_id": fields["phase2_model_id"], "effort": fields.get("effort"),
            "max_minutes": fields["max_minutes"], "max_budget_usd": fields["max_budget_usd"],
            "base_ref": fields["base_ref"], "policy_sha256": fields["phase2_policy_sha256"],
            "production_permission": fields["production_permission"],
            "report_mode": fields.get("phase2_report_mode")}


def evaluate(control, policy, now=None):
    """emit してよいかの判定（emit はしない）。{"decision": "emit"|"idle"|"wait", "reason": ...}。
    emit のときだけ snap（取得した Issue）と fields を含む。per-run GO ではなく、有効 ENVELOPE を同意の根拠にする。"""
    now = time.time() if now is None else now
    layout = control.layout
    st = control.read_state()
    if state.flags_say_halt(layout) or st.halted:
        return {"decision": "wait", "reason": "halted"}
    if state.flags_say_stop(layout):
        return {"decision": "wait", "reason": "stopped"}
    if not st.envelope:  # 無人課金（MAX 利用枠の消費）は人の日次 ENVELOPE が無ければ一切しない
        return {"decision": "idle", "reason": "no active envelope (human daily consent window)"}
    snap = autorun.fetch(control, policy)
    if snap.get("state") != "OPEN":
        return {"decision": "idle", "reason": "issue is not open"}
    result = meta.validate_task(snap["body"], policy)
    if not result.ok:
        return {"decision": "idle", "reason": "no runnable phase2 task", "problems": result.problems[:3]}
    fields = result.fields
    approval_id = fields["phase2_approval_id"]
    out = {"approval_id": approval_id, "body_sha256": sha256_hex(snap["body"].encode("utf-8"))}
    if approval_id in autorun.claimed_approvals(control):
        return dict(out, decision="idle", reason="approval already used")
    if not state.envelope_covers(st.envelope, _probe(fields)):
        return dict(out, decision="idle", reason="task is outside the active envelope")
    return dict(out, decision="emit", reason="ready", snap=snap, fields=fields)


def emit_ready(control, policy, in_dir, bundles_dir, source_repo, cli_realpath, home,
               max_turns=30, expires_in=3600.0, job_ttl=1800.0, now=None):
    """評価して emit できるなら、source bundle を作り GO を組み、ENVELOPE 認可で署名ジョブを handoff/in へ置く。
    emit しなければ評価結果をそのまま返す（idle/wait）。emit したら run_id/job_path を加えて返す。"""
    now = time.time() if now is None else now
    decision = evaluate(control, policy, now=now)
    if decision["decision"] != "emit":
        return decision
    fields = decision["fields"]
    body = decision["snap"]["body"]
    bundle = source_bundle.make_source_bundle(source_repo, fields["base_sha"], bundles_dir,
                                              fields["phase2_approval_id"])
    go = emit.build_go(fields, body, cli_realpath, home, source_repo, bundle, now + expires_in, max_turns)
    snap = decision["snap"]
    issue_meta = {"state": snap["state"], "number": snap["number"], "author": snap["author"], "editor": None}
    res = emit.emit_job(control, body, issue_meta, now, go, in_dir, job_ttl=job_ttl)
    return dict(decision, bundle=bundle, **res)
