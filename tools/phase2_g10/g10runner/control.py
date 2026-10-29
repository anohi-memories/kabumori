"""制御プレーン（主ユーザー側）: 起動ゲート・CLAIM・起動要求・終了判定・HALT／UNHALT・STOP・ENVELOPE。
仕様 v5 §5・§8・§10、v5.1 §5、v5.2 §1-3、v5.3 §3、v5.4 §1・§4。

不変条件（v5.4 P1-1）: 制御側のイベントログへの追記は、すべて halt.lock の排他ロックの下で行う。
起動スタブは共有ロックを保持して最終判定から起動の確定までを行うため、両者は直列化される。
"""
import json
import os
import time
import uuid

from . import binding, issue as issue_mod, jstclock, logs, meta, norm, notify as notify_mod, policy as policy_mod, procs, registry, report, state, wiring
from .chainlog import ChainError, ChainLog
from .fsutil import FileLock, atomic_write_json, canonical, loads_strict, read_json, sha256_hex
from .stub import tree_digest

TRUSTED_LOGIN = issue_mod.TRUSTED_LOGIN
FAILURES = ("ended_checks_failed", "runner_error", "interrupted", "runner_crashed")
NEUTRAL = ("ended_checks_passed", "needs_input")


class Hold(Exception):
    """起動しない（保留）。理由つき。"""


class GoReuseError(ValueError):
    """同じ approval_id への2回目の REAL_CLAUDE_GO（TASK 24）。新しい phase2_approval_id の本文が要る。"""


class Control:
    def __init__(self, layout, signer, verifier, policy, notifier=None, now=time.time, witness=None):
        self.layout = layout
        self.witness = witness  # Issue #323 の取得係（H4 P1）。無ければ起動しない
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

    def go_bodies(self):
        """人の REAL_CLAUDE_GO が承認した本文の SHA-256（TASK 17）。ログを読めなければ空（＝緩めない）。"""
        try:
            return self.read_state().go_bodies
        except Exception:
            return frozenset()

    def go_reuse_problem(self, approval_id, records=None, go_id=None):
        """その approval_id に GO を出せない理由（TASK 24）。出せるなら None。

        1つの approval_id に GO は1回だけ（state.derive は同じ go_id の2件目を無視する。期限の延長にもならない）。
        CLAIM 済みの approval_id にも出さない。どちらも、新しい phase2_approval_id の本文が要る。"""
        records = self.control.read_all() if records is None else records
        for r in records:
            if r["type"] == "REAL_CLAUDE_GO" and (r["payload"].get("approval_id") == approval_id
                                                  or r["payload"].get("go_id") in ("go-" + approval_id, go_id)):
                return ("a REAL_CLAUDE_GO for approval_id %s already exists (one GO per approval; it cannot be "
                        "renewed or extended). A new TASK body with a new phase2_approval_id is needed" % approval_id)
        if any(r["type"] == "CLAIM" and r["payload"].get("approval_id") == approval_id for r in self.ledger.read_all()):
            return "approval_id %s is already claimed. A new phase2_approval_id is needed" % approval_id
        return None

    def approve_real_claude_go(self, go):
        """人の署名で、実 Claude の監督付き1回起動を承認する（TASK 17）。形は state.derive と同じ規則で検査する。
        TASK 24: 同じ approval_id の GO が既にあれば、追記せずに GoReuseError（検査と追記は同じロックの下）。"""
        from . import real_claude
        problem = real_claude.go_problem(go)
        if problem:
            raise ValueError(problem)

        def unused(records):
            reason = self.go_reuse_problem(go["approval_id"], records, go_id=go["go_id"])
            return reason is None, reason

        with FileLock(self.layout.halt_lock, "ex") as lock:
            if not lock.acquired:
                raise TimeoutError("could not acquire halt.lock exclusively")
            record, reason = self.control.append_if("REAL_CLAUDE_GO", dict(go), self.signer, "human", self.now(),
                                                    unused)
        if record is None:
            raise GoReuseError(reason)
        return record

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

    def approve_wiring(self):
        """今の wiring.json を、人の署名の WIRING_APPROVE として承認する（TASK 16 R2）。世代は1つずつ増え、
        署名方式は同じか1段先だけ（state.derive も同じ規則で検査し、違反の承認は以後ずっと無効にする）。"""
        current = wiring.binding(self.layout.root)
        if current is None:
            raise wiring.WiringError("no wiring config to approve")
        st = self.read_state()
        if st.wiring_problem:
            raise wiring.WiringError("wiring approvals invalid: " + st.wiring_problem)
        prev = st.wiring
        if prev and not wiring.mode_transition_allowed(prev["mode"], current["mode"]):
            raise wiring.WiringError("signature mode change %s -> %s is not allowed" % (prev["mode"], current["mode"]))
        payload = {"mode": current["mode"], "wiring_sha256": current["sha256"],
                   "generation": prev["generation"] + 1 if prev else 1}
        return self.append_control("WIRING_APPROVE", payload, "human")

    def revoke_envelope(self, envelope_id, role="runner"):
        return self.append_control("ENVELOPE_REVOKE", {"envelope_id": envelope_id}, role)

    def revoke_issue(self, task_id, approval_id=None, task_sha256=None, reason="", role="human"):
        """特定のTASKの取消（TASK 5）。排他ロックの下で制御ログに追記する（ENVELOPE_REVOKE と同じ直列化）。
        線形化点: 起動スタブは共有ロックの下で最終判定を行うので、取消は「最終判定より前（起動しない）」か
        「起動の確定より後（S1/S2 が停止し、finalize は成功にしない）」のどちらかになる。"""
        if not isinstance(task_id, str) or not task_id:
            raise ValueError("task_id is required")
        payload = {"task_id": task_id, "approval_id": approval_id, "task_sha256": task_sha256,
                   "reason": reason, "revoked_at": self.now()}
        return self.append_control("ISSUE_REVOKE", payload, role)

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
        """H3の完了条件（非終了のランなし・識別子に一致するプロセスなし・登録簿の不整合なし）。

        H3 R2: 制御側が自分でプロセスを観測する。観測できなければ「未確認」として問題に数える
        （不在とはみなさない）。実行側の停止記録（supervisor.log）と食い違えば、それも問題にする。
        """
        from . import supervise
        problems = []
        problems += ["registry: " + p for p in registry.inconsistencies(self.layout)]
        for entry in registry.non_terminal(self.layout):
            problems.append("non-terminal run: %s (%s)" % (entry["run_id"], entry["state"]))
        claimed_absent = {}
        try:
            with open(self.layout.supervisor_log, encoding="utf-8") as f:
                for line in f:
                    try:
                        rec = loads_strict(line)
                    except ValueError:
                        problems.append("supervisor log unreadable")
                        break
                    claimed_absent[rec.get("run_id")] = bool(rec.get("absent"))
        except FileNotFoundError:
            pass
        for run_id in registry.all_entries(self.layout):
            try:
                entry = registry.load(self.layout, run_id)
            except (registry.RegistryError, ValueError):
                continue
            if not entry:
                continue
            present = supervise.run_processes_present(self.layout, entry)
            if present is None:
                problems.append("process observation unavailable: " + run_id)
            elif present:
                problems.append("process still present: " + run_id)
                drifted = supervise.identity_drift(self.layout, entry)
                if drifted:
                    problems.append("identity drift (known process alive, identity changed): %s %s"
                                    % (run_id, [d["pid"] for d in drifted]))
                if claimed_absent.get(run_id):
                    problems.append("evidence mismatch (supervisor reported absent): " + run_id)
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
        # H4 P1: Issue #323 を新しく取得し、現役TASKの本文と完全に同じであることを確認する（fail-closed）
        if self.witness is None:
            return None, "no issue witness (cannot fetch Issue #323)"
        try:  # TASK 15: 打ち切り時間を渡す（実際の取得元は打ち切り時間の無い取得を拒否する。結線 E2E で発見）
            evidence = self.witness.observe(timeout=policy_mod.timing(self.policy, "issue_fetch_timeout"))
        except Exception as exc:  # 取得の失敗は種類を問わず起動しない
            return None, "issue fetch failed: %s" % type(exc).__name__
        problem = issue_mod.check_evidence(evidence, self.verifier, body, local_now,
                                           policy_mod.timing(self.policy, "issue_evidence_max_age"),
                                           go_bodies=self.go_bodies())
        if problem:
            return None, "issue binding: " + problem
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
        if state.issue_revoked(st, {"task_id": f["task_id"], "approval_id": f["phase2_approval_id"],
                                    "task_sha256": computed}):
            return None, "issue revoked"
        # TASK 16 R2: 承認済みの設定（wiring）のハッシュと世代を要求に結び付ける（従来の経路では両方 None）
        wreason, wiring_sha, wiring_gen = wiring.claim_binding(self.layout.root, st)
        if wreason:
            return None, "wiring: " + wreason
        base = {
            "approval_id": f["phase2_approval_id"], "task_id": f["task_id"], "task_sha256": computed,
            "prompt": body, "base_ref": f["base_ref"], "base_sha": f["base_sha"], "model": f["model"],
            "model_id": f["phase2_model_id"], "effort": f["effort"], "max_minutes": f["max_minutes"],
            "max_budget_usd": f["max_budget_usd"], "policy_sha256": self.policy["_digest"],
            "phase2_scope": f["phase2_scope"], "production_permission": f["production_permission"],
            "report_mode": f["phase2_report_mode"], "issue_evidence": evidence,
            "wiring_sha256": wiring_sha, "wiring_generation": wiring_gen,
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

        claim_payload = {"run_id": run_id, "request_id": request_id, "authorization": base["authorization"],
                         "envelope_id": base.get("envelope_id")}
        for key in ("approval_id", "task_id", "task_sha256", "model", "model_id", "effort", "max_minutes",
                    "max_budget_usd", "base_ref", "base_sha", "policy_sha256", "wiring_sha256", "wiring_generation"):
            claim_payload[key] = base[key]
        claim_payload["issue_evidence_sha256"] = issue_mod.evidence_digest(evidence)
        claim, reason = self.ledger.append_if("CLAIM", claim_payload, self.signer, "runner", local_now, gate)
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
        # H3 R1: 要求の自己申告ではなく、台帳の CLAIM（承認済みTASKから記録した内容）を基準にする
        claim = None
        for r in self._claims(self.ledger.read_all()):
            if r["payload"]["run_id"] == run_id:
                claim = r["payload"]
        checks["request_matches_claim"] = bool(claim) and binding.request_matches_claim(req, claim)
        if not checks["request_matches_claim"]:
            violations.append("request differs from the CLAIM (approved content)")
        breason, _ = binding.check_request(req, self.policy)
        checks["request_binding_valid"] = breason is None
        if breason:
            violations.append("request binding invalid: " + breason)
        approved_model_id = claim.get("model_id") if claim else None
        if claim and self.policy.get("models", {}).get(claim.get("model")) != approved_model_id:
            approved_model_id = None
        usage = parsed.get("modelUsage")
        secondary = set(self.policy.get("allowed_secondary_models", []))
        model_ok = (approved_model_id is not None and isinstance(usage, dict) and approved_model_id in usage
                    and set(usage) <= ({approved_model_id} | secondary)
                    and len(set(usage) - secondary) == 1)
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
        # TASK 5: Issue #323 を再取得し、state（OPEN）・本文・世代が CLAIM 時と同じか照合する（CLOSED だけの変更も検出）
        if self.witness is None:
            pf_reason = "no issue witness"
        else:
            try:
                pf_doc = self.witness.observe("postflight", issue_mod.postflight_nonce(run_id),
                                              timeout=policy_mod.timing(self.policy, "issue_fetch_timeout"))
                pf_reason = issue_mod.check_postflight(
                    pf_doc, req.get("issue_evidence"), self.verifier, req.get("prompt"), self.now(),
                    policy_mod.timing(self.policy, "spawn_evidence_max_age"), issue_mod.postflight_nonce(run_id),
                    self.go_bodies())
            except Exception as exc:  # 取得できない・検証できないものを成功にしない
                pf_reason = "issue fetch failed at finalize: %s" % type(exc).__name__
        checks["issue_state_unchanged"] = pf_reason is None
        if pf_reason:
            violations.append("issue changed or unverifiable at finalize: " + pf_reason)
        try:
            revoked = state.issue_revoked(self.read_state(), req)
        except ChainError:
            revoked = True
        checks["issue_not_revoked"] = not revoked  # 取消後の結果は成功にしない（停止できたなら interrupted）
        pol = policy_mod.load(self.layout.policy_priv)
        checks["policy_unchanged"] = pol["_digest"] == req["policy_sha256"]
        if not checks["policy_unchanged"]:
            violations.append("policy changed during run (observed)")
        try:  # TASK 16 R2: 設定（wiring）の消失・無承認の変更・新しい承認への乗り換えを成功にしない
            wiring_reason = wiring.check_run(self.layout.root, self.read_state(), req)
        except Exception as exc:
            wiring_reason = "wiring check failed: %s" % type(exc).__name__
        checks["wiring_unchanged"] = wiring_reason is None
        if wiring_reason:
            violations.append("wiring changed or unverifiable at finalize: " + wiring_reason)
        try:
            self.ledger.read_all()
            checks["ledger_valid"] = True
        except ChainError:
            checks["ledger_valid"] = False
            violations.append("ledger invalid")

        from . import supervise
        st_name = entry["state"] if entry else "unknown"
        present = supervise.run_processes_present(self.layout, entry) if entry else None
        if present is None:
            violations.append("process observation unavailable")
        absent = present is False
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
        detail = "task_id: %s" % req["task_id"]
        if entry and entry.get("stop_reason"):
            detail += "（停止の理由: %s）" % entry["stop_reason"]
        self.alert(status, "G10 %s" % status, detail)
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
            remaining = [e["run_id"] for e in running if supervise.run_processes_present(self.layout, e) is not False]
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
