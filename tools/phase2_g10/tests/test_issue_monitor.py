"""TASK 7 の個別試験: 実行中の Issue 監督（S1 の別スレッド・S2 の予備）、取消・HALT の優先、監査記録、誤停止しないこと。"""
import json
import os
import threading
import time
import unittest
from unittest import mock

from g10runner import procs, registry, supervise
from g10runner.layout import Layout
from helpers import EnvTestCase, FAST_TIMING, make_body, test_policy

MONITOR = dict(FAST_TIMING, issue_monitor_interval=0.3)


def monitor_records(env, run_id):
    path = os.path.join(env.layout.run_dir(run_id), "issue_monitor.jsonl")
    if not os.path.exists(path):
        return []
    return [json.loads(line) for line in open(path, encoding="utf-8")]


class Base(EnvTestCase):
    policy_overrides = {"timing": MONITOR}

    def setUp(self):
        super().setUp()
        self.env.envelope()
        self.env.s2_heartbeat()

    def start_running(self, sleep=30):
        body = make_body(self.env.policy, max_minutes="60")
        run_id, stub, body = self.claim_and_run(body=body, scenario={"sleep": sleep}, wait=False)
        self.addCleanup(lambda: (stub.poll() is None and stub.kill(), stub.wait(timeout=30)))
        deadline = time.time() + 20
        e = None
        while time.time() < deadline:
            e = registry.load(self.env.layout, run_id)
            if e and e["state"] == "running":
                break
            time.sleep(0.02)
        self.addCleanup(self._kill, e["child_pid"])
        return run_id, stub, body, e

    @staticmethod
    def _kill(pid):
        try:
            os.kill(pid, 9)
        except OSError:
            pass

    def wait_state(self, run_id, timeout=5):
        deadline = time.time() + timeout
        while time.time() < deadline:
            e = registry.load(self.env.layout, run_id)
            if e["state"] not in registry.NON_TERMINAL:
                return e
            time.sleep(0.02)
        return registry.load(self.env.layout, run_id)


class NoFalseStop(Base):
    def test_unchanged_issue_runs_to_completion(self):
        run_id, stub, body, e = self.start_running(sleep=1.5)
        stub.wait(timeout=30)
        self.wait_terminal(run_id)
        status, end = self.env.control.finalize(run_id, current_body=body)
        self.assertEqual(status, "ended_checks_passed", end["payload"])
        recs = monitor_records(self.env, run_id)
        self.assertTrue(recs and all(r["ok"] for r in recs), recs)  # 監督は複数回照合し、すべて正常

    def test_s2_does_not_recheck_while_s1_monitor_is_healthy(self):
        run_id, stub, body, e = self.start_running()
        hb = os.path.join(self.env.layout.run_dir(run_id), "reaper_heartbeat.json")
        deadline = time.time() + 5
        while time.time() < deadline and not (json.load(open(hb)).get("issue_ok_at")):
            time.sleep(0.05)
        supervise.watchdog_cycle(self.env.layout, self.env.policy, self.env.agent)
        self.assertNotIn("S2", [r["by"] for r in monitor_records(self.env, run_id)])
        self.assertEqual(registry.load(self.env.layout, run_id)["state"], "running")


class StopAndAudit(Base):
    def test_audit_record_and_alert_on_change(self):
        run_id, stub, body, e = self.start_running()
        self.env.issue.publish(body, state="CLOSED")
        e2 = self.wait_state(run_id)
        self.assertEqual(e2["stop_reason"], "issue_changed_while_running")
        last = monitor_records(self.env, run_id)[-1]
        self.assertFalse(last["ok"])
        self.assertIn("not open", last["reason"])
        halts = [r["payload"] for r in self.env.agent.agent_events.read_all() if r["type"] == "HALT_AGENT"]
        self.assertTrue(any(h["reason"] == "issue_changed_while_running" for h in halts))
        status, end = self.env.control.finalize(run_id, current_body=body)
        self.assertNotEqual(status, "ended_checks_passed")
        self.assertTrue(any("issue_changed_while_running" in m for _, m in self.env.notifier.sent))

    def test_change_just_before_the_end_is_not_success(self):
        run_id, stub, body, e = self.start_running(sleep=1.0)
        time.sleep(0.7)
        self.env.issue.publish(body)  # 終了の直前に世代だけ変わる
        stub.wait(timeout=30)
        self.wait_terminal(run_id)
        status, end = self.env.control.finalize(run_id, current_body=body)
        self.assertNotEqual(status, "ended_checks_passed")


class Priority(Base):
    policy_overrides = {"timing": dict(MONITOR, issue_fetch_timeout=5.0)}

    def slow_monitor(self):
        run_id, stub, body, e = self.start_running()
        time.sleep(0.4)
        self.env.issue.delay = 2.0  # 以降の監督の再取得が遅れる（打ち切り5秒の内側）
        time.sleep(0.5)  # 遅い再取得の途中
        return run_id, body

    def test_revoke_is_not_delayed_by_a_slow_monitor_fetch(self):
        run_id, body = self.slow_monitor()
        t0 = time.time()
        self.env.control.revoke_issue(task_id="g10-phase2-test-20261022", reason="test")
        e = self.wait_state(run_id, timeout=5)
        self.assertEqual(e["stop_reason"], "issue_revoked")
        self.assertLess(time.time() - t0, 1.2, "revoke waited for the slow Issue fetch")

    def test_hard_halt_is_not_delayed_by_a_slow_monitor_fetch(self):
        run_id, body = self.slow_monitor()
        t0 = time.time()
        threading.Thread(target=lambda: self.env.control.halt("hard", "x", wait_sync=0)).start()
        e = self.wait_state(run_id, timeout=5)
        self.assertEqual(e["stop_reason"], "emergency_stop")
        self.assertLess(time.time() - t0, 1.2, "hard HALT waited for the slow Issue fetch")


class S2Fallback(Base):
    def test_s2_checks_when_s1_is_gone(self):
        run_id, stub, body, e = self.start_running()
        os.kill(e["reaper_pid"], 9)  # S1 が落ちる
        time.sleep(0.2)
        self.env.issue.publish(body, state="CLOSED")
        actions = supervise.watchdog_cycle(self.env.layout, self.env.policy, self.env.agent,
                                           now=time.time() + 60)
        self.assertIn((run_id, "issue_changed_while_running"), actions)
        e2 = registry.load(self.env.layout, run_id)
        self.assertEqual(e2["state"], "interrupted")
        self.assertEqual(e2["stop_by"], "S2")
        self.assertIn("S2", [r["by"] for r in monitor_records(self.env, run_id)])
        self.assertTrue(self.env.control.read_state().hard_halted)


class OverdueFetch(unittest.TestCase):
    def test_fetch_that_never_returns_is_a_failure(self):
        policy = test_policy(timing=dict(FAST_TIMING, issue_monitor_interval=0.1, issue_fetch_timeout=0.2))
        with mock.patch.object(supervise, "issue_monitor_check", side_effect=lambda *a: time.sleep(3)):
            m = supervise.IssueMonitor(Layout("/tmp/g10-unused"), policy, None, "run-0123456789abcdef")
            self.assertIsNone(m.poll(time.time()))
            deadline = time.time() + 2
            problem = None
            while time.time() < deadline and problem is None:
                time.sleep(0.05)
                problem = m.poll(time.time())
            self.assertEqual(problem, "issue monitor fetch overdue")
