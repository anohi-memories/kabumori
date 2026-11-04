"""TASK 5 の個別試験: 起動直前の再取得証拠・ISSUE_REVOKE（取消）と起動の両方向の競合・finalize の再照合。"""
import json
import os
import threading
import time

from g10runner import issue as issue_mod, registry, signing, state
from g10runner.fsutil import canonical
from helpers import EnvTestCase, FAST_TIMING, TRUSTED_ISSUE, make_body


def wait_for(path, timeout=10):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if os.path.exists(path):
            return True
        time.sleep(0.02)
    return False


class Base(EnvTestCase):
    def setUp(self):
        super().setUp()
        self.env.envelope()
        self.env.s2_heartbeat()
        self.body = make_body(self.env.policy)
        self.env.issue.publish(self.body)
        self.marker = os.path.join(self.env.tmp, "started")

    def claim(self):
        run_id, reason = self.env.control.try_claim(self.body, TRUSTED_ISSUE, time.time())
        self.assertIsNotNone(run_id, reason)
        return run_id

    def handle(self, run_id, hooks=None, scenario=None):
        if hooks:
            os.makedirs(self.env.layout.run_dir(run_id), exist_ok=True)
            json.dump(hooks, open(os.path.join(self.env.layout.run_dir(run_id), "test_hooks.json"), "w"))
        scen = dict(scenario or {}, started_marker=self.marker)
        return self.env.agent.handle_request_file(self.env.layout.request_file(run_id), scenario=scen)

    def revoke(self, **kw):
        kw.setdefault("task_id", "g10-phase2-test-20261022")
        return self.env.control.revoke_issue(reason="test", **kw)


class RevokeBeforeSpawn(Base):
    def test_revoke_after_claim_is_rejected_before_accept(self):
        run_id = self.claim()
        self.revoke()
        stub, reason = self.handle(run_id)
        self.assertIsNone(stub)
        self.assertEqual(reason, "issue revoked")
        self.assertEqual(self.env.agent.used.read_all(), [])

    def test_revoke_after_accept_before_final_check(self):
        """ACCEPTED の後・最終判定の前の取消 → 最終判定（共有ロックの下）で起動しない。"""
        run_id = self.claim()
        stub, reason = self.handle(run_id, hooks={"before_T6a": {"mark": True, "sleep": 1.0}})
        self.assertIsNotNone(stub, reason)
        self.assertTrue(wait_for(os.path.join(self.env.layout.run_dir(run_id), "hook_before_T6a.reached")))
        self.revoke()
        stub.wait(timeout=30)
        e = self.wait_terminal(run_id)
        self.assertEqual(e["state"], "aborted_before_spawn")
        self.assertEqual(e["abort_reason"], "issue revoked")
        self.assertFalse(os.path.exists(self.marker))
        self.assertNotIn("SPAWNED", self.env.agent.used_state(run_id))

    def test_new_claim_for_revoked_task_refused_even_after_unhalt(self):
        self.revoke()
        self.env.control.halt("soft", "x", wait_sync=0)
        rec, problems = self.env.control.unhalt("ack")
        self.assertIsNotNone(rec, problems)
        run_id, reason = self.env.control.try_claim(self.body, TRUSTED_ISSUE, time.time())
        self.assertIsNone(run_id)
        self.assertEqual(reason, "issue revoked")

    def test_revoke_scope(self):
        st = state.ControlState()
        st.issue_revokes = [{"task_id": "t1", "approval_id": "a1", "task_sha256": None}]
        self.assertTrue(state.issue_revoked(st, {"task_id": "t1", "approval_id": "a1", "task_sha256": "x"}))
        self.assertFalse(state.issue_revoked(st, {"task_id": "t1", "approval_id": "a2", "task_sha256": "x"}))
        self.assertFalse(state.issue_revoked(st, {"task_id": "t2", "approval_id": "a1", "task_sha256": "x"}))
        st.issue_revokes = [{"task_id": "t1", "approval_id": None, "task_sha256": "h"}]
        self.assertTrue(state.issue_revoked(st, {"task_id": "t1", "approval_id": "z", "task_sha256": "h"}))
        self.assertFalse(state.issue_revoked(st, {"task_id": "t1", "approval_id": "z", "task_sha256": "other"}))
        st.issue_revokes = [{"task_id": "", "approval_id": None, "task_sha256": None}]
        self.assertFalse(state.issue_revoked(st, {"task_id": "", "approval_id": None}))

    def test_revoke_requires_task_id(self):
        with self.assertRaises(ValueError):
            self.env.control.revoke_issue(task_id="")


class RevokeAfterSpawn(Base):
    def test_revoke_while_stub_holds_lock_lands_after_spawn_and_stops_the_run(self):
        """起動の確定（共有ロック内）と取消（排他ロック）の競合: 取消は起動の確定の後に線形化され、S1 が止める。"""
        run_id = self.claim()
        stub, reason = self.handle(run_id, hooks={"before_spawn": {"mark": True, "sleep": 0.8}},
                                   scenario={"sleep": 30})
        self.assertIsNotNone(stub, reason)
        self.assertTrue(wait_for(os.path.join(self.env.layout.run_dir(run_id), "hook_before_spawn.reached")))
        t0 = time.time()
        self.revoke()  # 共有ロックが解放されるまで待たされる
        self.assertGreater(time.time() - t0, 0.3, "revoke should wait for the stub's critical section")
        self.assertIn("SPAWNED", self.env.agent.used_state(run_id))
        stub.wait(timeout=30)
        e = self.wait_terminal(run_id)
        self.assertEqual(e["state"], "interrupted")
        self.assertEqual(e["stop_reason"], "issue_revoked")
        status, end = self.env.control.finalize(run_id, current_body=self.body)
        self.assertNotEqual(status, "ended_checks_passed")
        self.assertFalse(end["payload"]["checks"]["issue_not_revoked"])

    def test_restart_after_crash_does_not_bypass_revoke(self):
        run_id = self.claim()
        stub, reason = self.handle(run_id, hooks={"before_T6a": {"exit": True, "code": 9}})
        stub.wait(timeout=30)
        self.revoke()
        self.env.agent.recover()
        self.assertEqual(self.env.agent.used_state(run_id)[-1], "ABORTED")
        stub2 = self.env.agent.spawn_stub(run_id)  # 二度目の起動
        self.assertEqual(stub2.wait(timeout=30), 3)
        self.assertFalse(os.path.exists(self.marker))


class SpawnEvidenceUnit(EnvTestCase):
    def setUp(self):
        super().setUp()
        self.body = make_body(self.env.policy)
        self.env.issue.publish(self.body, updated_at=time.time() - 30)
        self.claim_doc = self.env.witness.observe("claim")
        self.req = {"run_id": "run-0123456789abcdef", "request_id": "req-0123456789abcdef"}
        self.nonce = issue_mod.spawn_nonce(self.req, "evt-1")
        self.accepted_ts = time.time() - 1

    def spawn_doc(self, nonce=None, purpose="spawn"):
        return self.env.witness.observe(purpose, self.nonce if nonce is None else nonce)

    def check(self, doc, now=None, accepted_ts=None):
        return issue_mod.check_spawn_evidence(doc, self.claim_doc, self.env.verifier, self.body,
                                              time.time() if now is None else now, 10.0, self.nonce,
                                              self.accepted_ts if accepted_ts is None else accepted_ts)

    def assertReason(self, reason, text):
        self.assertIsNotNone(reason, "evidence was accepted")  # None のまま assertIn に渡すと例外になるため先に判定
        self.assertIn(text, reason)

    def test_valid(self):
        self.assertIsNone(self.check(self.spawn_doc()))

    def test_other_run_nonce_or_purpose(self):
        self.assertReason(self.check(self.spawn_doc(nonce="spawn:other")), "another purpose or run")
        self.assertReason(self.check(self.claim_doc), "another purpose or run")  # CLAIM 時の証拠の使い回し
        self.assertReason(self.check(self.env.witness.observe("postflight", self.nonce)), "another purpose or run")

    def test_short_ttl(self):
        doc = self.spawn_doc()
        fetched = doc["evidence"]["fetched_at"]
        self.assertIsNone(self.check(doc, now=fetched + 10.0))
        self.assertReason(self.check(doc, now=fetched + 10.001), "stale")

    def test_fetched_before_accepted(self):
        doc = self.spawn_doc()
        self.assertReason(self.check(doc, accepted_ts=doc["evidence"]["fetched_at"] + 0.5), "before ACCEPTED")

    def test_generation_changed(self):
        self.env.issue.publish(self.body)  # 同じ本文・新しい updated_at
        self.assertReason(self.check(self.spawn_doc()), "generation")

    def test_closed(self):
        self.env.issue.publish(self.body, state="CLOSED", updated_at=self.claim_doc["evidence"]["updated_at"])
        self.assertReason(self.check(self.spawn_doc()), "not open")

    def test_signed_by_runner_key(self):
        doc = self.spawn_doc()
        doc["sig"] = self.env.control_signer.sign("runner", canonical(doc["evidence"]))
        self.assertReason(self.check(doc), "signature invalid")


class SpawnWitnessFailures(Base):
    policy_overrides = {"timing": dict(FAST_TIMING, issue_fetch_timeout=0.3)}

    def test_fetch_timeout_blocks_spawn(self):
        run_id = self.claim()
        self.env.issue.delay = 1.0  # 打ち切り（0.3秒）を超える遅れ
        stub, reason = self.handle(run_id)
        self.assertIsNotNone(stub, reason)
        stub.wait(timeout=30)
        e = self.wait_terminal(run_id)
        self.assertEqual(e["state"], "aborted_before_spawn")
        self.assertIn("issue re-fetch failed at spawn", e["abort_reason"])
        self.assertFalse(os.path.exists(self.marker))

    def test_no_spawn_witness_for_non_fake_adapter(self):
        self.assertIsNone(issue_mod.spawn_witness(self.env.tmp, dict(self.env.policy, adapter="claude")))

    def test_missing_witness_key_blocks_spawn_witness(self):
        keys = signing.test_keys()
        keys.pop("witness")
        signing.write_test_keys(self.env.tmp, keys)
        self.assertIsNone(issue_mod.spawn_witness(self.env.tmp, self.env.policy))


class FinalizeRecheck(Base):
    def test_generation_change_after_run(self):
        run_id = self.claim()
        stub, reason = self.handle(run_id)
        stub.wait(timeout=30)
        self.wait_terminal(run_id)
        self.env.issue.publish(self.body)  # 同じ本文で世代だけ変わる
        status, end = self.env.control.finalize(run_id, current_body=self.body)
        self.assertNotEqual(status, "ended_checks_passed")
        self.assertFalse(end["payload"]["checks"]["issue_state_unchanged"])
        self.assertTrue(any("generation" in v for v in end["payload"]["safety_violations"]))

    def test_unchanged_issue_passes(self):
        run_id = self.claim()
        stub, reason = self.handle(run_id)
        stub.wait(timeout=30)
        self.wait_terminal(run_id)
        status, end = self.env.control.finalize(run_id, current_body=self.body)
        self.assertEqual(status, "ended_checks_passed", end["payload"])
        self.assertTrue(os.path.exists(os.path.join(self.env.layout.run_dir(run_id), "spawn_evidence.json")))
