"""追記専用ログ（署名・連鎖・巻き戻り）と、状態の導出（仕様 v5.4 §1）。"""
import json
import os
import time
import unittest

from g10runner import jstclock, logs, signing, state
from g10runner.chainlog import ChainError
from helpers import Env


class TestChainLog(unittest.TestCase):
    def setUp(self):
        self.env = Env()
        self.addCleanup(self.env.cleanup)
        self.log = logs.control_log(self.env.layout, self.env.verifier)

    def append_some(self, n=3):
        for i in range(n):
            self.log.append("STOP", {"i": i}, self.env.control_signer, "runner", time.time())

    def test_append_and_verify(self):
        self.append_some()
        recs = self.log.read_all()
        self.assertEqual([r["seq"] for r in recs], [1, 2, 3])

    def rewrite(self, fn):
        with open(self.log.path, encoding="utf-8") as f:
            lines = f.read().splitlines()
        lines = fn(lines)
        with open(self.log.path, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + ("\n" if lines else ""))

    def test_tamper_detected(self):
        self.append_some()

        def edit_payload(lines):
            rec = json.loads(lines[1])
            rec["payload"]["i"] = 99
            lines[1] = json.dumps(rec, sort_keys=True)
            return lines
        cases = {
            "modified record": edit_payload,
            "deleted middle": lambda ls: [ls[0], ls[2]],
            "reordered": lambda ls: [ls[1], ls[0], ls[2]],
            "garbage": lambda ls: ls + ["{not json"],
        }
        for name, fn in cases.items():
            with self.subTest(case=name):
                self.setUp()
                self.append_some()
                self.rewrite(fn)
                with self.assertRaises(ChainError):
                    self.log.read_all()

    def test_truncated_last_line(self):
        self.append_some()
        with open(self.log.path, "a") as f:
            f.write('{"seq": 4')
        with self.assertRaises(ChainError):
            self.log.read_all()

    def test_bad_signature_and_role(self):
        forger = signing.HmacTestSigner({"runner": b"wrong-key", "human": b"wrong-key"})
        self.log.append("STOP", {}, forger, "runner", time.time())
        with self.assertRaises(ChainError):
            self.log.read_all()

    def test_runner_cannot_sign_human_events(self):
        with self.assertRaises(ChainError):
            self.log.append("UNHALT", {}, self.env.control_signer, "runner", time.time())
        with self.assertRaises(ChainError):
            self.log.append("ENVELOPE_APPROVE", {}, self.env.control_signer, "runner", time.time())

    def test_agent_cannot_sign_control_events(self):
        with self.assertRaises(signing.SignatureError):
            self.log.append("STOP", {}, self.env.agent_signer, "runner", time.time())


class TestState(unittest.TestCase):
    def setUp(self):
        self.env = Env()
        self.addCleanup(self.env.cleanup)
        self.c = self.env.control

    def st(self):
        return self.c.read_state()

    def test_halt_and_unhalt_cover_both_sides(self):
        self.c.halt("soft", "test", wait_sync=0)
        self.env.agent.halt_agent("agent test")
        self.assertTrue(self.st().halted)
        rec, problems = self.c.unhalt("ok")
        self.assertEqual(problems, [])
        self.assertFalse(self.st().halted)

    def test_unhalt_does_not_cover_later_agent_halt(self):
        self.c.halt("soft", "test", wait_sync=0)
        self.c.unhalt("ok")
        self.env.agent.halt_agent("later")
        self.assertTrue(self.st().halted)
        self.assertTrue(self.st().hard_halted)

    def test_partial_unhalt_is_ignored(self):
        self.c.halt("soft", "a", wait_sync=0)
        self.c.halt("soft", "b", wait_sync=0)
        first = list(self.st().control_halts)[0]
        self.c.append_control("UNHALT", {"halt_ids": [first], "agent_halt_ids": [], "agent_head_seq": 0}, "human")
        st = self.st()
        self.assertTrue(st.halted)
        self.assertTrue(any("does not cover" in p for p in st.problems))

    def test_flag_deletion_does_not_unhalt(self):
        self.c.halt("hard", "x", wait_sync=0)
        os.remove(self.env.layout.halt_flag)
        self.assertTrue(self.st().halted)
        self.assertTrue(self.st().hard_halted)

    def test_stop_and_stop_off(self):
        self.c.stop_on()
        self.assertTrue(self.st().stopped)
        self.c.stop_off()
        self.assertFalse(self.st().stopped)

    def test_envelope_lifecycle(self):
        e1 = self.env.envelope()
        self.assertEqual(self.st().envelope["envelope_id"], e1["payload"]["envelope_id"])
        e2 = self.env.envelope()
        self.assertEqual(self.st().envelope["envelope_id"], e2["payload"]["envelope_id"])  # 置き換え
        self.c.revoke_envelope(e2["payload"]["envelope_id"])
        self.assertIsNone(self.st().envelope)

    def test_envelope_expiry_mismatch_rejected(self):
        payload = {"envelope_id": "bad", "approved_at": time.time(), "expires_at": time.time() + 999999}
        self.c.append_control("ENVELOPE_APPROVE", payload, "human")
        st = self.st()
        self.assertIsNone(st.envelope)
        self.assertTrue(any("expires_at" in p for p in st.problems))

    def test_rewind_detection(self):
        for _ in range(3):
            self.c.stop_on()
        events = logs.control_log(self.env.layout, self.env.verifier).read_all()
        state.check_seen(self.env.layout, events)
        with open(self.env.layout.control_events, encoding="utf-8") as f:
            lines = f.read().splitlines()
        with open(self.env.layout.control_events, "w", encoding="utf-8") as f:
            f.write("\n".join(lines[:2]) + "\n")
        events2 = logs.control_log(self.env.layout, self.env.verifier).read_all()
        with self.assertRaises(state.RewindError):
            state.check_seen(self.env.layout, events2)

    def test_whole_log_and_seen_rolled_back_together_is_a_known_limit(self):
        """ログと処理済み番号を一緒に古い状態へ戻すと、連鎖だけでは検出できない（v5.4 残存リスク）。
        復元・再導入時は、履歴照合までHALTとする運用で補う。ここでは限界を記録する。"""
        self.c.stop_on()
        events = logs.control_log(self.env.layout, self.env.verifier).read_all()
        state.check_seen(self.env.layout, events)
        snap_log = open(self.env.layout.control_events, "rb").read()
        snap_seen = open(self.env.layout.control_seen, "rb").read()
        self.c.halt("hard", "after snapshot", wait_sync=0)
        open(self.env.layout.control_events, "wb").write(snap_log)
        open(self.env.layout.control_seen, "wb").write(snap_seen)
        events3 = logs.control_log(self.env.layout, self.env.verifier).read_all()
        state.check_seen(self.env.layout, events3)  # 検出できない（既知の限界）
        self.assertFalse(state.derive(events3, []).control_halts)

    def test_authorization_envelope_range_and_expiry(self):
        env_rec = self.env.envelope(max_minutes_cap=30)
        st = self.st()
        req = {"authorization": "envelope", "envelope_id": env_rec["payload"]["envelope_id"],
               "phase2_scope": "readonly_trial", "model": "sonnet", "model_id": "claude-sonnet-5-5",
               "effort": "medium", "max_minutes": "10", "max_budget_usd": "0.50", "base_ref": "refs/heads/main",
               "policy_sha256": self.env.policy["_digest"], "production_permission": "NO_GO",
               "report_mode": "local_only"}
        now = time.time()
        self.assertTrue(state.authorization_ok(st, req, now, now))
        for key, value in (("max_minutes", "31"), ("effort", "max"), ("model_id", "claude-opus-5-5"),
                           ("max_budget_usd", "0.60"), ("base_ref", "refs/tags/x"), ("phase2_scope", "code"),
                           ("production_permission", "GO"), ("report_mode", "github")):
            with self.subTest(key=key):
                self.assertFalse(state.authorization_ok(st, dict(req, **{key: value}), now, now))
        exp = st.envelope["expires_at"]
        self.assertFalse(state.authorization_ok(st, req, exp, exp - 1))
        self.assertFalse(state.authorization_ok(st, req, exp - 1, exp))


if __name__ == "__main__":
    unittest.main()
