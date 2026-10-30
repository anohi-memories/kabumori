"""起動スタブ（実行側）: 起動トランザクション T2〜T9。仕様 v5.1 §1-3、v5.2 §1-2、v5.4 §2-1。

- T2: 登録簿に `starting`（識別子・期限）を、HALTの確認より先に書く。
- T3/T4: S1 の稼働確認・S2 のハートビートの確認ができるまで、偽Claudeを起動しない。
- T6: halt.lock の共有ロックを保持したまま、最終検証 → SPAWNING → 偽Claudeの起動 → `running` の記録
  までを行う（HALT・STOP・取消のイベント追記は排他ロック側なので、この間に割り込めない）。
"""
import json
import os
import stat
import subprocess
import sys
import time

from . import adapter as adapter_mod, binding, code_edit, issue as issue_mod, policy as policy_mod, procs, registry, state, supervise, wiring
from .agent import Agent
from .chainlog import ChainError
from .fsutil import FileLock, atomic_write_json, canonical, loads_strict, read_json, sha256_hex
from .layout import Layout

PACKAGE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REAPER_SCRIPT = os.path.join(PACKAGE_ROOT, "bin", "g10_reaper.py")


def _hooks(run_dir, policy):
    """試験用のフック（偽Claudeのアダプタのときだけ有効）。"""
    if policy.get("adapter") != "fake":
        return {}
    return read_json(os.path.join(run_dir, "test_hooks.json"), {}) or {}


def _hook(hooks, name, run_dir):
    h = hooks.get(name)
    if not h:
        return
    if h.get("mark"):
        with open(os.path.join(run_dir, "hook_%s.reached" % name), "w") as f:
            f.write(str(time.time()))
    if h.get("sleep"):
        time.sleep(float(h["sleep"]))
    if h.get("exit"):
        os._exit(int(h.get("code", 9)))


def _readonly_tree(path):
    """作業フォルダを読み取り専用にする。TASK 21: 実行ビットは保つ（落とすと git には変更に見え、Claude が「変更あり」と
    申告した）。シンボリックリンクは辿らない（リンク先の作業フォルダの外のファイルの権限を変えない）。"""
    for dirpath, dirnames, filenames in os.walk(path):
        for name in filenames:
            p = os.path.join(dirpath, name)
            if os.path.islink(p):
                continue
            mode = stat.S_IRUSR | stat.S_IRGRP
            if os.stat(p).st_mode & stat.S_IXUSR:
                mode |= stat.S_IXUSR | stat.S_IXGRP
            os.chmod(p, mode)
    for dirpath, dirnames, filenames in os.walk(path, topdown=False):
        os.chmod(dirpath, stat.S_IRUSR | stat.S_IXUSR | stat.S_IRGRP | stat.S_IXGRP)


def tree_digest(path):
    items = []
    for dirpath, dirnames, filenames in os.walk(path):
        dirnames.sort()
        for name in sorted(filenames):
            p = os.path.join(dirpath, name)
            with open(p, "rb") as f:
                items.append((os.path.relpath(p, path), sha256_hex(f.read()), oct(os.stat(p).st_mode & 0o777)))
        items.append((os.path.relpath(dirpath, path) + "/", "", oct(os.stat(dirpath).st_mode & 0o777)))
    return sha256_hex(canonical(items))


def _local_gate(agent, layout, req):
    """停止（HALT/STOP のログとフラグ）・要求の期限・認可（CONFIRM／ENVELOPE と失効）・取消・受理状態の判定。
    問題があれば理由を返す。最終判定の中で、Issue の再取得の前と後の2回行う（TASK 6）。"""
    try:
        st = agent.current_state(update_seen=True)
    except (ChainError, state.RewindError) as exc:
        return "control log invalid: %s" % exc
    if st.halted or state.flags_say_halt(layout):
        return "halted"
    if st.stopped or state.flags_say_stop(layout):
        return "stopped"
    local_now = time.time()
    if local_now >= req["expires_at"]:
        return "request expired"
    reference_now = req["reference_time"] + (local_now - req["issued_at"])
    if not state.authorization_ok(st, req, local_now, reference_now):
        return "not authorized at final check"
    if state.issue_revoked(st, req):
        return "issue revoked"
    try:  # TASK 16 R2: 今の設定・最新の承認・CLAIM 時の要求が一致すること（消失・差し替え・承認の乗り換えは起動しない）
        reason = wiring.check_run(layout.root, st, req)
    except Exception as exc:
        reason = "wiring check failed: %s" % type(exc).__name__
    if reason:
        return "wiring: " + reason
    if agent.used_state(req["run_id"]) != ["ACCEPTED"]:
        return "used_requests state is not ACCEPTED-only"
    return None


def final_check(agent, layout, req, policy):
    """臨界区間の中での最終判定（v5.4 §2-1）。問題があれば理由を返す。"""
    reason, _ = binding.check_request(req, policy)  # H3 R1: 承認済みTASK・ポリシーとの結合を再確認
    if reason:
        return reason
    reason = issue_mod.check_request_evidence(req, agent.verifier, policy, time.time(), agent.go_bodies())  # H4 P1
    if reason:
        return "issue binding: " + reason
    reason = _local_gate(agent, layout, req)
    if reason:
        return reason
    accepted = [r for r in agent.used.read_all() if r["type"] == "ACCEPTED" and r["payload"]["run_id"] == req["run_id"]]
    if len(accepted) != 1:
        return "used_requests state is not ACCEPTED-only"
    # TASK 5: ACCEPTED 後・起動直前に Issue #323 を再取得し、CLAIM 時から state・本文・世代が変わっていないこと。
    # CLAIM 時の（最大120秒前の）証拠は、起動時の最新性の証明として扱わない。取得の失敗・遅れも起動しない。
    try:
        witness = issue_mod.spawn_witness(layout.root, policy)
    except Exception as exc:  # TASK 15: 取得係を組み立てられない（設定・鍵・台帳の不備）なら起動しない
        return "issue witness unavailable at spawn: %s" % type(exc).__name__
    if witness is None:
        return "no spawn-time issue witness (real GitHub fetch is not implemented)"
    nonce = issue_mod.spawn_nonce(req, accepted[0]["event_id"])
    try:
        doc = witness.observe("spawn", nonce, timeout=policy_mod.timing(policy, "issue_fetch_timeout"))
    except Exception as exc:
        return "issue re-fetch failed at spawn: %s" % type(exc).__name__
    reason = issue_mod.check_spawn_evidence(doc, req["issue_evidence"], agent.verifier, req["prompt"], time.time(),
                                            policy_mod.timing(policy, "spawn_evidence_max_age"), nonce,
                                            accepted[0]["ts"], agent.go_bodies())
    if reason:
        return "issue changed or unverifiable at spawn: " + reason
    # TASK 6（H4 C4 P2）: 再取得は最大で issue_fetch_timeout 秒かかる。その間に HALT／STOP のフラグが立つ・
    # 要求の期限が過ぎる・認可が失効することがあるので、再取得の後に、現在時刻と最新の状態でもう一度判定する。
    # （HALT・STOP は、まずフラグを書いてから排他ロックを待つ。共有ロックを持つこのスタブはフラグで気づく。）
    reason = _local_gate(agent, layout, req)
    if reason:
        return reason
    atomic_write_json(os.path.join(layout.run_dir(req["run_id"]), "spawn_evidence.json"), doc)
    return None


def run(root, run_id):
    layout = Layout(root)
    policy = policy_mod.load(layout.policy_pub)
    signer, verifier = wiring.agent_side(root)
    agent = Agent(layout, signer, verifier, policy)
    run_dir = layout.run_dir(run_id)
    hooks = _hooks(run_dir, policy)
    doc = read_json(os.path.join(run_dir, "request.json"))
    req = doc["request"]
    if not verifier.verify("runner", canonical(req), doc["sig"]) or req["run_id"] != run_id:
        agent.mark("ABORTED", req, {"reason": "request signature invalid at stub"})
        return 3
    reason, fields = binding.check_request(req, policy)
    spec = None
    if not reason and fields.get("phase2_scope") == code_edit.SCOPE:  # TASK 26: 編集の範囲は承認済み本文から作る
        problems, spec = code_edit.spec_from_fields(fields, policy)
        reason = "code edit spec invalid: " + "; ".join(problems) if problems else None
    if not reason:
        reason = issue_mod.check_request_evidence(req, verifier, policy, time.time(), agent.go_bodies())
    if reason:
        agent.mark("ABORTED", req, {"reason": "request binding invalid at stub: " + reason})
        return 3
    if agent.used_state(run_id) != ["ACCEPTED"]:
        return 3  # 二度目のスタブ起動・再送では何もしない

    def abort(reason, entry_exists, state_name="aborted_before_spawn"):
        agent.mark("ABORTED", req, {"reason": reason})
        if entry_exists:
            try:
                registry.update(layout, run_id, state_name, abort_reason=reason)
            except registry.RegistryError:
                pass
        return 4

    # T2: 識別子と期限を、HALTの確認より先に登録する
    minutes = min(int(req["max_minutes"]), int(policy["timing"]["absolute_max_minutes"]))
    now = time.time()
    settings_path = os.path.join(run_dir, "settings.json")
    try:  # TASK 17: 実 Claude CLI は人の GO が一致するときだけ（それ以外は偽Claude か拒否）
        adapter = adapter_mod.get_adapter(policy, agent.current_state(update_seen=False), req)
    except Exception as exc:
        agent.mark("ABORTED", req, {"reason": "adapter unavailable: %s" % exc})
        return 4
    if spec and adapter.name != "claude_cli":
        agent.mark("ABORTED", req, {"reason": "code edits need the real CLI adapter with its sandbox"})
        return 4
    work_dir = layout.work_dir(run_id)
    edit = None
    if spec:  # サンドボックスの設定と許可ファイルの絶対パス（作業フォルダの準備の後に中身を確かめる）
        edit = {"abs_paths": [os.path.join(os.path.realpath(os.path.dirname(work_dir)), os.path.basename(work_dir), rel)
                              for rel in spec["paths"]],
                "profile_path": os.path.join(run_dir, "cli.sb"), "tmp_dir": os.path.realpath(run_dir) + "/cli-tmp",
                "home": os.path.realpath(run_dir) + "/cli-home"}  # TASK 33: 使い捨ての HOME
    atomic_write_json(settings_path, adapter.settings_doc(run_id, policy, edit))
    registry.create(layout, {
        "run_id": run_id, "session_id": req["session_id"], "settings_path": settings_path,
        "hard_deadline": now + minutes * policy_mod.timing(policy, "minute_seconds"),
        "policy_sha256": policy["_digest"], "request_id": req["request_id"],
        "approval_id": req["approval_id"], "task_id": req["task_id"], "task_sha256": req["task_sha256"],
        "uid": os.getuid(), "root": os.path.realpath(root),
        "stub_pid": os.getpid(), "stub_start": procs.start_time(os.getpid()), "created_at": now,
    })
    _hook(hooks, "after_T2", run_dir)

    # T3: S1 の稼働確認
    reaper = subprocess.Popen([sys.executable, "-I", REAPER_SCRIPT, "--root", root, "--run-id", run_id],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                              start_new_session=True, close_fds=True,
                              env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"})
    hb_path = os.path.join(run_dir, "reaper_heartbeat.json")
    entry = registry.load(layout, run_id)
    deadline = time.monotonic() + policy_mod.timing(policy, "reaper_confirm_timeout")
    confirmed = False
    while time.monotonic() < deadline:
        hb = read_json(hb_path)
        if hb and hb.get("pid") == reaper.pid and hb.get("loaded_deadline") == entry["hard_deadline"]:
            confirmed = True
            break
        time.sleep(0.05)
    if not confirmed:
        return abort("s1_unconfirmed", True)
    registry.update(layout, run_id, reaper_pid=reaper.pid, reaper_start=procs.start_time(reaper.pid))
    _hook(hooks, "after_T3", run_dir)

    # T4: S2 のハートビート
    if not supervise.s2_fresh(layout, policy):
        return abort("supervisor_unavailable", True)

    # 作業フォルダ（臨界区間の外で準備し、読み取り専用にする）
    try:
        adapter.source_preparer().prepare(work_dir, req["base_ref"], req["base_sha"])
    except Exception as exc:
        return abort("work dir preparation failed: %s" % type(exc).__name__, True)
    _readonly_tree(work_dir)
    if spec:  # TASK 26: 許可ファイルだけ書き込み可にし、実行前の一覧・元の中身・サンドボックスの設定を記録
        try:
            prepared = code_edit.prepare(work_dir, run_dir, spec, adapter.go["home"])
        except (code_edit.CodeEditError, OSError) as exc:
            return abort("code edit preparation failed: %s" % exc, True)
        if prepared["abs_paths"] != edit["abs_paths"] or prepared["tmp_dir"] != edit["tmp_dir"] \
                or prepared["home"] != edit["home"]:
            return abort("code edit paths differ after preparation", True)
        # TASK 30: 後のセッションに効く ~/.claude.json の項目の、実行前の指紋
        atomic_write_json(os.path.join(run_dir, "home_guard_pre.json"),
                          code_edit.home_guard(adapter.go["home"], work_dir))
    atomic_write_json(os.path.join(run_dir, "work_digest.json"), {"digest": tree_digest(work_dir)})
    prompt_path = os.path.join(run_dir, "prompt.md")
    with open(prompt_path, "w", encoding="utf-8") as f:
        f.write(req["prompt"])

    # T5: 早期確認（合図）
    if state.flags_say_halt(layout):
        return abort("halted_early", True)
    _hook(hooks, "before_T6a", run_dir)

    scenario_path = os.path.join(run_dir, "scenario.json")
    scenario_path = scenario_path if os.path.exists(scenario_path) else None
    # T6a〜T8: 共有ロックを保持したまま、最終検証から起動の確定まで
    with FileLock(layout.halt_lock, "sh", timeout=None,
                  abort_check=lambda: state.flags_say_halt(layout)) as lock:
        if not lock.acquired:
            return abort("halted_while_waiting_for_lock", True, "aborted_by_halt")
        reason = final_check(agent, layout, req, policy)
        if reason:
            return abort(reason, True, "aborted_by_halt" if reason == "halted" else "aborted_before_spawn")
        agent.mark("SPAWNING", req)
        # TASK 17: 実 CLI は起動の直前に再検証（起動待ちちょうど1件・CLI の実体と版・計画・環境・GO の期限）
        reason = adapter.prelaunch(req, prompt_path, settings_path, agent.used_state(run_id), edit=edit)
        if reason:
            return abort("prelaunch check failed: " + reason, True)
        _hook(hooks, "before_spawn", run_dir)
        out = open(os.path.join(run_dir, "claude.stdout"), "wb")
        err = open(os.path.join(run_dir, "claude.stderr"), "wb")
        stdin = open(prompt_path, "rb") if adapter.uses_stdin else subprocess.DEVNULL
        try:
            child = subprocess.Popen(adapter.command(req, prompt_path, settings_path, edit),
                                     env=adapter.environment(scenario_path, edit), cwd=work_dir,
                                     stdin=stdin, stdout=out, stderr=err, close_fds=True)
        finally:
            out.close()
            err.close()
            if stdin is not subprocess.DEVNULL:
                stdin.close()
        child_start = procs.start_time(child.pid)
        registry.update(layout, run_id, "running", child_pid=child.pid, child_start=child_start,
                        child_pgid=os.getpgid(0), spawned_at=time.time())
        agent.mark("SPAWNED", req, {"pid": child.pid})
        _hook(hooks, "after_spawn", run_dir)

    # T9: 解放後の再確認（保険）
    if supervise.hard_halt_requested(layout, agent):
        entry = registry.load(layout, run_id)
        collect = supervise.collector(layout, entry)
        own = os.getpid()
        only_run = (lambda: {p: s for p, s in collect().items() if p != own})  # 自分自身（スタブ）は止めない
        only_run.verify = collect.verify
        details = procs.terminate(only_run, policy_mod.timing(policy, "grace_seconds"),
                                  policy_mod.timing(policy, "confirm_seconds"))
        absent = details["absent"] and not details["unknown"]
        try:
            registry.update(layout, run_id, "interrupted" if absent else "stop_unconfirmed",
                            stop_reason="emergency_stop", stop_by="stub_T9", stop_details=details)
        except registry.RegistryError:
            pass
        if not absent:
            agent.halt_agent("stop_unconfirmed", {"run_id": run_id, "by": "stub_T9"})

    rc = child.wait()
    with open(os.path.join(run_dir, "claude.stdout"), "rb") as f:
        raw = f.read()
    parsed = None
    try:
        parsed = loads_strict(raw.decode("utf-8")) if raw else None
    except (ValueError, UnicodeDecodeError):
        parsed = None
    atomic_write_json(os.path.join(run_dir, "result.json"), {
        "exit_code": rc, "raw_sha256": sha256_hex(raw), "parsed": parsed, "ended_at": time.time()})
    if spec:  # TASK 26: 照合が通り、変更があるときだけ、承認されたテストを実行係が実行する（判定は finalize が再計算）
        # TASK 30: 照合の前に、残りのプロセスを止め、親フォルダを封印し、~/.claude.json の指紋を取る
        code_edit.finish_cli(work_dir, run_dir, adapter.go["home"])
        check = code_edit.verify(work_dir, run_dir, spec)
        atomic_write_json(os.path.join(run_dir, "edit_check.json"), check)
        if rc == 0 and not check["violations"] and check["changed_lines"] > 0:
            try:
                code_edit.run_test(spec, work_dir, run_dir)
            except (OSError, ValueError) as exc:
                atomic_write_json(os.path.join(run_dir, "test_result.json"), {"error": type(exc).__name__})
    entry = registry.load(layout, run_id)
    if entry["state"] == "running":
        registry.update(layout, run_id, "exited", exit_code=rc, ended_at=time.time())
    return 0


def main(argv=None):
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("--root", required=True)
    p.add_argument("--run-id", required=True)
    a = p.parse_args(argv)
    return run(a.root, a.run_id)
