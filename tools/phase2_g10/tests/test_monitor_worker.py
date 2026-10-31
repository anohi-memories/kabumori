"""TASK 8 の個別試験: 監督スレッドの結果（PENDING／SUCCESS／FAILURE）の区別と、issue_ok_at の時刻の契約。"""
import json
import os
import shutil
import tempfile
import threading
import time
import unittest
from unittest import mock

from g10runner import procs, registry, signing, state, supervise
from g10runner.layout import Layout
from helpers import EnvTestCase, FAST_TIMING, make_body, test_policy

RUN_ID = "run-0123456789abcdef"


def make_monitor(tmp, **timing):
    layout = Layout(tmp).ensure()
    os.makedirs(layout.run_dir(RUN_ID), exist_ok=True)
    policy = test_policy(timing=dict(FAST_TIMING, issue_monitor_interval=0.1, issue_fetch_timeout=0.5, **timing))
    return supervise.IssueMonitor(layout, policy, None, RUN_ID), layout


def drive(m, until, timeout=3):
    """until(problem) が真になるまで poll を回す。"""
    deadline = time.time() + timeout
    problem = m.poll(time.time())
    while time.time() < deadline and not until(problem):
        time.sleep(0.02)
        problem = m.poll(time.time())
    return problem


class WorkerResults(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="g10mw-", dir="/tmp")
        self.addCleanup(shutil.rmtree, self.tmp, True)

    def test_missing_result_is_a_failure(self):
        m, _ = make_monitor(self.tmp)
        with mock.patch.object(supervise.IssueMonitor, "_run", lambda self: None):
            problem = drive(m, lambda p: p is not None)
        self.assertEqual(problem, "issue monitor worker ended without a result")
        self.assertIsNone(m.ok_at)

    def test_malformed_return_is_a_failure(self):
        m, _ = make_monitor(self.tmp)
        with mock.patch.object(supervise, "issue_monitor_check", return_value=None):
            problem = drive(m, lambda p: p is not None)
        self.assertEqual(problem, "issue monitor worker error: TypeError")
        self.assertIsNone(m.ok_at)

    def test_failure_reason_passes_through_and_does_not_refresh_ok(self):
        m, _ = make_monitor(self.tmp)
        with mock.patch.object(supervise, "issue_monitor_check", return_value=("issue is not open", None)):
            problem = drive(m, lambda p: p is not None)
        self.assertEqual(problem, "issue is not open")
        self.assertIsNone(m.ok_at)

    def test_fresh_success_uses_the_evidence_time_not_the_consumption_time(self):
        m, _ = make_monitor(self.tmp)
        checked = time.time() - 2.0
        with mock.patch.object(supervise, "issue_monitor_check", return_value=(None, checked)):
            drive(m, lambda p: m.ok_at is not None)
        self.assertEqual(m.ok_at, checked)

    def test_stale_success_is_not_published_and_refetch_starts_at_once(self):
        m, _ = make_monitor(self.tmp)
        old = time.time() - 30.0  # spawn_evidence_max_age（10秒）より古い成功
        release = threading.Event()
        self.addCleanup(release.set)
        results = [(None, old)]

        def check(*a):
            if results:
                return results.pop()
            release.wait(5)
            return None, time.time()
        with mock.patch.object(supervise, "issue_monitor_check", side_effect=check):
            self.assertIsNone(m.poll(time.time()))
            time.sleep(0.2)
            self.assertIsNone(m.poll(time.time()))  # 古い成功を受け取る
            self.assertIsNone(m.ok_at)
            self.assertEqual(m.stale_discarded, 1)
            self.assertIsNotNone(m.thread, "a fresh fetch should start immediately after a stale success")
            release.set()

    def test_future_time_is_invalid(self):
        m, _ = make_monitor(self.tmp)
        with mock.patch.object(supervise, "issue_monitor_check", return_value=(None, time.time() + 600)):
            problem = drive(m, lambda p: p is not None)
        self.assertEqual(problem, "issue monitor result has an invalid time")

    def test_ok_at_never_moves_backwards(self):
        m, _ = make_monitor(self.tmp)
        now = time.time()
        m.ok_at = now - 1.0
        with mock.patch.object(supervise, "issue_monitor_check", return_value=(None, now - 3.0)):
            drive(m, lambda p: m.thread is None and m.started_at is not None, timeout=0.5)
        self.assertEqual(m.ok_at, now - 1.0)

    def test_pending_worker_within_the_overdue_limit_is_not_a_problem(self):
        m, _ = make_monitor(self.tmp)
        release = threading.Event()
        self.addCleanup(release.set)
        with mock.patch.object(supervise, "issue_monitor_check", side_effect=lambda *a: release.wait(5)):
            self.assertIsNone(m.poll(time.time()))
            time.sleep(0.1)
            self.assertIsNone(m.poll(time.time()))
            self.assertIsNone(m.ok_at)
            release.set()


class CheckNeverRaises(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="g10mw-", dir="/tmp")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.layout = Layout(self.tmp).ensure()
        os.makedirs(self.layout.run_dir(RUN_ID), exist_ok=True)
        self.policy = test_policy()

    def records(self):
        return [json.loads(line) for line in open(os.path.join(self.layout.run_dir(RUN_ID), "issue_monitor.jsonl"))]

    def test_internal_exception_becomes_a_fixed_reason_without_details(self):
        boom = RuntimeError("token=abc123 must not be logged")
        with mock.patch.object(supervise, "_issue_monitor_check", side_effect=boom):
            try:
                reason, checked = supervise.issue_monitor_check(self.layout, self.policy, None, RUN_ID, "S1")
            except Exception as exc:  # 例外が漏れるだけでは「失敗として扱った」ことにならない
                self.fail("issue_monitor_check raised instead of returning a failure: %s" % type(exc).__name__)
        self.assertEqual(reason, "issue monitor error: RuntimeError")
        self.assertIsNone(checked)
        self.assertNotIn("abc123", json.dumps(self.records()))

    def test_witness_factory_exception_is_a_failure(self):
        agent = mock.Mock()
        agent.verifier.verify.return_value = True
        agent.current_state.return_value = state.ControlState()  # TASK 16: 設定の照合（従来の経路）を通って取得係へ進む
        req = {"run_id": RUN_ID}
        json.dump({"request": req, "sig": "x"}, open(os.path.join(self.layout.run_dir(RUN_ID), "request.json"), "w"))
        with mock.patch.object(supervise.issue_mod, "spawn_witness", side_effect=ValueError("bad hex")):
            reason, checked = supervise.issue_monitor_check(self.layout, self.policy, agent, RUN_ID, "S1")
        self.assertEqual(reason, "issue witness unavailable: ValueError")
        self.assertIsNone(checked)


class S2WithBrokenWitness(EnvTestCase):
    policy_overrides = {"timing": dict(FAST_TIMING, issue_monitor_interval=0.3)}

    def test_s2_stops_and_halts_when_s1_is_gone_and_the_witness_is_broken(self):
        self.env.envelope()
        self.env.s2_heartbeat()
        run_id, stub, body = self.claim_and_run(body=make_body(self.env.policy, max_minutes="60"),
                                                scenario={"sleep": 30}, wait=False)
        self.addCleanup(lambda: (stub.poll() is None and stub.kill(), stub.wait(timeout=30)))
        deadline = time.time() + 20
        e = None
        while time.time() < deadline:
            e = registry.load(self.env.layout, run_id)
            if e and e["state"] == "running" and e.get("reaper_pid"):
                break
            time.sleep(0.02)
        self.addCleanup(lambda: _kill(e["child_pid"]))
        os.kill(e["reaper_pid"], 9)  # S1 が落ちる
        time.sleep(0.2)
        path = os.path.join(self.env.tmp, signing.TEST_KEYS_FILE)
        keys = json.load(open(path))
        keys["witness"] = "not-hex"
        json.dump(keys, open(path, "w"))
        actions = supervise.watchdog_cycle(self.env.layout, self.env.policy, self.env.agent, now=time.time() + 60)
        self.assertIn((run_id, "issue_changed_while_running"), actions)
        self.assertEqual(registry.load(self.env.layout, run_id)["state"], "interrupted")
        self.assertTrue(self.env.control.read_state().hard_halted)
        self.assertNotEqual(procs.pid_status(e["child_pid"]), "alive")


def _kill(pid):
    try:
        os.kill(pid, 9)
    except OSError:
        pass
