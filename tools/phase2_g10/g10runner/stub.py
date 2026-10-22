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

from . import adapter as adapter_mod, binding, ifaces, issue as issue_mod, policy as policy_mod, procs, registry, signing, state, supervise
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
    for dirpath, dirnames, filenames in os.walk(path):
        for name in filenames:
            os.chmod(os.path.join(dirpath, name), stat.S_IRUSR | stat.S_IRGRP)
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


def final_check(agent, layout, req, policy):
    """臨界区間の中での最終判定（v5.4 §2-1）。問題があれば理由を返す。"""
    reason, _ = binding.check_request(req, policy)  # H3 R1: 承認済みTASK・ポリシーとの結合を再確認
    if reason:
        return reason
    reason = issue_mod.check_request_evidence(req, agent.verifier, policy, time.time())  # H4 P1
    if reason:
        return "issue binding: " + reason
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
    if agent.used_state(req["run_id"]) != ["ACCEPTED"]:
        return "used_requests state is not ACCEPTED-only"
    return None


def run(root, run_id):
    layout = Layout(root)
    policy = policy_mod.load(layout.policy_pub)
    signer, verifier = signing.agent_side(root)
    agent = Agent(layout, signer, verifier, policy)
    run_dir = layout.run_dir(run_id)
    hooks = _hooks(run_dir, policy)
    doc = read_json(os.path.join(run_dir, "request.json"))
    req = doc["request"]
    if not verifier.verify("runner", canonical(req), doc["sig"]) or req["run_id"] != run_id:
        agent.mark("ABORTED", req, {"reason": "request signature invalid at stub"})
        return 3
    reason, _ = binding.check_request(req, policy)
    if not reason:
        reason = issue_mod.check_request_evidence(req, verifier, policy, time.time())
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
    atomic_write_json(settings_path, {"g10_run": run_id, "tools": ["Read", "Glob", "Grep"],
                                      "policy_sha256": policy["_digest"]})
    registry.create(layout, {
        "run_id": run_id, "session_id": req["session_id"], "settings_path": settings_path,
        "hard_deadline": now + minutes * policy_mod.timing(policy, "minute_seconds"),
        "policy_sha256": policy["_digest"], "request_id": req["request_id"],
        "approval_id": req["approval_id"], "task_id": req["task_id"],
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
    work_dir = layout.work_dir(run_id)
    ifaces.FakeSourcePreparer().prepare(work_dir, req["base_ref"], req["base_sha"])
    _readonly_tree(work_dir)
    atomic_write_json(os.path.join(run_dir, "work_digest.json"), {"digest": tree_digest(work_dir)})
    prompt_path = os.path.join(run_dir, "prompt.md")
    with open(prompt_path, "w", encoding="utf-8") as f:
        f.write(req["prompt"])

    # T5: 早期確認（合図）
    if state.flags_say_halt(layout):
        return abort("halted_early", True)
    _hook(hooks, "before_T6a", run_dir)

    adapter = adapter_mod.get_adapter(policy)
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
        _hook(hooks, "before_spawn", run_dir)
        out = open(os.path.join(run_dir, "claude.stdout"), "wb")
        err = open(os.path.join(run_dir, "claude.stderr"), "wb")
        try:
            child = subprocess.Popen(adapter.command(req, prompt_path, settings_path),
                                     env=adapter.environment(scenario_path), cwd=work_dir,
                                     stdout=out, stderr=err, close_fds=True)
        finally:
            out.close()
            err.close()
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
