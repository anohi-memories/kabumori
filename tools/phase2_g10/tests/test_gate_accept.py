"""起動ゲート・CLAIM（制御側）と、起動要求の検証・受理（実行側）。仕様 v5 §5-4、v5.3 §2、v5.4 §2。"""
import json
import multiprocessing
import os
import threading
import time
import unittest

from g10runner import jstclock, logs, signing
from g10runner.agent import Agent
from g10runner.control import Control
from g10runner.layout import Layout
from helpers import TRUSTED_ISSUE, Env, make_body, test_policy
from g10runner import policy as policy_mod


class TestClaim(unittest.TestCase):
    def setUp(self):
        self.env = Env()
        self.addCleanup(self.env.cleanup)
        self.c = self.env.control

    def body(self, approval="g10-p2-test-0001", **kw):
        return make_body(self.env.policy, approval_id=approval, **kw)

    def claim(self, body, issue=TRUSTED_ISSUE, ref=None):
        return self.c.try_claim(body, issue, time.time() if ref is None else ref)

    def test_requires_confirm_or_envelope(self):
        run_id, reason = self.claim(self.body())
        self.assertIsNone(run_id)
        self.assertIn("CONFIRM or ENVELOPE", reason)

    def test_confirm_path_and_signed_request(self):
        from g10runner import norm
        body = self.body()
        self.c.confirm("g10-p2-test-0001", norm.compute_hash(body))
        run_id, reason = self.claim(body)
        self.assertIsNotNone(run_id, reason)
        doc = json.load(open(self.env.layout.request_file(run_id)))
        from g10runner.fsutil import canonical
        self.assertTrue(self.env.verifier.verify("runner", canonical(doc["request"]), doc["sig"]))

    def test_confirm_with_other_hash_does_not_authorize(self):
        self.c.confirm("g10-p2-test-0001", "a" * 64)
        self.assertIsNone(self.claim(self.body())[0])

    def test_approval_id_used_once(self):
        self.env.envelope()
        body = self.body()
        self.assertIsNotNone(self.claim(body)[0])
        # 終了扱いにして同時実行枠を空けても、同じ承認IDは二度と使えない
        claims = [r for r in self.c.ledger.read_all() if r["type"] == "CLAIM"]
        self.c.ledger.append("END", {"run_id": claims[0]["payload"]["run_id"], "status": "ended_checks_passed",
                                     "absence_confirmed": True}, self.env.control_signer, "runner", time.time())
        run_id, reason = self.claim(body)
        self.assertIsNone(run_id)
        self.assertIn("already used", reason)

    def test_untrusted_issue(self):
        self.env.envelope()
        for issue in (dict(TRUSTED_ISSUE, author="someone"), dict(TRUSTED_ISSUE, editor="x"),
                      dict(TRUSTED_ISSUE, state="CLOSED"), dict(TRUSTED_ISSUE, number=317)):
            with self.subTest(issue=issue):
                self.assertEqual(self.claim(self.body(), issue=issue), (None, "issue not trusted"))

    def test_hash_mismatch(self):
        self.env.envelope()
        body = self.body().replace("食い違いを、文章で報告", "食い違いを報告", 1)
        run_id, reason = self.claim(body)
        self.assertIsNone(run_id)
        self.assertEqual(reason, "hash mismatch")

    def test_halt_stop_flags_block(self):
        self.env.envelope()
        self.c.stop_on()
        self.assertIn("stopped", self.claim(self.body())[1])
        self.c.stop_off()
        self.c.halt("soft", "t", wait_sync=0)
        self.assertIn("halted", self.claim(self.body())[1])

    def test_clock_rules(self):
        self.env.envelope()
        self.assertEqual(self.claim(self.body(), ref=time.time() + 400)[1], "clock_skew")
        self.assertEqual(self.c.try_claim(self.body(), TRUSTED_ISSUE, None)[1], "reference_clock_unavailable")

    def test_clock_anomaly_halts(self):
        self.env.envelope()
        self.c.ledger.append("ACK_RESULT", {"note": "future"}, self.env.control_signer, "runner", time.time() + 1000)
        run_id, reason = self.claim(self.body())
        self.assertEqual(reason, "CLOCK_ANOMALY")
        self.assertTrue(self.c.read_state().hard_halted)

    def test_envelope_expiry_at_0400_jst(self):
        base = jstclock.next_rollover(time.time()) - 3600  # 失効の1時間前
        clock = {"t": base}
        env = Env(now=lambda: clock["t"])
        self.addCleanup(env.cleanup)
        env.envelope()
        body = make_body(env.policy)
        clock["t"] = jstclock.next_rollover(base) - 1
        self.assertIsNotNone(env.control.try_claim(body, TRUSTED_ISSUE, clock["t"])[0])
        body2 = make_body(env.policy, approval_id="g10-p2-test-0002")
        clock["t"] = jstclock.next_rollover(base)
        run_id, reason = env.control.try_claim(body2, TRUSTED_ISSUE, clock["t"])
        self.assertIsNone(run_id)
        self.assertIn("envelope does not authorize", reason)

    def test_rate_guard_and_unlimited_daily(self):
        env = Env(policy=test_policy(max_concurrent=1000))
        self.addCleanup(env.cleanup)
        env.envelope()
        ok = 0
        for i in range(12):
            run_id, reason = env.control.try_claim(make_body(env.policy, approval_id="g10-p2-rate-%04d" % i),
                                                   TRUSTED_ISSUE, time.time())
            ok += run_id is not None
        self.assertEqual(ok, 10)  # 直近10分で10起動まで
        self.assertIn("rate guard", reason)

    def test_breaker(self):
        self.env.envelope()
        for i in range(3):
            self.c.ledger.append("END", {"run_id": "x%d" % i, "status": "ended_checks_failed",
                                         "absence_confirmed": True}, self.env.control_signer, "runner", time.time())
        self.assertIn("breaker", self.claim(self.body())[1])

    def test_breaker_counts_end_order_and_resets(self):
        recs = [{"type": "END", "payload": {"status": s}} for s in
                ("ended_checks_failed", "ended_checks_failed", "needs_input", "runner_error")]
        self.assertEqual(self.c.consecutive_failures(recs), 1)

    def test_concurrency_limit(self):
        self.env.envelope()
        self.assertIsNotNone(self.claim(self.body("g10-p2-conc-0001"))[0])
        self.assertIn("concurrency", self.claim(self.body("g10-p2-conc-0002"))[1])

    def test_parallel_claims_same_approval(self):
        env = Env(policy=test_policy(max_concurrent=50))
        self.addCleanup(env.cleanup)
        env.envelope()
        body = make_body(env.policy)
        results = []

        def worker():
            results.append(env.control.try_claim(body, TRUSTED_ISSUE, time.time())[0])
        threads = [threading.Thread(target=worker) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(len([r for r in results if r]), 1)


def _accept_worker(root, path, queue):
    from g10runner import policy as pm
    layout = Layout(root)
    signer, verifier = signing.agent_side(root)
    agent = Agent(layout, signer, verifier, pm.load(layout.policy_pub))
    req, _ = agent.load_request(path)
    rec, reason = agent.accept(req)
    queue.put(rec is not None)


class TestAccept(unittest.TestCase):
    def setUp(self):
        self.env = Env()
        self.addCleanup(self.env.cleanup)
        self.env.envelope()
        self.body = make_body(self.env.policy)
        self.run_id, reason = self.env.control.try_claim(self.body, TRUSTED_ISSUE, time.time())
        self.assertIsNotNone(self.run_id, reason)
        self.path = self.env.layout.request_file(self.run_id)

    def verify(self):
        req, reason = self.env.agent.load_request(self.path)
        if req is None:
            return reason
        return self.env.agent.verify_request(req, time.time())

    def test_valid_request(self):
        self.assertIsNone(self.verify())

    def test_tampered_request(self):
        doc = json.load(open(self.path))
        doc["request"]["max_minutes"] = "120"
        json.dump(doc, open(self.path, "w"))
        self.assertEqual(self.verify(), "bad request signature")

    def test_request_signed_with_wrong_key(self):
        doc = json.load(open(self.path))
        from g10runner.fsutil import canonical
        doc["sig"] = signing.HmacTestSigner({"runner": b"forged"}).sign("runner", canonical(doc["request"]))
        json.dump(doc, open(self.path, "w"))
        self.assertEqual(self.verify(), "bad request signature")

    def test_expired_request(self):
        req, _ = self.env.agent.load_request(self.path)
        self.assertIn("expired", self.env.agent.verify_request(req, req["expires_at"]))

    def test_revoke_after_claim(self):
        env_id = self.env.control.read_state().envelope["envelope_id"]
        self.env.control.revoke_envelope(env_id)
        self.assertIn("not authorized", self.verify())

    def test_halt_after_claim(self):
        self.env.control.halt("soft", "t", wait_sync=0)
        self.assertEqual(self.verify(), "halted")

    def test_policy_change_after_claim(self):
        Control.install_policy(self.env.layout, test_policy(version="policy-v9"))
        self.assertEqual(self.verify(), "policy digest mismatch")

    def test_rewind_makes_agent_halt(self):
        self.env.control.stop_on()
        self.env.control.stop_off()
        self.env.agent.current_state()
        with open(self.env.layout.control_events, encoding="utf-8") as f:
            lines = f.read().splitlines()
        with open(self.env.layout.control_events, "w", encoding="utf-8") as f:
            f.write("\n".join(lines[:-1]) + "\n")
        self.assertIn("control log invalid", self.verify())
        self.assertTrue(os.path.exists(self.env.layout.agent_halt_flag))
        self.assertTrue(self.env.control.read_state().agent_halts)

    def test_replay_rejected(self):
        req, _ = self.env.agent.load_request(self.path)
        self.assertIsNotNone(self.env.agent.accept(req)[0])
        self.assertIsNone(self.env.agent.accept(req)[0])
        for key in ("request_id", "approval_id", "run_id"):
            with self.subTest(reused=key):
                other = dict(req, request_id="req-new", approval_id="g10-new-appr", run_id="run-new")
                other[key] = req[key]
                self.assertIsNone(self.env.agent.accept(other)[0])

    def test_parallel_accept_single_winner(self):
        ctx = multiprocessing.get_context("spawn")
        q = ctx.Queue()
        ps = [ctx.Process(target=_accept_worker, args=(self.env.tmp, self.path, q)) for _ in range(6)]
        for p in ps:
            p.start()
        for p in ps:
            p.join(30)
        wins = sum(1 for _ in ps if q.get(timeout=5))
        self.assertEqual(wins, 1)


if __name__ == "__main__":
    unittest.main()
