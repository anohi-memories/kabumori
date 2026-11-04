"""無人 producer（専用ユーザー分割の yuya 側・B6）。

有効な ENVELOPE（人が日次で承認する同意の窓）の下で、Issue #323 の ready・未claim・窓内の phase2 TASK を
**署名ジョブ**として handoff/in へ emit する。実行は exec の resident（固定版）。per-run の人 GO は要らない
（ENVELOPE が同意境界。envelope_covers が scope/model/effort/分数/予算/base_ref/policy/NO_GO/local_only を窓に限定）。

冪等: 既に claim 済みの approval は出さない（同じ TASK を二重に走らせない）。HALT/STOP・ENVELOPE 無しでは何もしない。
実 Claude は呼ばない（起動は exec）。autorun（単一プロセス）の評価を流用し、launch の代わりに emit する。
"""
import json
import os
import time

from . import autorun, emit, meta, source_bundle, state
from .fsutil import sha256_hex

MIN_INTERVAL = 300.0  # 認証なし REST の枠に S1/S2 と合わせて収める下限（autorun と同じ）


def log_path(layout):
    return os.path.join(layout.root, "control", "priv", "producer.log")


def trial_envelope_params(policy, max_minutes=120, max_budget=0.50):
    """readonly_trial 日次窓の envelope params（単一の正本）。変更・書き込み・本番は窓に入れない。
    手動の approve-envelope とダイアログ発行の両方がこれを使い、scope がドリフトしないようにする。"""
    return {"scopes": ["readonly_trial"], "models": dict(policy["models"]),
            "efforts": ["low", "medium", "high"], "max_minutes_cap": int(max_minutes),
            "max_budget_cap": float(max_budget), "base_ref_prefixes": ["refs/heads/"],
            "policy_sha256": policy["_digest"]}


def approve_trial_envelope(control, policy, max_minutes=120, max_budget=0.50):
    """readonly_trial の日次窓（翌 04:00 JST 失効）を人の署名で承認する。
    **呼び出し側は人の明示的な同意（確認ダイアログの「許可」クリック等）を得てから呼ぶこと。**"""
    control.approve_envelope(trial_envelope_params(policy, max_minutes, max_budget))
    return control.read_state().envelope


def record(layout, entry):
    """判定・emit の記録（本文・秘密・メールアドレスを含めない項目だけ）。"""
    keep = {k: entry[k] for k in ("decision", "reason", "approval_id", "body_sha256", "run_id", "job_path", "error")
            if k in entry}
    keep["ts"] = time.time()
    with open(log_path(layout), "a", encoding="utf-8") as f:
        f.write(json.dumps(keep, ensure_ascii=False, sort_keys=True) + "\n")
    return keep


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


def collect_once(control, out_dir, write):
    """handoff/out を1回走査し、CLAIM 済み未終了の run を閉じる。結果バンドルがあれば ingest→finalize(ingested)、
    disposition だけ（exec 拒否/不在）なら close_absent で枠を解放、どちらも無ければ pending。結果の dict リストを返す。
    write=False は予定の表示のみ（台帳に書かない）。cmd_collect と無人 collector の共通処理。"""
    from . import result_handoff
    from .fsutil import read_json
    recs = control.ledger.read_all()
    ended = {r["payload"]["run_id"] for r in recs if r["type"] == "END"}
    claimed = [r["payload"]["run_id"] for r in control._claims(recs) if r["payload"]["run_id"] not in ended]
    results = []
    for run_id in claimed:
        bundle_manifest = os.path.join(out_dir, run_id, result_handoff.MANIFEST)
        disposition = os.path.join(out_dir, run_id + ".json")
        if os.path.exists(bundle_manifest):
            if write:
                result_handoff.ingest_result(out_dir, run_id, control.layout, control.verifier)
                status, _end = control.finalize(run_id, ingested=True)
                results.append({"run_id": run_id, "action": "ingest_finalize", "status": status,
                                "report": os.path.join(control.layout.reports, run_id + ".md")})
            else:
                results.append({"run_id": run_id, "action": "ingest_finalize", "written": False})
        elif os.path.exists(disposition):
            reason = "no result bundle in handoff/out (exec did not accept)"
            try:
                d = read_json(disposition)
                if isinstance(d, dict) and d.get("reason"):
                    reason = "exec %s: %s" % (d.get("status"), d.get("reason"))
            except Exception:
                pass
            if write:
                control.close_absent(run_id, reason)
                results.append({"run_id": run_id, "action": "reconcile_absent", "reason": reason})
            else:
                results.append({"run_id": run_id, "action": "reconcile_absent", "reason": reason, "written": False})
        else:
            results.append({"run_id": run_id, "action": "pending", "note": "no disposition yet"})
    return results


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
