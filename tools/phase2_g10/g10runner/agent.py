"""実行プレーン（専用ユーザー側）: 起動要求の独立した検証・受理・スタブの起動・HALT_AGENT・復旧。
仕様 v5.3 §2、v5.4 §1-2・§1-3・§2。

本TASKでは、実行プレーンも同じユーザーで動くモック（macOS別UIDは未実装）。
"""
import json
import os
import subprocess
import sys
import time

from . import binding, jstclock, logs, policy as policy_mod, procs, registry, state
from .chainlog import ChainError, record_hash
from .fsutil import atomic_write_json, canonical, read_json, touch

PACKAGE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STUB_SCRIPT = os.path.join(PACKAGE_ROOT, "bin", "g10_stub.py")
REQUIRED_REQUEST_FIELDS = ("request_id", "run_id", "approval_id", "task_id", "session_id", "task_sha256",
                           "prompt", "base_ref", "base_sha", "model", "model_id", "effort", "max_minutes",
                           "max_budget_usd", "policy_sha256", "authorization", "claim_seq",
                           "issued_at", "reference_time", "expires_at", "phase2_scope",
                           "production_permission", "report_mode")


class Agent:
    def __init__(self, layout, signer, verifier, policy, now=time.time):
        self.layout = layout
        self.signer = signer
        self.verifier = verifier
        self.policy = policy
        self.now = now
        self.control = logs.control_log(layout, verifier)
        self.agent_events = logs.agent_log(layout, verifier)
        self.used = logs.used_log(layout, verifier)

    # --- 実行側の HALT ---
    def halt_agent(self, reason, details=None):
        touch(self.layout.agent_halt_flag)
        return self.agent_events.append("HALT_AGENT", {"reason": reason, "details": details or {}},
                                        self.signer, "agent", self.now())

    def sync_flags(self):
        """実行側のHALTフラグ（合図）を、ログから導いた状態に合わせる。解除は、署名つきUNHALTが
        実行側の HALT_AGENT をすべて対象にしたときだけ（ログが正本）。"""
        try:
            st = self.current_state(update_seen=False)
        except (ChainError, state.RewindError):
            return False
        if not st.agent_halts and os.path.exists(self.layout.agent_halt_flag):
            os.remove(self.layout.agent_halt_flag)
        return True

    # --- 状態（制御側のログを最新まで処理し、巻き戻りを検知） ---
    def current_state(self, update_seen=True):
        try:
            control_events = self.control.read_all()
            agent_events = self.agent_events.read_all()
            state.check_seen(self.layout, control_events, update=update_seen)
        except (ChainError, state.RewindError) as exc:
            self.halt_agent("control_log_invalid", {"error": str(exc)})
            raise
        return state.derive(control_events, agent_events)

    # --- 起動要求の検証（制御側を信用しない） ---
    def load_request(self, path):
        doc = read_json(path)
        if not isinstance(doc, dict) or "request" not in doc or "sig" not in doc:
            return None, "malformed request"
        req = doc["request"]
        if not isinstance(req, dict) or not self.verifier.verify("runner", canonical(req), doc["sig"]):
            return None, "bad request signature"
        for key in REQUIRED_REQUEST_FIELDS:
            if key not in req:
                return None, "request missing field: " + key
        # H3 R1: runner の署名だけを信用せず、承認済みTASK・インストール済みポリシーとの結合を検証する
        reason, _ = binding.check_request(req, policy_mod.load(self.layout.policy_pub))
        if reason:
            return None, reason
        return req, None

    def verify_request(self, req, local_now):
        reason, _ = binding.check_request(req, policy_mod.load(self.layout.policy_pub))
        if reason:
            return reason
        if not (req["issued_at"] - jstclock.CLOCK_TOLERANCE_SECONDS <= local_now < req["expires_at"]):
            return "request expired or not yet valid"
        if req["policy_sha256"] != policy_mod.load(self.layout.policy_pub)["_digest"]:
            return "policy digest mismatch"
        try:
            st = self.current_state()
        except (ChainError, state.RewindError) as exc:
            return "control log invalid: %s" % exc
        if st.halted or state.flags_say_halt(self.layout):
            return "halted"
        if st.stopped or state.flags_say_stop(self.layout):
            return "stopped"
        reference_now = req["reference_time"] + (local_now - req["issued_at"])
        if not state.authorization_ok(st, req, local_now, reference_now):
            return "not authorized (envelope/confirm invalid, revoked, expired or out of range)"
        return None

    def accept(self, req):
        """ACCEPTED を、スタブの起動前に永続化する。request_id・approval_id・run_id のどれかが使用済みなら拒否。"""
        ids = (req["request_id"], req["approval_id"], req["run_id"])

        def unused(records):
            for rec in records:
                p = rec["payload"]
                if p.get("request_id") in ids[:1] or p.get("approval_id") == ids[1] or p.get("run_id") == ids[2]:
                    return False, "request/approval/run already used"
            return True, None

        rec, reason = self.used.append_if("ACCEPTED", {"request_id": ids[0], "approval_id": ids[1],
                                                       "run_id": ids[2]},
                                          self.signer, "agent", self.now(), unused)
        return rec, reason

    def used_state(self, run_id):
        states = [r["type"] for r in self.used.read_all() if r["payload"].get("run_id") == run_id]
        return states

    def mark(self, rtype, req, extra=None):
        payload = {"request_id": req["request_id"], "approval_id": req["approval_id"], "run_id": req["run_id"]}
        payload.update(extra or {})
        return self.used.append(rtype, payload, self.signer, "agent", self.now())

    def handle_request_file(self, path, scenario=None):
        """listener の1件分: 検証 → ACCEPTED → スタブの起動。戻り値: (stub Popen または None, 理由)。"""
        req, reason = self.load_request(path)
        if req is None:
            return None, reason
        reason = self.verify_request(req, self.now())
        if reason:
            return None, reason
        rec, reason = self.accept(req)
        if rec is None:
            return None, reason
        run_dir = self.layout.run_dir(req["run_id"])
        os.makedirs(run_dir, exist_ok=True)
        atomic_write_json(os.path.join(run_dir, "request.json"), json.loads(json.dumps(read_json(path))))
        if scenario is not None:
            atomic_write_json(os.path.join(run_dir, "scenario.json"), scenario)
        return self.spawn_stub(req["run_id"]), None

    def spawn_stub(self, run_id, extra_env=None):
        run_dir = self.layout.run_dir(run_id)
        env = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}
        env.update(extra_env or {})
        out = open(os.path.join(run_dir, "stub.out"), "ab")
        try:
            return subprocess.Popen([sys.executable, "-I", STUB_SCRIPT, "--root", self.layout.root,
                                     "--run-id", run_id], stdout=out, stderr=subprocess.STDOUT,
                                    env=env, start_new_session=True, close_fds=True)
        finally:
            out.close()

    # --- 復旧（v5.4 §2-2 の表） ---
    def recover(self):
        """ACCEPTED だけ・SPAWNING だけで止まったランを処理する。再実行はしない。"""
        actions = []
        by_run = {}
        for rec in self.used.read_all():
            by_run.setdefault(rec["payload"]["run_id"], []).append(rec)
        for run_id, recs in by_run.items():
            types = [r["type"] for r in recs]
            last = recs[-1]["payload"]
            req_like = {"request_id": last["request_id"], "approval_id": last["approval_id"], "run_id": run_id}
            if "ABORTED" in types or "SPAWNED" in types:
                continue
            entry = None
            try:
                entry = registry.load(self.layout, run_id)
            except (registry.RegistryError, ValueError):
                entry = None
            try:
                stub_alive = bool(entry and procs.identity_ok(entry.get("stub_pid"), entry.get("stub_start")))
            except procs.ObservationError:
                actions.append((run_id, "observation_unavailable", False))
                continue  # 観測できない間は、中止も再実行もしない
            if stub_alive:
                continue
            if "SPAWNING" in types:
                from . import supervise
                if entry:
                    details = procs.terminate(supervise.collector(self.layout, entry),
                                              policy_mod.timing(self.policy, "grace_seconds"),
                                              policy_mod.timing(self.policy, "confirm_seconds"))
                else:
                    details = {"absent": False, "unknown": True, "error": "no registry entry"}
                absent = details["absent"]
                self.mark("ABORTED", req_like, {"reason": "runner_crashed_spawning", "absent": absent})
                if entry and entry["state"] in registry.NON_TERMINAL:
                    registry.update(self.layout, run_id, "runner_crashed" if absent else "stop_unconfirmed",
                                    stop_details=details)
                if not absent:
                    self.halt_agent("stop_unconfirmed", {"run_id": run_id})
                actions.append((run_id, "spawning", absent))
            else:
                self.mark("ABORTED", req_like, {"reason": "runner_crashed_accepted"})
                if entry and entry["state"] == "starting":
                    registry.update(self.layout, run_id, "runner_crashed")
                actions.append((run_id, "accepted", True))
        return actions

    def head(self):
        return self.used.head(self.used.read_all())


def used_record_hash(rec):
    return record_hash(rec)
