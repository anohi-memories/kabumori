"""偽Claudeによる起動・終了判定・REPORT・通知の結合試験（実プロセス）。仕様 v5 §10、v5.1 §1。"""
import json
import os
import time

from g10runner import procs, registry
from helpers import EnvTestCase, TRUSTED_ISSUE, make_body


class TestLaunch(EnvTestCase):
    def setUp(self):
        super().setUp()
        self.env.envelope()
        self.env.s2_heartbeat()

    def finalize(self, run_id, body):
        return self.env.control.finalize(run_id, current_body=body)

    def test_happy_path(self):
        run_id, stub, body = self.claim_and_run()
        status, end = self.finalize(run_id, body)
        self.assertEqual(status, "ended_checks_passed", end["payload"])
        self.assertEqual(self.env.agent.used_state(run_id), ["ACCEPTED", "SPAWNING", "SPAWNED"])
        report = open(os.path.join(self.env.layout.reports, run_id + ".md"), encoding="utf-8").read()
        self.assertIn("## 第1部 実行事実", report)
        self.assertIn("## 第2部 Claudeの自己申告", report)
        self.assertIn("completion_code: K10", report)
        self.assertIn("next_task_allowed: false", report)
        self.assertTrue(any("✅" in t for t, _ in self.env.notifier.sent))
        self.assertTrue(any("K10は担当ちゃの判定" in m for _, m in self.env.notifier.sent))
        e = registry.load(self.env.layout, run_id)
        self.assertEqual(e["state"], "exited")
        self.assertFalse(procs.find_by_marker(registry.marker(e)))

    def test_work_folder_is_read_only(self):
        run_id, stub, body = self.claim_and_run()
        wd = self.env.layout.work_dir(run_id)
        with self.assertRaises(PermissionError):
            open(os.path.join(wd, "new.txt"), "w")

    def test_model_mismatch_is_safety_violation(self):
        run_id, stub, body = self.claim_and_run(scenario={"model_usage": {"claude-opus-5-5": {}}})
        status, end = self.finalize(run_id, body)
        self.assertEqual(status, "ended_checks_failed")
        self.assertIn("model mismatch or unverifiable", end["payload"]["safety_violations"])
        self.assertTrue(self.env.control.read_state().hard_halted)

    def test_mixed_models_and_missing_usage(self):
        for usage in ({"claude-sonnet-5-5": {}, "claude-haiku-4-5": {}}, {}):
            with self.subTest(usage=usage):
                self.setUp()
                run_id, stub, body = self.claim_and_run(scenario={"model_usage": usage})
                status, end = self.finalize(run_id, body)
                self.assertNotEqual(status, "ended_checks_passed")

    def test_failures_not_success(self):
        for scen in ({"is_error": True}, {"exit_code": 3}, {"no_output": True}, {"result": ""}):
            with self.subTest(scenario=scen):
                self.setUp()
                run_id, stub, body = self.claim_and_run(scenario=scen)
                status, end = self.finalize(run_id, body)
                self.assertEqual(status, "ended_checks_failed", end["payload"])

    def test_needs_input(self):
        run_id, stub, body = self.claim_and_run(scenario={"result": "調査しました。\npending_questions: 基点はmainでよいか"})
        status, _ = self.finalize(run_id, body)
        self.assertEqual(status, "needs_input")
        self.assertTrue(any("⚠️" in t for t, _ in self.env.notifier.sent))

    def test_issue_body_changed_during_run(self):
        run_id, stub, body = self.claim_and_run()
        status, end = self.finalize(run_id, body.replace("食い違い", "差異", 1))
        self.assertIn("issue body changed during run (observed)", end["payload"]["safety_violations"])
        self.assertTrue(self.env.control.read_state().hard_halted)

    def test_timeout_s1_stops_and_preserves(self):
        run_id, stub, body = self.claim_and_run(scenario={"sleep": 30}, max_minutes="1")  # 1分＝0.5秒（試験用）
        e = registry.load(self.env.layout, run_id)
        self.assertEqual(e["state"], "interrupted")
        self.assertEqual(e["stop_reason"], "timed_out")
        self.assertEqual(e["stop_by"], "S1")
        self.assertFalse(procs.find_by_marker(registry.marker(e)))
        self.assertTrue(os.path.isdir(self.env.layout.work_dir(run_id)))  # 作業フォルダは保護
        status, _ = self.finalize(run_id, body)
        self.assertEqual(status, "interrupted")
        self.assertTrue(any("⏸" in t for t, _ in self.env.notifier.sent))

    def test_sigterm_ignored_then_sigkill(self):
        run_id, stub, body = self.claim_and_run(scenario={"sleep": 30, "ignore_sigterm": True}, max_minutes="1")
        e = registry.load(self.env.layout, run_id)
        self.assertEqual(e["state"], "interrupted")
        self.assertTrue(e["stop_details"]["kill_targets"])
        self.assertFalse(procs.find_by_marker(registry.marker(e)))

    def test_children_and_escaped_child_are_stopped(self):
        for escape in (False, True):
            with self.subTest(escape=escape):
                self.setUp()
                run_id, stub, body = self.claim_and_run(
                    scenario={"sleep": 30, "spawn_child": True, "child_escape": escape, "leave_child": True},
                    max_minutes="1")
                e = registry.load(self.env.layout, run_id)
                self.assertEqual(e["state"], "interrupted")
                self.assertFalse(procs.find_by_marker(registry.marker(e)))

    def test_s2_unavailable_blocks_spawn(self):
        self.env.s2_heartbeat(fresh=False)
        marker = os.path.join(self.env.tmp, "started")
        run_id, stub, body = self.claim_and_run(scenario={"started_marker": marker})
        e = registry.load(self.env.layout, run_id)
        self.assertEqual(e["state"], "aborted_before_spawn")
        self.assertEqual(e["abort_reason"], "supervisor_unavailable")
        self.assertFalse(os.path.exists(marker))
        self.assertEqual(self.env.agent.used_state(run_id), ["ACCEPTED", "ABORTED"])
        status, _ = self.finalize(run_id, body)
        self.assertEqual(status, "runner_error")

    def test_s1_unconfirmed_blocks_spawn(self):
        self.env.cleanup()
        from helpers import Env, test_policy, FAST_TIMING
        t = dict(FAST_TIMING, reaper_confirm_timeout=0.0)
        self.env = Env(policy=test_policy(timing=t))
        self.env.envelope()
        self.env.s2_heartbeat()
        marker = os.path.join(self.env.tmp, "started")
        run_id, stub, body = self.claim_and_run(scenario={"started_marker": marker})
        e = registry.load(self.env.layout, run_id)
        self.assertEqual(e["abort_reason"], "s1_unconfirmed")
        self.assertFalse(os.path.exists(marker))

    def test_duplicate_stub_start_does_nothing(self):
        run_id, stub, body = self.claim_and_run()
        second = self.env.agent.spawn_stub(run_id)
        self.assertEqual(second.wait(timeout=30), 3)
        self.assertEqual(self.env.agent.used_state(run_id), ["ACCEPTED", "SPAWNING", "SPAWNED"])

    def test_notification_failure_is_recorded(self):
        from g10runner.notify import RecordingNotifier
        self.env.control.notifier = RecordingNotifier(fail=True)
        run_id, stub, body = self.claim_and_run()
        self.finalize(run_id, body)
        lines = open(self.env.layout.needs_attention, encoding="utf-8").read().splitlines()
        self.assertTrue(any(json.loads(x)["notified"] is False for x in lines))
