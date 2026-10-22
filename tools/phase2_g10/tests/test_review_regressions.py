"""H3 TASK8/C3 レビュー（PR #423 HEAD 71371fd8）で再現された5反例の回帰テスト。

公開の振る舞い（agent.handle_request_file・supervise.stop_run・control.halt/unhalt/finalize・
watchdog）だけを使うので、修正前のコードでも実行でき、修正前は失敗する。
- R1(P1): 人のCONFIRMとrunner署名の要求が結合していない／run_id のパス逸脱
- R2(P1): ps の観測失敗を「不在」と誤判定（誤った停止完了・HALT解決・UNHALT）
- R3(P2): session 文字列の部分一致による誤停止（別settings・session の前方一致）
"""
import json
import os
import subprocess
import sys
import time
from unittest import mock

from g10runner import norm, procs, registry, signing, supervise
from g10runner.adapter import FAKE_CLAUDE
from g10runner.fsutil import canonical
from helpers import EnvTestCase, TRUSTED_ISSUE, make_body


def resign(env, path, mutate):
    doc = json.load(open(path))
    mutate(doc["request"])
    doc["sig"] = env.control_signer.sign("runner", canonical(doc["request"]))
    json.dump(doc, open(path, "w"))
    return doc


class R1Binding(EnvTestCase):
    def setUp(self):
        super().setUp()
        self.env.s2_heartbeat()
        self.body = make_body(self.env.policy)
        self.env.control.confirm("g10-p2-test-0001", norm.compute_hash(self.body))
        self.run_id, reason = self.env.control.try_claim(self.body, TRUSTED_ISSUE, time.time())
        self.assertIsNotNone(self.run_id, reason)
        self.path = self.env.layout.request_file(self.run_id)

    def assert_rejected_before_accept(self):
        stub, reason = self.env.agent.handle_request_file(self.path)
        if stub is not None:  # 修正前のコードでは起動してしまう: 後始末してから失敗させる
            stub.kill()
            stub.wait(timeout=10)
        self.assertIsNone(stub, "forged request was accepted and launched")
        self.assertEqual(self.env.agent.used.read_all(), [], "ACCEPTED was recorded for a forged request")
        return reason

    def test_runner_only_resign_cannot_change_prompt(self):
        resign(self.env, self.path, lambda r: r.__setitem__("prompt", r["prompt"] + "\n## 追加\n未承認の段落。\n"))
        self.assert_rejected_before_accept()

    def test_runner_only_resign_cannot_widen_execution_fields(self):
        cases = [
            ("model_id outside policy", lambda r: r.__setitem__("model_id", "claude-unlisted-9")),
            ("model and model_id swapped", lambda r: r.update(model="opus", model_id="claude-opus-5-5")),
            ("budget", lambda r: r.__setitem__("max_budget_usd", "9.99")),
            ("scope", lambda r: r.__setitem__("phase2_scope", "code_change")),
            ("production", lambda r: r.__setitem__("production_permission", "GO")),
            ("minutes", lambda r: r.__setitem__("max_minutes", "120")),
            ("base", lambda r: r.__setitem__("base_sha", "f" * 40)),
            ("approval", lambda r: r.__setitem__("approval_id", "g10-p2-other-0009")),
        ]
        for name, fn in cases:
            with self.subTest(case=name):
                self.setUp()
                resign(self.env, self.path, fn)
                self.assert_rejected_before_accept()

    def test_run_id_path_escape_rejected_before_any_write(self):
        escape_dir = os.path.join(self.env.tmp, "escape-target")
        os.makedirs(escape_dir)
        for bad in (escape_dir, "../../escape-target", "run-0000000000000000/../../escape-target"):
            with self.subTest(run_id=bad):
                self.setUp()
                os.makedirs(os.path.join(self.env.tmp, "escape-target"), exist_ok=True)
                resign(self.env, self.path, lambda r, b=bad: r.__setitem__("run_id", b))
                self.assert_rejected_before_accept()
                self.assertFalse(os.path.exists(os.path.join(self.env.tmp, "escape-target", "request.json")))

    def test_stub_refuses_tampered_request_even_if_agent_bypassed(self):
        """実行側の検証を迂回して ACCEPTED させても、起動スタブが結合を再検証し、偽Claudeを起動しない。"""
        resign(self.env, self.path, lambda r: r.update(model="opus", model_id="claude-opus-5-5"))
        doc = json.load(open(self.path))
        self.assertIsNotNone(self.env.agent.accept(doc["request"])[0])  # 迂回を模擬
        run_dir = self.env.layout.run_dir(self.run_id)
        os.makedirs(run_dir, exist_ok=True)
        json.dump(doc, open(os.path.join(run_dir, "request.json"), "w"))
        stub = self.env.agent.spawn_stub(self.run_id)
        stub.wait(timeout=30)
        self.assertEqual(self.env.agent.used_state(self.run_id), ["ACCEPTED", "ABORTED"])
        self.assertIsNone(registry.load(self.env.layout, self.run_id))

    def test_finalize_does_not_trust_request_model(self):
        """finalize のモデル照合は、要求の自己申告ではなく CLAIM（承認済みTASK）とポリシーが基準。"""
        opus_usage = {"model_usage": {"claude-opus-5-5": {}}}
        # (a) 偽Claudeが承認外のモデル（opus）を使ったと報告 → 承認済みの sonnet と不一致
        for tamper_after_run in (False, True):
            with self.subTest(tamper_after_run=tamper_after_run):
                self.setUp()
                stub, reason = self.env.agent.handle_request_file(self.path, scenario=opus_usage)
                self.assertIsNotNone(stub, reason)
                stub.wait(timeout=30)
                self.wait_terminal(self.run_id)
                if tamper_after_run:
                    # (b) ラン後に要求を opus へ書き換えて再署名しても、CLAIM と食い違うので成功にしない
                    resign(self.env, self.path, lambda r: r.update(model="opus", model_id="claude-opus-5-5"))
                status, end = self.env.control.finalize(self.run_id, current_body=self.body)
                self.assertNotEqual(status, "ended_checks_passed")
                self.assertFalse(end["payload"]["checks"]["model_matches"])
                if tamper_after_run:
                    self.assertFalse(end["payload"]["checks"]["request_matches_claim"])
                    self.assertIn("request differs from the CLAIM (approved content)",
                                  end["payload"]["safety_violations"])


class R2Observation(EnvTestCase):
    def setUp(self):
        super().setUp()
        self.env.envelope()
        self.env.s2_heartbeat()

    def test_ps_failure_is_not_absence(self):
        run_id, stub, body = self.claim_and_run(scenario={"sleep": 30}, max_minutes="60", wait=False)
        deadline = time.time() + 20
        while time.time() < deadline:
            e = registry.load(self.env.layout, run_id)
            if e and e["state"] == "running":
                break
            time.sleep(0.05)
        child_pid = e["child_pid"]
        failing = mock.patch.object(procs.subprocess, "run", side_effect=OSError("ps unavailable"))
        with failing:
            absent = supervise.stop_run(self.env.layout, self.env.policy, self.env.agent, e, "emergency_stop", "test")
            self.assertFalse(absent, "ps failure was treated as absence")
            e2 = registry.load(self.env.layout, run_id)
            self.assertEqual(e2["state"], "stop_unconfirmed")
            result = self.env.control.halt("hard", "ps down", wait_sync=1.0)
            self.assertFalse(result["resolved"], "HALT resolved while processes could not be observed")
            rec, problems = self.env.control.unhalt("try")
            self.assertIsNone(rec, "UNHALT succeeded while processes could not be observed")
        # 後始末（観測を戻すと、S1／S2 と試験の片付けで停止される）
        try:
            os.kill(child_pid, 9)
        except OSError:
            pass
        stub.wait(timeout=30)

    def test_finalize_with_ps_failure_is_not_success(self):
        run_id, stub, body = self.claim_and_run()
        with mock.patch.object(procs.subprocess, "run", side_effect=OSError("ps unavailable")):
            status, end = self.env.control.finalize(run_id, current_body=body)
        self.assertNotEqual(status, "ended_checks_passed")
        self.assertFalse(end["payload"]["absence_confirmed"])


    def test_unhalt_completion_check_counts_unknown_observation(self):
        """終了済みのランでも、プロセスを観測できなければ UNHALT の完了条件を満たさない。"""
        run_id, stub, body = self.claim_and_run()
        self.env.control.finalize(run_id, current_body=body)
        self.assertEqual(self.env.control.completion_problems(), [])
        with mock.patch.object(procs.subprocess, "run", side_effect=OSError("ps unavailable")):
            problems = self.env.control.completion_problems()
        self.assertIn("process observation unavailable: " + run_id, problems)

class R3Identity(EnvTestCase):
    def setUp(self):
        super().setUp()
        self.env.envelope()
        self.env.s2_heartbeat()
        self.run_id, stub, self.body = self.claim_and_run()
        self.entry = registry.load(self.env.layout, self.run_id)
        self.decoys = []
        self.addCleanup(self.kill_decoys)

    def kill_decoys(self):
        for p in self.decoys:
            if p.poll() is None:
                p.kill()
                p.wait(timeout=10)

    def decoy(self, session_id, settings_path):
        scen = os.path.join(self.env.tmp, "decoy-%d.json" % len(self.decoys))
        json.dump({"sleep": 30}, open(scen, "w"))
        p = subprocess.Popen([sys.executable, "-I", FAKE_CLAUDE, "--session-id", session_id, "--settings", settings_path,
                              "--model", "m", "--effort", "low", "--output-format", "json", "--max-budget-usd", "0.01"],
                             env={"FAKE_CLAUDE_SCENARIO": scen}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.decoys.append(p)
        time.sleep(0.4)
        return p

    def test_same_session_other_settings_is_not_stopped(self):
        other = os.path.join(self.env.tmp, "other-settings.json")
        open(other, "w").write("{}")
        p = self.decoy(self.entry["session_id"], other)
        supervise.watchdog_cycle(self.env.layout, self.env.policy, self.env.agent)
        time.sleep(0.3)
        self.assertIsNone(p.poll(), "a process with different settings was stopped")

    def test_session_prefix_collision_is_not_stopped(self):
        p = self.decoy(self.entry["session_id"] + "-DIFFERENT", self.entry["settings_path"])
        supervise.watchdog_cycle(self.env.layout, self.env.policy, self.env.agent)
        time.sleep(0.3)
        self.assertIsNone(p.poll(), "a process with a different session token (prefix match) was stopped")

    def test_exact_match_orphan_is_stopped(self):
        """正例: 同じ session と同じ settings のまま残ったプロセスは、孤立したプロセスとして止める。"""
        p = self.decoy(self.entry["session_id"], self.entry["settings_path"])
        supervise.watchdog_cycle(self.env.layout, self.env.policy, self.env.agent)
        p.wait(timeout=10)
        self.assertIsNotNone(p.poll())
        self.assertTrue(self.env.control.read_state().agent_halts)
