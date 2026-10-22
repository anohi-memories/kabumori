"""監督機構: 停止（stop_run）・S1（ランごとの reaper）・S2（watchdog）。仕様 v5.1 §2・v5.2 §1-4・v5.4 §3。"""
import json
import os
import time

from . import policy as policy_mod, procs, registry, state
from .chainlog import ChainError
from .fsutil import atomic_write_json, read_json


def supervisor_log(layout, record):
    with open(layout.supervisor_log, "a", encoding="utf-8") as f:
        f.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
        f.flush()
        os.fsync(f.fileno())


def write_s2_heartbeat(layout, now=None):
    atomic_write_json(layout.s2_heartbeat, {"pid": os.getpid(), "start": procs.start_time(os.getpid()),
                                            "ts": time.time() if now is None else now})


def heartbeat_fresh(path, max_age, now=None):
    """新しく、記録された pid・開始時刻のプロセスが生存しているときだけ True（観測できなければ False）。"""
    hb = read_json(path)
    if not hb:
        return False
    now = time.time() if now is None else now
    if now - float(hb.get("ts", 0)) > max_age:
        return False
    try:
        return procs.identity_ok(hb.get("pid"), hb.get("start"))
    except procs.ObservationError:
        return False


def s2_fresh(layout, policy, now=None):
    return heartbeat_fresh(layout.s2_heartbeat, policy_mod.timing(policy, "s2_heartbeat_max_age"), now)


def collector(layout, entry):
    """停止の対象を集める関数を返す（H3 R3）: 正確な識別子に一致するランのプロセスと、
    識別（pid・開始時刻・uid・`--run-id`・`--root`）が一致した起動スタブだけ。観測できなければ例外。"""
    ident = registry.identity(entry)

    def collect():
        targets = {}
        stub_pid, stub_start = entry.get("stub_pid"), entry.get("stub_start")
        if stub_pid and stub_start and procs.stub_matches(stub_pid, stub_start, entry["run_id"],
                                                          entry["root"], entry["uid"]):
            targets[stub_pid] = stub_start  # 先頭: 親（スタブ）を先に止め、子の終了を「exited」と記録させない
        for pid, start in procs.find_run_processes(ident):
            targets.setdefault(pid, start)
        return targets
    return collect


def run_processes_present(layout, entry):
    """識別子に一致するプロセスがあるか。True／False、観測できなければ None。"""
    try:
        return bool(collector(layout, entry)())
    except procs.ObservationError:
        return None


def stop_run(layout, policy, agent, entry, reason, by):
    """識別を確認してから停止し、不在を確認する。確認できない（観測不能を含む）なら stop_unconfirmed と HALT_AGENT。"""
    details = procs.terminate(collector(layout, entry), policy_mod.timing(policy, "grace_seconds"),
                              policy_mod.timing(policy, "confirm_seconds"))
    absent = details["absent"] and not details["unknown"]
    run_id = entry["run_id"]
    if absent:
        target = "runner_crashed" if reason.startswith("runner_crashed") else "interrupted"
        try:
            registry.update(layout, run_id, target, stop_reason=reason, stop_by=by, stop_details=details,
                            stopped_at=time.time())
        except registry.RegistryError:
            pass
    else:
        try:
            registry.update(layout, run_id, "stop_unconfirmed", stop_reason=reason, stop_by=by,
                            stop_details=details, stopped_at=time.time())
        except registry.RegistryError:
            pass
        if agent is not None:
            agent.halt_agent("stop_unconfirmed", {"run_id": run_id, "remaining": details.get("remaining"),
                                                  "observation_unknown": details.get("unknown")})
    supervisor_log(layout, {"run_id": run_id, "by": by, "reason": reason, "absent": absent,
                            "ts": time.time(), "details": details})
    return absent


def hard_halt_requested(layout, agent):
    """フラグ（合図）とログ（正本）の両方を見る。どちらかがハードHALTなら True（安全側）。"""
    flag = read_json(layout.halt_flag)
    if flag is not None and (not isinstance(flag, dict) or flag.get("kind", "hard") == "hard"):
        return True
    if os.path.exists(layout.agent_halt_flag):
        return True
    if agent is None:
        return False
    try:
        return agent.current_state(update_seen=False).hard_halted
    except (ChainError, state.RewindError):
        return True


def reaper_loop(layout, policy, agent, run_id):
    """S1: 1つのランを期限まで監督する。実行係（スタブ）から独立したプロセスで動く。"""
    interval = policy_mod.timing(policy, "reaper_interval")
    hb_path = os.path.join(layout.run_dir(run_id), "reaper_heartbeat.json")
    started = time.time()
    while True:
        try:
            entry = registry.load(layout, run_id)
        except registry.RegistryError as exc:
            agent.halt_agent("registry_inconsistent", {"run_id": run_id, "error": str(exc)})
            return 2
        if entry is None:
            return 2
        atomic_write_json(hb_path, {"pid": os.getpid(), "start": procs.start_time(os.getpid()),
                                    "ts": time.time(), "run_id": run_id,
                                    "loaded_deadline": entry["hard_deadline"]})
        st = entry["state"]
        if st in registry.TERMINAL or st in registry.UNRESOLVED:
            return 0
        now = time.time()
        if now >= entry["hard_deadline"]:
            stop_run(layout, policy, agent, entry, "timed_out", "S1")
            return 0
        if hard_halt_requested(layout, agent):
            stop_run(layout, policy, agent, entry, "emergency_stop", "S1")
            return 0
        try:
            stub_ok = procs.identity_ok(entry.get("stub_pid"), entry.get("stub_start"))
            child_ok = procs.identity_ok(entry.get("child_pid"), entry.get("child_start"))
        except procs.ObservationError:
            time.sleep(interval)  # 観測できない間は、クラッシュと判定しない（停止は期限・HALTで行う）
            continue
        if st == "starting" and not stub_ok and now - started > interval * 2:
            stop_run(layout, policy, agent, entry, "runner_crashed_spawning", "S1")
            return 0
        if st == "running" and not stub_ok and not child_ok:
            stop_run(layout, policy, agent, entry, "runner_crashed_running", "S1")
            return 0
        time.sleep(interval)


def watchdog_cycle(layout, policy, agent, now=None):
    """S2 の1周期。実行係・S1 から独立に、登録簿の全ランを確認する。戻り値: 行った処置の一覧。"""
    now = time.time() if now is None else now
    actions = []
    problems = registry.inconsistencies(layout)
    if problems:
        agent.halt_agent("registry_inconsistent", {"problems": problems})
        actions.append(("halt_agent", "registry_inconsistent"))
    starting_timeout = policy_mod.timing(policy, "starting_timeout")
    slack = policy_mod.timing(policy, "deadline_slack")
    reaper_max_age = policy_mod.timing(policy, "reaper_interval") * 3 + 1
    hard = hard_halt_requested(layout, agent)
    for entry in registry.non_terminal(layout):
        run_id = entry["run_id"]
        if entry["state"] == "stop_unconfirmed":
            details = procs.terminate(collector(layout, entry), policy_mod.timing(policy, "grace_seconds"),
                                      policy_mod.timing(policy, "confirm_seconds"))
            absent = details["absent"] and not details["unknown"]
            if absent:
                registry.update(layout, run_id, "interrupted", recovered_by="S2")
                actions.append((run_id, "stop_confirmed_later"))
            continue
        hb = os.path.join(layout.run_dir(run_id), "reaper_heartbeat.json")
        reaper_ok = heartbeat_fresh(hb, reaper_max_age, now)
        try:
            stub_ok = procs.identity_ok(entry.get("stub_pid"), entry.get("stub_start"))
            child_ok = procs.identity_ok(entry.get("child_pid"), entry.get("child_start"))
        except procs.ObservationError:
            if hard or now >= entry["hard_deadline"]:
                stop_run(layout, policy, agent, entry, "emergency_stop" if hard else "timed_out", "S2")
                actions.append((run_id, "stop_attempt_under_unknown_observation"))
            else:
                actions.append((run_id, "observation_unavailable"))
            continue
        if entry["state"] == "starting":
            created = float(entry.get("created_at", now))
            if not stub_ok or now - created > starting_timeout:
                stop_run(layout, policy, agent, entry, "runner_crashed_spawning", "S2")
                actions.append((run_id, "starting_recovered"))
            elif hard:
                stop_run(layout, policy, agent, entry, "emergency_stop", "S2")
                actions.append((run_id, "emergency_stop"))
            continue
        # running
        if hard:
            stop_run(layout, policy, agent, entry, "emergency_stop", "S2")
            actions.append((run_id, "emergency_stop"))
        elif now >= entry["hard_deadline"] + slack or (now >= entry["hard_deadline"] and not reaper_ok):
            stop_run(layout, policy, agent, entry, "timed_out", "S2")
            actions.append((run_id, "timed_out"))
        elif not stub_ok and not child_ok:
            stop_run(layout, policy, agent, entry, "runner_crashed_running", "S2")
            actions.append((run_id, "crashed"))
    # 終了済みのランの識別子を持つプロセスが残っていないか（孤立したプロセス）
    for run_id in registry.all_entries(layout):
        try:
            entry = registry.load(layout, run_id)
        except (registry.RegistryError, ValueError):
            continue
        if entry and entry["state"] in registry.TERMINAL:
            present = run_processes_present(layout, entry)
            if present is None:
                agent.halt_agent("observation_unavailable", {"run_id": run_id})
                actions.append((run_id, "observation_unavailable"))
            elif present:
                details = procs.terminate(collector(layout, entry), policy_mod.timing(policy, "grace_seconds"),
                                          policy_mod.timing(policy, "confirm_seconds"))
                agent.halt_agent("orphan_process", {"run_id": run_id, "absent": details["absent"],
                                                    "observation_unknown": details["unknown"]})
                actions.append((run_id, "orphan"))
    return actions


def watchdog_loop(layout, policy, agent, interval):
    while True:
        write_s2_heartbeat(layout)
        watchdog_cycle(layout, policy, agent)
        time.sleep(interval)
