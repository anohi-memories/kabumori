"""クラッシュ位置ごとの復旧（仕様 v5 §8-3、v5.4 §2-2）と、制御側×実行側の照合。"""
import json
import os
import subprocess
import sys
import time

from g10runner import procs, registry, supervise
from g10runner.adapter import FAKE_CLAUDE
from helpers import EnvTestCase, TRUSTED_ISSUE, make_body


class TestCrashPoints(EnvTestCase):
    def setUp(self):
        super().setUp()
        self.env.envelope()
        self.env.s2_heartbeat()

    def test_crash_after_accepted_before_stub(self):
        body = make_body(self.env.policy)
        run_id, _ = self.env.control.try_claim(body, TRUSTED_ISSUE, time.time())
        req, _ = self.env.agent.load_request(self.env.layout.request_file(run_id))
        self.assertIsNotNone(self.env.agent.accept(req)[0])
        actions = self.env.agent.recover()
        self.assertIn((run_id, "accepted", True), actions)
        self.assertEqual(self.env.agent.used_state(run_id), ["ACCEPTED", "ABORTED"])
        # 再送しても二度と受理しない
        self.assertIsNone(self.env.agent.accept(req)[0])

    def test_crash_after_T2(self):
        run_id, stub, body = self.claim_and_run(hooks={"after_T2": {"exit": True}}, wait=False)
        stub.wait(timeout=30)
        time.sleep(0.3)
        actions = supervise.watchdog_cycle(self.env.layout, self.env.policy, self.env.agent)
        e = registry.load(self.env.layout, run_id)
        self.assertEqual(e["state"], "runner_crashed")
        self.env.agent.recover()
        self.assertEqual(self.env.agent.used_state(run_id), ["ACCEPTED", "ABORTED"])
        status, _ = self.env.control.finalize(run_id, current_body=body)
        self.assertEqual(status, "runner_crashed")

    def test_crash_after_spawning_before_spawn(self):
        run_id, stub, body = self.claim_and_run(hooks={"before_spawn": {"exit": True}}, wait=False)
        stub.wait(timeout=30)
        time.sleep(0.5)
        supervise.watchdog_cycle(self.env.layout, self.env.policy, self.env.agent)
        actions = self.env.agent.recover()
        self.assertEqual(self.env.agent.used_state(run_id), ["ACCEPTED", "SPAWNING", "ABORTED"])
        e = registry.load(self.env.layout, run_id)
        self.assertIn(e["state"], ("runner_crashed", "interrupted"))
        self.assertFalse(procs.find_by_marker(registry.marker(e)))

    def test_crash_after_spawn(self):
        run_id, stub, body = self.claim_and_run(scenario={"sleep": 0.5}, hooks={"after_spawn": {"exit": True}},
                                                wait=False)
        stub.wait(timeout=30)
        e = self.wait_terminal(run_id)
        self.assertEqual(e["state"], "runner_crashed")
        self.assertFalse(procs.find_by_marker(registry.marker(e)))
        status, _ = self.env.control.finalize(run_id, current_body=body)
        self.assertEqual(status, "runner_crashed")


class TestReconcile(EnvTestCase):
    def setUp(self):
        super().setUp()
        self.env.envelope()

    def test_accepted_without_claim_halts(self):
        self.env.agent.used.append("ACCEPTED", {"request_id": "req-x", "approval_id": "appr-x", "run_id": "run-x"},
                                   self.env.agent_signer, "agent", time.time())
        problems = self.env.control.reconcile()
        self.assertTrue(problems)
        self.assertTrue(self.env.control.read_state().hard_halted)

    def test_consistent_logs_pass(self):
        body = make_body(self.env.policy)
        run_id, _ = self.env.control.try_claim(body, TRUSTED_ISSUE, time.time())
        req, _ = self.env.agent.load_request(self.env.layout.request_file(run_id))
        self.env.agent.accept(req)
        self.assertEqual(self.env.control.reconcile(), [])


class TestOrphansAndTamper(EnvTestCase):
    def setUp(self):
        super().setUp()
        self.env.envelope()
        self.env.s2_heartbeat()

    def test_orphan_process_is_killed_and_halts(self):
        run_id, stub, body = self.claim_and_run()
        e = registry.load(self.env.layout, run_id)
        scen = os.path.join(self.env.tmp, "orphan_scen.json")
        json.dump({"sleep": 30}, open(scen, "w"))
        p = subprocess.Popen([sys.executable, "-I", FAKE_CLAUDE, "--session-id", e["session_id"], "--settings", "x",
                              "--model", "m", "--effort", "low", "--output-format", "json",
                              "--max-budget-usd", "0.01"], env={"FAKE_CLAUDE_SCENARIO": scen},
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(0.5)
        actions = supervise.watchdog_cycle(self.env.layout, self.env.policy, self.env.agent)
        self.assertIn((run_id, "orphan"), actions)
        p.wait(timeout=10)
        self.assertTrue(self.env.control.read_state().agent_halts)

    def test_registry_tamper_detected_by_watchdog(self):
        run_id, stub, body = self.claim_and_run()
        path = self.env.layout.proc_file(run_id)
        d = json.load(open(path))
        d["session_id"] = "other"
        json.dump(d, open(path, "w"))
        supervise.watchdog_cycle(self.env.layout, self.env.policy, self.env.agent)
        self.assertTrue(self.env.control.read_state().agent_halts)
