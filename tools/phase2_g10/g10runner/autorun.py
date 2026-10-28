"""無人の検知と、監督付きの1回起動（TASK 21）。

Issue #323 をログインなしで周期的に読み、次の条件がすべてそろったときだけ、手動の `run` と同じ経路で1回起動する。

1. HALT・STOP のフラグも、制御ログの未解決の HALT も無い
2. Issue が OPEN で、本文が自動実行できる Phase 2 TASK（meta.validate_task。ポリシーのハッシュも一致）
3. その approval_id がまだ CLAIM されていない（1つの承認で起動は1回）
4. 人の署名の REAL_CLAUDE_GO が、この本文の SHA-256 に結び付いていて期限内（人の承認なしには起動しない）
5. S2 の見張り役の生存の記録が新しい
6. GO で固定した CLI の実体が変わっておらず、子と同じ環境で `auth status` がログイン済み（モデルを呼ばない）

- 判定（evaluate）は起動しない。起動（launch）は CLAIM → 受理 → スタブ → 終了待ち → finalize で、手動の run と共通。
- 判定・起動の記録は control/priv/autorun.log（1行1件の JSON）。本文・秘密・メールアドレスは書かない。
- 常駐（launchd への登録）はここでは行わない。登録は人の明示の GO の後に、人が行う。
"""
import json
import os
import time

from . import ecdsa_signing as ec, meta, policy as policy_mod, real_claude, registry, state, supervise, wiring
from .agent import Agent
from .control import Control
from .fsutil import sha256_hex
from .layout import Layout

MIN_LIVE_INTERVAL = 300.0  # 認証なしの REST（60回/時×0.5）の中に、S1・S2 の取得と合わせて収まる間隔
LAUNCH_WAIT_SECONDS = 600


def open_control(root):
    """ルートの鍵・wiring.json・ポリシーから制御側を開く（手動の手順コマンドと共通）。"""
    keys = os.path.join(root, "keys")
    cfg = wiring.load(root)
    signer = ec.EcdsaSigner({"runner": os.path.join(keys, "runner.key"), "human": os.path.join(keys, "human.key")})
    layout = Layout(root)
    policy = policy_mod.load(layout.policy_pub)
    return Control(layout, signer, wiring.verifier(root, cfg), policy, witness=wiring.witness(root, cfg, policy)), policy


def usable_go(control, body, now):
    """この本文の SHA-256 に結び付いた、期限内の REAL_CLAUDE_GO（無ければ None）。"""
    body_sha = sha256_hex(body.encode("utf-8"))
    for go in reversed(control.read_state().real_gos):
        if go["body_sha256"] == body_sha and now < go["expires_at"]:
            return go
    return None


def claimed_approvals(control):
    return {r["payload"]["approval_id"] for r in control.ledger.read_all() if r["type"] == "CLAIM"}


def fetch(control, policy):
    return control.witness.source.fetch(timeout=policy_mod.timing(policy, "issue_fetch_timeout"))


def evaluate(control, policy, now=None, auth_fn=real_claude.auth_status):
    """起動してよいかの判定（起動はしない）。{"decision": "launch"|"wait"|"idle", "reason": ..., ...}。

    wait は人や監督の側の準備待ち、idle は起動するものが無い。launch のときだけ snap（取得した Issue）と go を含む。"""
    now = time.time() if now is None else now
    layout = control.layout
    if state.flags_say_halt(layout) or control.read_state().halted:
        return {"decision": "wait", "reason": "halted"}
    if state.flags_say_stop(layout):
        return {"decision": "wait", "reason": "stopped"}
    snap = fetch(control, policy)
    if snap.get("state") != "OPEN":
        return {"decision": "idle", "reason": "issue is not open"}
    result = meta.validate_task(snap["body"], policy)
    if not result.ok:
        return {"decision": "idle", "reason": "no runnable phase2 task", "problems": result.problems[:3]}
    approval_id = result.fields["phase2_approval_id"]
    out = {"approval_id": approval_id, "body_sha256": sha256_hex(snap["body"].encode("utf-8"))}
    if approval_id in claimed_approvals(control):
        return dict(out, decision="idle", reason="approval already used")
    go = usable_go(control, snap["body"], now)
    if go is None:
        return dict(out, decision="wait", reason="waiting for a human REAL_CLAUDE_GO for this body")
    if not supervise.s2_fresh(layout, policy, now):
        return dict(out, decision="wait", reason="S2 watchdog heartbeat is not fresh")
    if os.path.realpath(go["cli_realpath"]) != go["cli_realpath"]:
        return dict(out, decision="wait", reason="CLI path changed after the GO")
    auth = auth_fn(go["cli_realpath"], go["home"])
    out["auth"] = auth
    if auth["logged_in"] is not True:
        return dict(out, decision="wait", reason="CLI is not logged in in the child environment")
    return dict(out, decision="launch", reason="ready", snap=snap, go=go)


def launch(control, policy, snap, out=print):
    """CLAIM → 受理 → スタブの起動 → 終了待ち → finalize（手動の run と共通）。{"run_id", "status", ...} を返す。"""
    issue_meta = {"state": snap["state"], "number": snap["number"], "author": snap["author"], "editor": None}
    run_id, reason = control.try_claim(snap["body"], issue_meta, time.time())
    if run_id is None:
        return {"run_id": None, "status": "not_claimed", "reason": reason}
    signer, verifier = wiring.agent_side(control.layout.root)
    agent = Agent(control.layout, signer, verifier, policy)
    stub, reason = agent.handle_request_file(control.layout.request_file(run_id))
    if stub is None:
        return {"run_id": run_id, "status": "not_accepted", "reason": reason}
    out(json.dumps({"run_id": run_id, "stub_pid": stub.pid, "note": "waiting for the run to end"}))
    stub.wait()
    deadline = time.time() + LAUNCH_WAIT_SECONDS
    while time.time() < deadline:
        e = registry.load(control.layout, run_id)
        if e and e["state"] not in registry.NON_TERMINAL:
            break
        time.sleep(1)
    status, _end = control.finalize(run_id, current_body=snap["body"])
    return {"run_id": run_id, "status": status, "used_states": agent.used_state(run_id),
            "report": os.path.join(control.layout.reports, run_id + ".md")}


def log_path(layout):
    return os.path.join(layout.root, "control", "priv", "autorun.log")


def record(layout, entry):
    """判定・起動の記録（本文・秘密・メールアドレスを含めない項目だけ）。"""
    keep = {k: entry[k] for k in ("decision", "reason", "approval_id", "body_sha256", "run_id", "status", "mode",
                                   "error", "problems") if k in entry}
    if "auth" in entry:
        keep["logged_in"] = entry["auth"].get("logged_in")
    keep["ts"] = time.time()
    with open(log_path(layout), "a", encoding="utf-8") as f:
        f.write(json.dumps(keep, ensure_ascii=False, sort_keys=True) + "\n")
    return keep


def cycle(control, policy, live, auth_fn=real_claude.auth_status, out=print):
    """1回分の検知。live のときだけ起動する。記録した内容を返す。取得の失敗などは起動せずに記録する。"""
    try:
        d = evaluate(control, policy, auth_fn=auth_fn)
    except Exception as exc:  # ネットワーク・ログの読み取りの失敗は「起動しない」
        return record(control.layout, {"decision": "wait", "reason": "evaluation failed", "error": type(exc).__name__})
    if d["decision"] != "launch":
        return record(control.layout, d)
    if not live:
        return record(control.layout, dict(d, decision="dry_run", reason="would launch (dry run: not started)"))
    result = launch(control, policy, d["snap"], out=out)
    return record(control.layout, dict(d, decision="launched", reason=result.get("reason", "launched"),
                                       run_id=result["run_id"], status=result["status"]))
