"""監督付き自動起動の準備（TASK 13）: G10 一枠のオフライン E2E。
「Issue 監視 → 証拠の検証 → 模擬 Claude（偽Claude）の起動 → 監督・停止 → REPORT の候補」を通しで確かめる。
実 GitHub・実 Claude・外部への書き込みは使わない（模擬 Issue と偽Claude のみ）。REPORT は下書きのローカルファイルまで。
"""
import json
import os
import time

from g10runner import claude_cli_plan as ccp, registry
from helpers import EnvTestCase, FAST_TIMING, TRUSTED_ISSUE, make_body

MONITOR = dict(FAST_TIMING, issue_monitor_interval=0.3)
TASK_ID = "g10-phase2-test-20261022"


class G10OfflineE2E(EnvTestCase):
    policy_overrides = {"timing": MONITOR}

    def setUp(self):
        super().setUp()
        self.env.envelope()
        self.env.s2_heartbeat()
        self.body = make_body(self.env.policy)
        self.env.issue.publish(self.body)  # 担当ちゃが Issue #323 に承認済み TASK を載せた状態

    def claim(self):
        run_id, reason = self.env.control.try_claim(self.body, TRUSTED_ISSUE, time.time())
        self.assertIsNotNone(run_id, reason)
        return run_id

    def handle(self, run_id, scenario=None):
        stub, reason = self.env.agent.handle_request_file(self.env.layout.request_file(run_id), scenario=scenario)
        self.assertIsNotNone(stub, reason)
        self.addCleanup(lambda: (stub.poll() is None and stub.kill(), stub.wait(timeout=30)))
        return stub

    def report(self, run_id):
        return open(os.path.join(self.env.layout.reports, run_id + ".md"), encoding="utf-8").read()

    def test_happy_path_to_a_report_candidate(self):
        run_id = self.claim()
        stub = self.handle(run_id, scenario={"sleep": 1.0, "result": "調査しました。\npending_questions: なし"})
        stub.wait(timeout=30)
        self.wait_terminal(run_id)
        status, end = self.env.control.finalize(run_id, current_body=self.body)
        self.assertEqual(status, "ended_checks_passed", end["payload"])
        self.assertEqual(self.env.agent.used_state(run_id), ["ACCEPTED", "SPAWNING", "SPAWNED"])
        run_dir = self.env.layout.run_dir(run_id)
        self.assertTrue(os.path.exists(os.path.join(run_dir, "spawn_evidence.json")))  # 起動直前の再取得の証拠
        monitor = [json.loads(line) for line in open(os.path.join(run_dir, "issue_monitor.jsonl"))]
        self.assertTrue(monitor and all(r["ok"] for r in monitor))  # 実行中の監督は正常
        text = self.report(run_id)
        for needle in ("type: REPORT", "task_id: " + TASK_ID, "next_task_allowed: false",
                       "状態（実行係の判定）: ended_checks_passed", "K10"):
            self.assertIn(needle, text)
        self.assertTrue(any("✅" in t for t, _ in self.env.notifier.sent))
        # 実 Claude で起動するなら使う計画（実行しない）: 同じ要求のモデル・セッションを使う
        req = json.load(open(self.env.layout.request_file(run_id)))["request"]
        plan = ccp.build_plan("/opt/claude", req, os.path.join(run_dir, "prompt.md"),
                              os.path.join(run_dir, "settings.json"), "/Users/_g10runner")
        self.assertIn(req["model_id"], plan["argv"])
        self.assertIn(req["session_id"], plan["argv"])
        self.assertTrue(plan["dry_run"])

    def test_stale_task_is_not_started(self):
        run_id = self.claim()
        self.env.issue.publish(make_body(self.env.policy, mutate=lambda b: b.replace("- status: ready",
                                                                                     "- status: idle", 1)))
        stub = self.handle(run_id, scenario={"sleep": 5})
        stub.wait(timeout=30)
        e = self.wait_terminal(run_id)
        self.assertEqual(e["state"], "aborted_before_spawn")
        self.assertIn("issue changed or unverifiable at spawn", e["abort_reason"])
        self.assertNotIn("SPAWNED", self.env.agent.used_state(run_id))

    def test_stop_by_revoke_and_report(self):
        run_id = self.claim()
        stub = self.handle(run_id, scenario={"sleep": 30})
        deadline = time.time() + 20
        while time.time() < deadline and (registry.load(self.env.layout, run_id) or {}).get("state") != "running":
            time.sleep(0.05)
        self.env.control.revoke_issue(task_id=TASK_ID, reason="human stop")
        e = self.wait_terminal(run_id)
        self.assertEqual((e["state"], e["stop_reason"]), ("interrupted", "issue_revoked"))
        status, end = self.env.control.finalize(run_id, current_body=self.body)
        self.assertEqual(status, "interrupted")
        self.assertIn("issue_revoked", self.report(run_id))

    def test_double_start_and_replay_do_nothing(self):
        run_id = self.claim()
        stub = self.handle(run_id, scenario={"sleep": 0.5})
        stub.wait(timeout=30)
        self.wait_terminal(run_id)
        self.assertEqual(self.env.agent.spawn_stub(run_id).wait(timeout=30), 3)
        again, reason = self.env.agent.handle_request_file(self.env.layout.request_file(run_id))
        self.assertIsNone(again)
        self.assertIn("already used", reason)

    def test_timeout_is_stopped(self):
        body = make_body(self.env.policy, max_minutes="1")  # 1分＝0.5秒（試験用）
        self.env.issue.publish(body)
        run_id, reason = self.env.control.try_claim(body, TRUSTED_ISSUE, time.time())
        self.assertIsNotNone(run_id, reason)
        stub = self.handle(run_id, scenario={"sleep": 30})
        stub.wait(timeout=30)
        e = self.wait_terminal(run_id)
        self.assertEqual((e["state"], e["stop_reason"]), ("interrupted", "timed_out"))

    def test_secrets_in_the_self_report_are_redacted(self):
        run_id = self.claim()
        leak = "ghp_" + "Z" * 36
        stub = self.handle(run_id, scenario={"sleep": 0.3, "result": "結果。token: %s\npending_questions: なし" % leak})
        stub.wait(timeout=30)
        self.wait_terminal(run_id)
        self.env.control.finalize(run_id, current_body=self.body)
        text = self.report(run_id)
        self.assertNotIn(leak, text)
        self.assertIn("[REDACTED]", text)
