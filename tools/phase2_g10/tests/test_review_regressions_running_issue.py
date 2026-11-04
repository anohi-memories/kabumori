"""TASK 7 の反例の固定: 起動後（running 中）の Issue の変化を、明示の ISSUE_REVOKE が無くても監督が検出して止める。
修正前HEAD（f0a64ee1）では失敗し（finalize まで検出しない）、修正後に通ることを確認する。

修正前のコードでも動くように、振る舞いだけを使う（監督間隔の設定 issue_monitor_interval は、修正前のコードでは使われない）。
"""
import json
import os
import time

from g10runner import procs, registry, signing
from helpers import EnvTestCase, FAST_TIMING, make_body

MONITOR = dict(FAST_TIMING, issue_monitor_interval=0.3)


class RunningBase(EnvTestCase):
    policy_overrides = {"timing": MONITOR}
    stop_within = 4.0

    def setUp(self):
        super().setUp()
        self.env.envelope()
        self.env.s2_heartbeat()

    def start_running(self, sleep=30):
        body = make_body(self.env.policy, max_minutes="60")
        run_id, stub, body = self.claim_and_run(body=body, scenario={"sleep": sleep}, wait=False)
        self.addCleanup(lambda: (stub.poll() is None and stub.kill(), stub.wait(timeout=30)))
        deadline = time.time() + 20
        while time.time() < deadline:
            e = registry.load(self.env.layout, run_id)
            if e and e["state"] == "running":
                break
            time.sleep(0.05)
        self.assertEqual(e["state"], "running")
        self.addCleanup(self._kill, e["child_pid"])
        return run_id, stub, body, e["child_pid"]

    @staticmethod
    def _kill(pid):
        try:
            os.kill(pid, 9)
        except OSError:
            pass

    def changed(self, old, new):
        return make_body(self.env.policy, max_minutes="60", mutate=lambda b: b.replace(old, new, 1))

    def assert_stopped_soon(self, run_id, child):
        deadline = time.time() + self.stop_within
        e = registry.load(self.env.layout, run_id)
        while time.time() < deadline:
            e = registry.load(self.env.layout, run_id)
            if e["state"] not in registry.NON_TERMINAL:
                break
            time.sleep(0.05)
        self.assertNotEqual(e["state"], "running", "the run kept running after the Issue changed")
        self.assertIn(e["state"], ("interrupted", "stop_unconfirmed"))
        self.assertNotEqual(procs.pid_status(child), "alive")
        self.assertTrue(self.env.control.read_state().hard_halted, "no HALT after the Issue changed while running")


class RunningIssueChange(RunningBase):
    def test_closed_only(self):
        run_id, stub, body, child = self.start_running()
        self.env.issue.publish(body, state="CLOSED", updated_at=None)
        self.assert_stopped_soon(run_id, child)

    def test_idle(self):
        run_id, stub, body, child = self.start_running()
        self.env.issue.publish(self.changed("- status: ready", "- status: idle"))
        self.assert_stopped_soon(run_id, child)

    def test_review_required(self):
        run_id, stub, body, child = self.start_running()
        self.env.issue.publish(self.changed("- status: ready", "- status: review_required"))
        self.assert_stopped_soon(run_id, child)

    def test_body_changed(self):
        run_id, stub, body, child = self.start_running()
        self.env.issue.publish(self.changed("食い違い", "差異"))
        self.assert_stopped_soon(run_id, child)

    def test_generation_only(self):
        run_id, stub, body, child = self.start_running()
        self.env.issue.publish(body)  # 同じ本文・新しい updated_at
        self.assert_stopped_soon(run_id, child)

    def test_fetch_failure_is_not_no_change(self):
        run_id, stub, body, child = self.start_running()
        self.env.issue.fail = "network down"
        self.assert_stopped_soon(run_id, child)

    def test_witness_signature_invalid(self):
        run_id, stub, body, child = self.start_running()
        keys = signing.test_keys()
        keys["witness"] = b"some-other-witness-key"  # 取得係の鍵が変わる → 署名が検証できない
        signing.write_test_keys(self.env.tmp, keys)
        self.assert_stopped_soon(run_id, child)


class RunningIssueSlowFetch(RunningBase):
    policy_overrides = {"timing": dict(MONITOR, issue_fetch_timeout=0.5)}

    def test_monitor_fetch_timeout_is_not_no_change(self):
        run_id, stub, body, child = self.start_running()
        self.env.issue.delay = 2.0  # 打ち切り（0.5秒）を超える遅れ
        self.assert_stopped_soon(run_id, child)
