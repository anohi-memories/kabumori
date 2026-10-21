"""制御プレーン（主ユーザー側）: 起動ゲート・CLAIM・起動要求・終了判定・HALT／UNHALT・STOP・ENVELOPE。
仕様 v5 §5・§8・§10、v5.1 §5、v5.2 §1-3、v5.3 §3、v5.4 §1・§4。

不変条件（v5.4 P1-1）: 制御側のイベントログへの追記は、すべて halt.lock の排他ロックの下で行う。
起動スタブは共有ロックを保持して最終判定から起動の確定までを行うため、両者は直列化される。
"""
import json
import os
import time
import uuid

from . import jstclock, logs, meta, norm, notify as notify_mod, policy as policy_mod, procs, registry, report, state
from .chainlog import ChainError, ChainLog
from .fsutil import FileLock, atomic_write_json, canonical, read_json, sha256_hex
from .stub import tree_digest

TRUSTED_LOGIN = "anohi-memories"
FAILURES = ("ended_checks_failed", "runner_error", "interrupted", "runner_crashed")
NEUTRAL = ("ended_checks_passed", "needs_input")


class Hold(Exception):
    """起動しない（保留）。理由つき。"""


class Control:
    def __init__(self, layout, signer, verifier, policy, notifier=None, now=time.time):
        self.layout = layout
        self.signer = signer
        self.verifier = verifier
        self.policy = policy
        self.notifier = notifier or notify_mod.RecordingNotifier()
        self.now = now
        self.control = logs.control_log(layout, verifier)
        self.ledger = logs.ledger(layout, verifier)
        self.agent_events = logs.agent_log(layout, verifier)
        self.used = logs.used_log(layout, verifier)

    # --- ポリシー ---
    @staticmethod
    def install_policy(layout, policy_dict):
        clean = {k: v for k, v in policy_dict.items() if not k.startswith("_")}
        atomic_write_json(layout.policy_priv, clean)
        atomic_write_json(layout.policy_pub, clean)
        return policy_mod.with_digest(clean)

    # --- イベントの追記（排他ロックの下） ---
    def append_control(self, rtype, payload, role, timeout=None):
        with FileLock(self.layout.halt_lock, "ex", timeout=timeout) as lock:
            if not lock.acquired:
                raise TimeoutError("could not acquire halt.lock exclusively")
            return self.control.append(rtype, payload, self.signer, role, self.now())

    def read_state(self):
        return state.derive(self.control.read_all(), self.agent_events.read_all())

    # --- ENVELOPE・CONFIRM・STOP ---
    def approve_envelope(self, params):
        approved_at = self.now()
        payload = dict(params)
        payload["envelope_id"] = payload.get("envelope_id") or "env-" + uuid.uuid4().hex[:12]
        payload["approved_at"] = approved_at
        payload["expires_at"] = jstclock.next_rollover(approved_at)
        return self.append_control("ENVELOPE_APPROVE", payload, "human")

    def revoke_envelope(self, envelope_id, role="runner"):
        return self.append_control("ENVELOPE_REVOKE", {"envelope_id": envelope_id}, role)

    def confirm(self, approval_id, task_sha256):
        return self.append_control("CONFIRM", {"approval_id": approval_id, "task_sha256": task_sha256,
                                               "policy_sha256": self.policy["_digest"]}, "human")

    def stop_on(self):
        atomic_write_json(self.layout.stop_flag, {"ts": self.now()})
        return self.append_control("STOP", {}, "runner")

    def stop_off(self):
        rec = self.append_control("STOP_OFF", {}, "human")
        if os.path.exists(self.layout.stop_flag):
            os.remove(self.layout.stop_flag)
        return rec

    # --- HALT（v5.2 §1-3 H0〜H5） ---
    def halt(self, kind, reason, wait_sync=None, lock_timeout=None):
        """H0: 合図のフラグ → H1: 排他ロックの下でHALTを記録 → H2/H3: 停止と完了条件の確認。

        戻り値: {"resolved": bool, "problems": [...], "event": HALTイベント}
        """
        atomic_write_json(self.layout.halt_flag, {"kind": kind, "reason": reason, "ts": self.now()})
        event = self.append_control("HALT", {"kind": kind, "reason": reason}, "runner", timeout=lock_timeout)
        self.ledger.append("HALT_RECORD", {"kind": kind, "reason": reason, "event_id": event["event_id"]},
                           self.signer, "runner", self.now())
        wait = policy_mod.timing(self.policy, "halt_sync_wait") if wait_sync is None else wait_sync
        deadline = time.monotonic() + wait
        problems = self.completion_problems() if kind == "hard" else []
        while problems and time.monotonic() < deadline:
            time.sleep(0.1)
            problems = self.completion_problems()
        if problems:
            self.alert("halt", "HALT未解決（halt_unresolved）", "; ".join(problems))
        else:
            self.alert("halt", "HALT（%s）" % kind, reason)
        return {"resolved": not problems, "problems": problems, "event": event}

    def completion_problems(self):
        """H3の完了条件（非終了のランなし・識別子に一致するプロセスなし・登録簿の不整合なし）。"""
        problems = []
        problems += ["registry: " + p for p in registry.inconsistencies(self.layout)]
        for entry in registry.non_terminal(self.layout):
            problems.append("non-terminal run: %s (%s)" % (entry["run_id"], entry["state"]))
        for run_id in registry.all_entries(self.layout):
            try:
                entry = registry.load(self.layout, run_id)
            except registry.RegistryError:
                continue
            if entry and procs.find_by_marker(registry.marker(entry)):
                problems.append("process still present: " + run_id)
        return problems

    def unhalt(self, ack_reason):
        """排他ロックを保持したまま、最終の不在確認 → 人の署名つきUNHALT → 解放（v5.4 §4）。"""
        with FileLock(self.layout.halt_lock, "ex") as lock:
            problems = self.completion_problems()
            try:
                problems += self.reconcile_problems()
            except ChainError as exc:
                problems.append("log invalid: %s" % exc)
            if problems:
                return None, problems
            st = self.read_state()
            agent_events = self.agent_events.read_all()
            agent_halts = [r["event_id"] for r in agent_events if r["type"] == "HALT_AGENT"]
            head_seq = agent_events[-1]["seq"] if agent_events else 0
            payload = {"halt_ids": sorted(st.control_halts.keys()), "agent_halt_ids": sorted(agent_halts),
                       "agent_head_seq": head_seq,
                       "completion_digest": sha256_hex(canonical({"problems": problems})),
                       "ack_reason": ack_reason}
            rec = self.control.append("UNHALT", payload, self.signer, "human", self.now())
            self.ledger.append("ACK_SAFETY", {"unhalt_event": rec["event_id"], "reason": ack_reason},
                               self.signer, "human", self.now())
            if os.path.exists(self.layout.halt_flag):
                os.remove(self.layout.halt_flag)
            return rec, []

    # --- 台帳の集計 ---
    def _claims(self, records):
        return [r for r in records if r["type"] == "CLAIM"]

    def consecutive_failures(self, records):
        n = 0
        for r in records:
            if r["type"] != "END":
                continue
            status = r["payload"]["status"]
            if status in FAILURES:
                n += 1
            elif status in NEUTRAL:
                n = 0
        return n

    def running_count(self, records):
        ended = {r["payload"]["run_id"] for r in records
                 if r["type"] == "END" and r["payload"].get("absence_confirmed")}
        return len([c for c in self._claims(records) if c["payload"]["run_id"] not in ended])

    # --- 起動ゲートと CLAIM（v5 §5-4 の1〜13） ---
    def try_claim(self, body, issue_meta, reference_now, scenario=None):
        """起動してよければ CLAIM して、署名つき起動要求を書く。戻り値: (run_id, None) または (None, 理由)。"""
        local_now = self.now()
        if state.flags_say_halt(self.layout):
            return None, "halted (flag)"
        if state.flags_say_stop(self.layout):
            return None, "stopped (flag)"
        ledger_records = self.ledger.read_all()
        last_ts = ledger_records[-1]["ts"] if ledger_records else None
        clock = jstclock.clock_problem(local_now, reference_now, last_ts)
        if clock == "CLOCK_ANOMALY":
            self.halt("hard", "CLOCK_ANOMALY", wait_sync=0)
            return None, clock
        if clock:
            return None, clock
        if not (issue_meta.get("state") == "OPEN" and issue_meta.get("number") == 323
                and (issue_meta.get("author") or "") == TRUSTED_LOGIN
                and issue_meta.get("editor") in (None, TRUSTED_LOGIN)):
            return None, "issue not trusted"
        result = meta.validate_task(body, self.policy)
        if not result.ok:
            return None, "task invalid: " + "; ".join(result.problems)
        f = result.fields
        try:
            computed = norm.compute_hash(body)
        except norm.NormError as exc:
            return None, "hash: %s" % exc
        if computed != f["phase2_task_sha256"]:
            return None, "hash mismatch"
        try:
            st = self.read_state()
        except ChainError as exc:
            self.halt("hard", "control_log_invalid", wait_sync=0)
            return None, "control log invalid: %s" % exc
        if st.halted:
            return None, "halted"
        if st.stopped:
            return None, "stopped"
        base = {
            "approval_id": f["phase2_approval_id"], "task_id": f["task_id"], "task_sha256": computed,
            "prompt": body, "base_ref": f["base_ref"], "base_sha": f["base_sha"], "model": f["model"],
            "model_id": f["phase2_model_id"], "effort": f["effort"], "max_minutes": f["max_minutes"],
            "max_budget_usd": f["max_budget_usd"], "policy_sha256": self.policy["_digest"],
            "phase2_scope": f["phase2_scope"], "production_permission": f["production_permission"],
            "report_mode": f["phase2_report_mode"],
        }
        c = st.confirms.get(f["phase2_approval_id"])
        if c and c.get("task_sha256") == computed and c.get("policy_sha256") == self.policy["_digest"]:
            base["authorization"] = "confirm"
        elif st.envelope:
            base["authorization"] = "envelope"
            base["envelope_id"] = st.envelope["envelope_id"]
            if not state.authorization_ok(st, base, local_now, reference_now):
                return None, "envelope does not authorize (expired, out of range or clock)"
        else:
            return None, "no CONFIRM or ENVELOPE"

        run_id = "run-" + uuid.uuid4().hex[:16]
        request_id = "req-" + uuid.uuid4().hex[:16]
        rate = self.policy["rate_guard"]
        breaker_n = int(self.policy["breaker_consecutive_failures"])
        max_conc = int(self.policy["max_concurrent"])

        def gate(records):
            for r in self._claims(records):
                if r["payload"]["approval_id"] == base["approval_id"]:
                    return False, "approval_id already used"
            recent = [r for r in self._claims(records) if local_now - r["ts"] < rate["window_seconds"]]
            if len(recent) >= rate["max_starts"]:
                return False, "rate guard (too many starts in window)"
            if self.consecutive_failures(records) >= breaker_n:
                return False, "breaker (consecutive failures)"
            if self.running_count(records) >= max_conc:
                return False, "concurrency limit"
            if state.flags_say_halt(self.layout) or state.flags_say_stop(self.layout):
                return False, "halted/stopped"
            return True, None

        claim, reason = self.ledger.append_if("CLAIM", {"run_id": run_id, "request_id": request_id,
                                                        "approval_id": base["approval_id"],
                                                        "task_id": base["task_id"], "task_sha256": computed,
                                                        "authorization": base["authorization"],
                                                        "envelope_id": base.get("envelope_id")},
                                              self.signer, "runner", local_now, gate)
        if claim is None:
            if reason and reason.startswith("rate guard"):
                self.alert("hold", "起動を保留（起動が多すぎる）", reason)
            return None, reason
        req = dict(base)
        req.update({"run_id": run_id, "request_id": request_id, "session_id": str(uuid.uuid4()),
                    "claim_seq": claim["seq"], "issued_at": local_now, "reference_time": reference_now,
                    "expires_at": local_now + policy_mod.timing(self.policy, "request_ttl"),
                    "control_head_seq": st.head[0]})
        doc = {"request": req, "sig": self.signer.sign("runner", canonical(req))}
        atomic_write_json(self.layout.request_file(run_id), doc)
        return run_id, None

    # --- 終了判定（v5 §10-3）・REPORT・通知 ---
    def finalize(self, run_id, current_body=None):
        doc = read_json(self.layout.request_file(run_id))
        req = doc["request"]
        try:
            entry = registry.load(self.layout, run_id)
        except registry.RegistryError as exc:
            entry = None
            self.halt("hard", "registry_inconsistent: %s" % exc, wait_sync=0)
        run_dir = self.layout.run_dir(run_id)
        result = read_json(os.path.join(run_dir, "result.json"))
        parsed = (result or {}).get("parsed") or {}
        checks = {}
        violations = []
        checks["exit_code_zero"] = bool(result) and result.get("exit_code") == 0
        checks["result_json_present"] = bool(parsed)
        checks["is_error_false"] = parsed.get("is_error") is False
        checks["terminal_reason_completed"] = parsed.get("terminal_reason") == "completed"
        usage = parsed.get("modelUsage")
        allowed = {req["model_id"]} | set(self.policy.get("allowed_secondary_models", []))
        model_ok = isinstance(usage, dict) and req["model_id"] in usage and set(usage) <= allowed \
            and len(set(usage) - set(self.policy.get("allowed_secondary_models", []))) == 1
        checks["model_matches"] = model_ok
        if parsed and not model_ok:
            violations.append("model mismatch or unverifiable")
        checks["self_report_present"] = isinstance(parsed.get("result"), str) and bool(parsed.get("result").strip())
        work_dir = self.layout.work_dir(run_id)
        wd = read_json(os.path.join(run_dir, "work_digest.json"))
        if wd and os.path.isdir(work_dir):
            checks["work_unchanged"] = tree_digest(work_dir) == wd["digest"]
            if not checks["work_unchanged"]:
                violations.append("work folder changed (observed)")
        else:
            checks["work_unchanged"] = False
        if current_body is not None:
            try:
                same = norm.compute_hash(current_body) == req["task_sha256"]
            except norm.NormError:
                same = False
            checks["issue_body_unchanged"] = same
            if not same:
                violations.append("issue body changed during run (observed)")
        pol = policy_mod.load(self.layout.policy_priv)
        checks["policy_unchanged"] = pol["_digest"] == req["policy_sha256"]
        if not checks["policy_unchanged"]:
            violations.append("policy changed during run (observed)")
        try:
            self.ledger.read_all()
            checks["ledger_valid"] = True
        except ChainError:
            checks["ledger_valid"] = False
            violations.append("ledger invalid")

        st_name = entry["state"] if entry else "unknown"
        absent = not (entry and procs.find_by_marker(registry.marker(entry)))
        if st_name == "stop_unconfirmed" or not absent:
            status = "stop_unconfirmed"
            violations.append("stop unconfirmed")
        elif st_name == "interrupted":
            status = "interrupted"
        elif st_name == "runner_crashed":
            status = "runner_crashed"
        elif st_name == "aborted_by_halt":
            status = "interrupted"
        elif st_name in ("aborted_before_spawn", "unknown", "starting", "running"):
            status = "runner_error"
        elif violations:
            status = "ended_checks_failed"
        elif all(checks.values()):
            text = parsed.get("result", "")
            pending = [line for line in text.splitlines() if line.startswith("pending_questions:")]
            if pending and not pending[0].split(":", 1)[1].strip().startswith("なし"):
                status = "needs_input"
            else:
                status = "ended_checks_passed"
        else:
            status = "ended_checks_failed"
        end = self.ledger.append("END", {"run_id": run_id, "status": status, "checks": checks,
                                         "absence_confirmed": absent and status != "stop_unconfirmed",
                                         "safety_violations": violations},
                                 self.signer, "runner", self.now())
        text = report.build(req, entry, result, checks, status, violations)
        path = os.path.join(self.layout.reports, run_id + ".md")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(text)
        self.alert(status, "G10 %s" % status, "task_id: %s" % req["task_id"])
        if violations:
            self.halt("hard", "safety violation: " + "; ".join(violations), wait_sync=0)
        elif self.consecutive_failures(self.ledger.read_all()) >= int(self.policy["breaker_consecutive_failures"]):
            self.halt("soft", "breaker: consecutive failures", wait_sync=0)
        return status, end

    # --- 照合（制御側の台帳 × 実行側の used_requests。v5.4 §2-2） ---
    def reconcile_problems(self):
        problems = []
        claims = {r["payload"]["run_id"]: r["payload"] for r in self._claims(self.ledger.read_all())}
        accepted_approvals = {}
        for r in self.used.read_all():
            if r["type"] != "ACCEPTED":
                continue
            p = r["payload"]
            c = claims.get(p["run_id"])
            if c is None or c["approval_id"] != p["approval_id"] or c["request_id"] != p["request_id"]:
                problems.append("ACCEPTED without matching CLAIM: " + p["run_id"])
            if p["approval_id"] in accepted_approvals:
                problems.append("approval accepted twice: " + p["approval_id"])
            accepted_approvals[p["approval_id"]] = p["run_id"]
        return problems

    def reconcile(self):
        problems = self.reconcile_problems()
        if problems:
            self.halt("hard", "ledger/used_requests mismatch: " + "; ".join(problems), wait_sync=0)
        return problems

    # --- 監督機構の途絶の検知（v5.4 §3-2） ---
    def supervision_check(self, now=None):
        """実行中のランがあり、S2 と S1 のハートビートがともに途絶えていれば、HALT（ハード）と通知。"""
        from . import supervise
        now = time.time() if now is None else now
        running = registry.non_terminal(self.layout)
        if not running:
            return None
        loss_age = policy_mod.timing(self.policy, "s2_redundancy_loss_age")
        s2_ok = supervise.heartbeat_fresh(self.layout.s2_heartbeat, loss_age, now)
        reaper_age = policy_mod.timing(self.policy, "reaper_interval") * 3 + 1
        dead = []
        for entry in running:
            hb = os.path.join(self.layout.run_dir(entry["run_id"]), "reaper_heartbeat.json")
            if not supervise.heartbeat_fresh(hb, reaper_age, now):
                dead.append(entry["run_id"])
        if not s2_ok and dead:
            remaining = [e["run_id"] for e in running if procs.find_by_marker(registry.marker(e))]
            self.halt("hard", "supervisors down (S1 and S2)", wait_sync=0)
            self.alert("halt", "監督機構が停止しています",
                       "Claudeが止まっていない可能性があります（%s）。手順書の最終手段で停止してください" % ", ".join(remaining))
            return {"halted": True, "runs": dead, "processes": remaining}
        if not s2_ok:
            if not self.read_state().halted:
                self.halt("soft", "S2 heartbeat lost (redundancy loss); running runs supervised by S1 only",
                          wait_sync=0)
            return {"halted": True, "kind": "soft", "s2_lost": True}
        return None

    # --- 通知 ---
    def alert(self, kind, title, message):
        return notify_mod.notify(self.layout, self.notifier, kind, title, message)
