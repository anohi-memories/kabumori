"""監督機構: 停止（stop_run）・S1（ランごとの reaper）・S2（watchdog）。仕様 v5.1 §2・v5.2 §1-4・v5.4 §3。"""
import json
import os
import threading
import time

from . import issue as issue_mod, policy as policy_mod, procs, registry, state, wiring
from .chainlog import ChainError
from .fsutil import atomic_write_json, canonical, is_finite_number, read_json, sha256_hex


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
    """停止の対象を集める関数を返す（H3 R3・H4 P1/P2）。

    - 識別（pid・開始時刻・uid・`--run-id`・`--root`）が一致した起動スタブ（先頭: 親を先に止め、
      子の終了を「exited」と記録させない）
    - 登録簿の子（child_pid・child_start）を、一覧とは独立に直接確認したもの（一覧の欠落を補う）
    - カーネルと ps の和集合のうち、正確な識別子に一致するもの
    観測できなければ ObservationError。戻り値の関数は .verify(pid, 開始時刻) を持つ（signal 直前の再照合）。
    """
    ident = registry.identity(entry)
    stub_pid, stub_start = entry.get("stub_pid"), entry.get("stub_start")
    child_pid, child_start = entry.get("child_pid"), entry.get("child_start")

    def is_stub(pid, start):
        return (pid == stub_pid and bool(stub_start) and start == stub_start
                and procs.stub_matches(stub_pid, stub_start, entry["run_id"], entry["root"], entry["uid"]))

    def verify(pid, start):
        """送信直前の照合: uid・開始時刻・完全な argv（ランの識別子、またはスタブの識別子）。"""
        if not start or procs.start_time(pid) != start:
            return False
        return is_stub(pid, start) or procs.run_process_matches(pid, ident)

    def collect():
        targets = {}
        if stub_pid and stub_start and is_stub(stub_pid, stub_start):
            targets[stub_pid] = stub_start
        if child_pid and child_start and procs.identity_ok(child_pid, child_start) \
                and procs.run_process_matches(child_pid, ident):
            targets.setdefault(child_pid, child_start)
        for pid, start in procs.find_run_processes(ident):
            targets.setdefault(pid, start)
        return targets
    def drift():
        """識別の変わった既知のプロセス（H3 C3 R1）: 登録簿の pid・開始時刻が一致して生存しているのに、
        argv・uid などが一致しない、または照合できないもの。signal は送らない（PID だけでは止めない）が、
        「居ない」の根拠にもしない。開始時刻が違う（pid の再利用）・不在・ゾンビなら含めない。"""
        out = []
        for role, pid, start in (("stub", stub_pid, stub_start), ("child", child_pid, child_start)):
            if not pid or not start or not procs.identity_ok(pid, start):
                continue
            try:
                ok = is_stub(pid, start) if role == "stub" else procs.run_process_matches(pid, ident)
                reason = None if ok else "identity_drift"
            except procs.ObservationError as exc:
                reason = "identity_unverifiable: %s" % exc
            if reason:
                out.append({"pid": pid, "role": role, "reason": reason})
        return out

    collect.verify = verify
    collect.drift = drift
    return collect


def run_processes_present(layout, entry):
    """識別子に一致するプロセス、または識別の変わった既知のプロセスがあるか。True／False、観測できなければ None。"""
    try:
        collect = collector(layout, entry)
        return bool(collect()) or bool(collect.drift())
    except procs.ObservationError:
        return None


def identity_drift(layout, entry):
    """識別の変わった既知のプロセスの一覧（観測できなければ None）。"""
    try:
        return collector(layout, entry).drift()
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
                                                  "observation_unknown": details.get("unknown"),
                                                  "identity_drift": details.get("identity_drift")})
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


def issue_revoked(agent, entry):
    """登録簿のランが ISSUE_REVOKE の対象か（TASK 5）。ログが読めなければ False（ハードHALT の側で扱う）。"""
    if agent is None:
        return False
    try:
        return state.issue_revoked(agent.current_state(update_seen=False), entry)
    except (ChainError, state.RewindError):
        return False


def _issue_monitor_check(layout, policy, agent, run_id):
    try:
        doc = read_json(os.path.join(layout.run_dir(run_id), "request.json"))
        req = doc["request"]
        if not agent.verifier.verify("runner", canonical(req), doc["sig"]) or req.get("run_id") != run_id:
            return "request unverifiable", None
    except Exception as exc:  # 要求が読めないランは、照合できないので安全側
        return "request unreadable: %s" % type(exc).__name__, None
    try:  # TASK 16 R2: 実行中に設定が消えた・無承認で変わった・承認が変わったら、照合できないので止める
        wreason = wiring.check_run(layout.root, agent.current_state(update_seen=False), req)
    except Exception as exc:
        wreason = "wiring check failed: %s" % type(exc).__name__
    if wreason:
        return "wiring: " + wreason, None
    try:
        witness = issue_mod.spawn_witness(layout.root, policy)
    except Exception as exc:  # 取得係を作れない（鍵が読めない等）: 照合できないので安全側（TASK 8 R1）
        return "issue witness unavailable: %s" % type(exc).__name__, None
    if witness is None:
        return "no issue witness (real GitHub fetch is not implemented)", None
    nonce = issue_mod.monitor_nonce(run_id)
    try:
        ev = witness.observe("monitor", nonce, timeout=policy_mod.timing(policy, "issue_fetch_timeout"))
    except Exception as exc:  # 取得の失敗・打ち切りを「変更なし」とみなさない
        return "issue fetch failed while running: %s" % type(exc).__name__, None
    reason = issue_mod.check_monitor(ev, req.get("issue_evidence"), agent.verifier, req.get("prompt"), time.time(),
                                     policy_mod.timing(policy, "spawn_evidence_max_age"), nonce, agent.go_bodies())
    return reason, ev


def issue_monitor_check(layout, policy, agent, run_id, by):
    """実行中のランの Issue #323 を再取得し、OPEN・本文・世代が CLAIM 時と同じか照合する（TASK 7）。

    戻り値: (理由, checked_at)。問題なしなら (None, 証拠の取得時刻)。例外は投げない（TASK 8 R1: どの段階の
    例外も、型名だけの決まった理由で失敗にする。例外の本文は記録しない）。結果は runs/<run_id>/issue_monitor.jsonl
    に監査証拠として残す。"""
    try:
        reason, ev = _issue_monitor_check(layout, policy, agent, run_id)
    except Exception as exc:
        reason, ev = "issue monitor error: %s" % type(exc).__name__, None
    checked_at = None
    if reason is None:
        try:
            checked_at = ev["evidence"]["fetched_at"]
        except (TypeError, KeyError):
            checked_at = None
        if not is_finite_number(checked_at):
            reason, checked_at = "issue monitor produced no usable evidence", None
    _record_issue_monitor(layout, run_id, {"ts": time.time(), "by": by, "ok": reason is None, "reason": reason,
                                           "checked_at": checked_at,
                                           "evidence_sha256": _safe_digest(ev) if reason is None else None})
    return reason, checked_at


def _safe_digest(ev):
    try:
        return sha256_hex(canonical(ev))
    except (TypeError, ValueError):
        return None


def _record_issue_monitor(layout, run_id, record):
    try:
        with open(os.path.join(layout.run_dir(run_id), "issue_monitor.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
    except (OSError, ValueError):
        pass


def stop_for_issue_change(layout, policy, agent, entry, problem, by):
    """実行中の Issue の変化・照合不能: まず HALT（HALT_AGENT）を記録し、次にランを止める。"""
    agent.halt_agent("issue_changed_while_running", {"run_id": entry["run_id"], "reason": problem, "by": by})
    stop_run(layout, policy, agent, entry, "issue_changed_while_running", by)


class IssueMonitor:
    """S1 の実行中の Issue 監督（TASK 7）。再取得は別スレッドで行い、取得の遅れ（最大 issue_fetch_timeout 秒）で
    S1 の HALT・取消・期限の確認を止めない。打ち切り時間を過ぎても戻らない取得は、失敗として扱う。

    TASK 8: スレッドの結果は「未完了（PENDING）／成功（SUCCESS, 取得時刻）／失敗（FAILURE, 理由）」で区別する。
    - 例外で終わった・結果を残さずに終わったスレッドは失敗（成功の None と取り違えない）。ok_at は更新しない。
    - 成功の ok_at は、親が受け取った時刻ではなく、証拠の取得時刻（checked_at）。受け取りが遅れて
      `spawn_evidence_max_age` より古くなった成功は「新しい照合」として公表せず（ok_at を進めない）、すぐ取り直す。
      これにより、S1 が遅れても S2 の stale の判定（issue_ok_at が古ければ S2 が自分で照合）をすり抜けない。"""

    def __init__(self, layout, policy, agent, run_id):
        self.layout, self.policy, self.agent, self.run_id = layout, policy, agent, run_id
        self.interval = policy_mod.timing(policy, "issue_monitor_interval")
        self.overdue = policy_mod.timing(policy, "issue_fetch_timeout") + self.interval
        self.max_age = policy_mod.timing(policy, "spawn_evidence_max_age")
        self.thread = None
        self.result = None
        self.started_at = None
        self.ok_at = None
        self.stale_discarded = 0

    def _run(self):
        try:
            reason, checked_at = issue_monitor_check(self.layout, self.policy, self.agent, self.run_id, "S1")
            self.result = ("FAILURE", reason) if reason is not None else ("SUCCESS", checked_at)
        except BaseException as exc:  # どの例外も、型名だけの決まった理由で失敗として親へ伝える
            self.result = ("FAILURE", "issue monitor worker error: %s" % type(exc).__name__)

    def poll(self, now):
        """問題があれば理由を返す（None＝まだ・問題なし）。"""
        if self.thread is not None:
            if self.thread.is_alive():
                if now - self.started_at > self.overdue:
                    return "issue monitor fetch overdue"
                return None
            self.thread = None
            result, self.result = self.result, None
            if not (isinstance(result, tuple) and len(result) == 2 and result[0] in ("SUCCESS", "FAILURE")):
                return "issue monitor worker ended without a result"
            if result[0] == "FAILURE":
                return result[1] if isinstance(result[1], str) and result[1] else "issue monitor failed"
            checked_at = result[1]
            current = time.time()
            if not is_finite_number(checked_at) or checked_at > current + 1.0:
                return "issue monitor result has an invalid time"
            if current - checked_at > self.max_age or now - checked_at > self.max_age:
                self.stale_discarded += 1  # 古い成功: 公表せず、すぐ取り直す（S2 は issue_ok_at の古さで気づく）
                self.started_at = None
            elif self.ok_at is None or checked_at > self.ok_at:
                self.ok_at = checked_at
        if self.started_at is None or now - self.started_at >= self.interval:
            self.started_at = now
            self.result = None
            self.thread = threading.Thread(target=self._run, daemon=True)
            self.thread.start()
        return None


def reaper_loop(layout, policy, agent, run_id):
    """S1: 1つのランを期限まで監督する。実行係（スタブ）から独立したプロセスで動く。"""
    interval = policy_mod.timing(policy, "reaper_interval")
    hb_path = os.path.join(layout.run_dir(run_id), "reaper_heartbeat.json")
    started = time.time()
    monitor = IssueMonitor(layout, policy, agent, run_id)
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
                                    "loaded_deadline": entry["hard_deadline"], "issue_ok_at": monitor.ok_at})
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
        if st == "running" and issue_revoked(agent, entry):  # 起動後の取消: 止める（毎周期・Issue の再取得より優先）
            stop_run(layout, policy, agent, entry, "issue_revoked", "S1")
            return 0
        if st == "running":  # TASK 7: 実行中の Issue の変化・照合不能を検出して止める
            problem = monitor.poll(now)
            if problem:
                stop_for_issue_change(layout, policy, agent, entry, problem, "S1")
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


# 終了済みのランの孤立プロセスの確認が、何周期続けて観測できなければ HALT_AGENT にするか（TASK 24）。
# 終了済みのランは監督の対象外なので、高負荷での一時的な ps の失敗では止めない。実行中のランの確認は従来どおり。
TERMINAL_OBSERVATION_FAILURE_LIMIT = 3


def terminal_observation_path(layout):
    return os.path.join(layout.agent_out, "s2_terminal_observation.json")


def watchdog_cycle(layout, policy, agent, now=None):
    """S2 の1周期。実行係・S1 から独立に、登録簿の全ランを確認する。戻り値: 行った処置の一覧。"""
    now = time.time() if now is None else now
    actions = []
    if not agent.sync_flags():  # TASK 24: 署名つき UNHALT で解除済みの HALT_AGENT の合図を片付ける（迷えば残す）
        actions.append(("halt_agent_flag", "kept"))
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
        elif issue_revoked(agent, entry):
            stop_run(layout, policy, agent, entry, "issue_revoked", "S2")
            actions.append((run_id, "issue_revoked"))
        elif _s1_issue_monitor_stale(layout, policy, entry, now) and \
                _s2_issue_problem(layout, policy, agent, entry) is not None:
            actions.append((run_id, "issue_changed_while_running"))
        elif now >= entry["hard_deadline"] + slack or (now >= entry["hard_deadline"] and not reaper_ok):
            stop_run(layout, policy, agent, entry, "timed_out", "S2")
            actions.append((run_id, "timed_out"))
        elif not stub_ok and not child_ok:
            stop_run(layout, policy, agent, entry, "runner_crashed_running", "S2")
            actions.append((run_id, "crashed"))
    # 終了済みのランの識別子を持つプロセスが残っていないか（孤立したプロセス）
    fail_path = terminal_observation_path(layout)
    try:
        failures = read_json(fail_path, {})
    except ValueError:
        failures = None
    if not isinstance(failures, dict) or not all(isinstance(v, int) and not isinstance(v, bool) and v > 0
                                                 for v in failures.values()):
        failures = {k: TERMINAL_OBSERVATION_FAILURE_LIMIT for k in registry.all_entries(layout)}  # 壊れていれば安全側
    counted = {}
    for run_id in registry.all_entries(layout):
        try:
            entry = registry.load(layout, run_id)
        except (registry.RegistryError, ValueError):
            continue
        if entry and entry["state"] in registry.TERMINAL:
            present = run_processes_present(layout, entry)
            if present is None:
                n = failures.get(run_id, 0) + 1
                if n >= TERMINAL_OBSERVATION_FAILURE_LIMIT:
                    agent.halt_agent("observation_unavailable", {"run_id": run_id, "consecutive_failures": n})
                    actions.append((run_id, "observation_unavailable"))
                    n = 0  # HALT にしたら数え直す（解除の後も続けば、また HALT）
                else:
                    actions.append((run_id, "observation_unavailable_transient"))
                if n:
                    counted[run_id] = n
            elif present:
                details = procs.terminate(collector(layout, entry), policy_mod.timing(policy, "grace_seconds"),
                                          policy_mod.timing(policy, "confirm_seconds"))
                agent.halt_agent("orphan_process", {"run_id": run_id, "absent": details["absent"],
                                                    "observation_unknown": details["unknown"]})
                actions.append((run_id, "orphan"))
    if counted != failures:
        atomic_write_json(fail_path, counted)
    return actions


def _s1_issue_monitor_stale(layout, policy, entry, now):
    """S1 の Issue 監督が途絶えているか（最後の正常な照合が古い・記録なし）。そのときだけ S2 が自分で照合する。"""
    hb = read_json(os.path.join(layout.run_dir(entry["run_id"]), "reaper_heartbeat.json")) or {}
    ok_at = hb.get("issue_ok_at")
    limit = policy_mod.timing(policy, "issue_monitor_interval") * 3 + policy_mod.timing(policy, "issue_fetch_timeout")
    base = ok_at if isinstance(ok_at, (int, float)) and not isinstance(ok_at, bool) else entry.get("spawned_at")
    return not isinstance(base, (int, float)) or now - base > limit


def _s2_issue_problem(layout, policy, agent, entry):
    problem, _checked_at = issue_monitor_check(layout, policy, agent, entry["run_id"], "S2")
    if problem:
        stop_for_issue_change(layout, policy, agent, entry, problem, "S2")
    return problem


def reload_policy(layout, policy, agent, make_agent, out=print):
    """TASK 28: S2 のポリシーの読み直し。正本と公開用が一致して有効で、ランの途中でないときだけ切り替える。
    それ以外は読み込んだ版で見張りを続ける（見張りを止めない。起動するかは検知役が同じ条件で決める）。"""
    try:
        current = policy_mod.load_current(layout)
    except policy_mod.PolicyStateError as exc:
        out(json.dumps({"watchdog": "policy not usable; keeping the loaded policy", "error": str(exc)}))
        return policy, agent
    if current["_digest"] == policy["_digest"]:
        return policy, agent
    if registry.non_terminal(layout):
        out(json.dumps({"watchdog": "policy changed while a run is in progress; keeping the loaded policy"}))
        return policy, agent
    out(json.dumps({"watchdog": "policy reloaded", "policy_from": policy["_digest"], "policy_to": current["_digest"]}))
    return current, make_agent(current)


def watchdog_loop(layout, policy, agent, interval, make_agent=None):
    while True:
        if make_agent is not None:
            policy, agent = reload_policy(layout, policy, agent, make_agent)
        write_s2_heartbeat(layout)
        watchdog_cycle(layout, policy, agent)
        time.sleep(interval)
