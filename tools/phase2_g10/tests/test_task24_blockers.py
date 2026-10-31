"""TASK 24: 第23TASKの実 LaunchAgent 稼働で見つかった3件の不具合の修正。実 Claude・launchd は使わない。

1. 署名つき UNHALT の後も agent-out/HALT_AGENT（合図）が残り、検知役が止まったままになる
   → S2 の周期で sync_flags。ログで解除を確かめられたときだけ消す（記録待ち・旧形式・不明の event_id は残す）
2. 同じ approval_id への2回目の approve が、無視される GO を記録して成功と表示する
   → 何も記録せずに拒否し、新しい phase2_approval_id が要ると表示する
3. 終了済みのランの ps の一時的な失敗1回で HALT_AGENT になる
   → 終了済みのランは3周期続けて観測できないときだけ HALT。実行中のランの確認は従来どおり

代役の CLI の最小 E2E で、HALT → 検知役は待機 → 人の unhalt → S2 の1周期 → 1回起動・ローカル REPORT → 2回目なし、を確かめる。
"""
import contextlib
import importlib.util
import io
import json
import os
from unittest import mock

from g10runner import autorun, policy as policy_mod, registry, supervise, wiring
from g10runner.agent import Agent
from g10runner.layout import Layout
from test_task17_real_adapter import FirstRunBase

PKG = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_autorun_cli():
    spec = importlib.util.spec_from_file_location("g10_autorun", os.path.join(PKG, "bin", "g10_autorun.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class BlockersBase(FirstRunBase):

    def setUp(self):
        super().setUp()
        self.ar = load_autorun_cli()

    def agent(self, root):
        layout = Layout(root)
        signer, verifier = wiring.agent_side(root)
        return Agent(layout, signer, verifier, policy_mod.load(layout.policy_pub))

    def once(self, root):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = self.ar.main(["--root", root, "--once", "--live", "--dev"])
        return code, json.loads(buf.getvalue().strip().splitlines()[-1])

    def quiet(self, fn, *args):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = fn(*args)
        return code, buf.getvalue()

    def cycle(self, root, agent):
        layout = Layout(root)
        return supervise.watchdog_cycle(layout, policy_mod.load(layout.policy_pub), agent)

    def go_count(self, root):
        control, _ = autorun.open_control(root)
        return sum(1 for r in control.control.read_all() if r["type"] == "REAL_CLAUDE_GO")


class AgentHaltFlag(BlockersBase):

    def test_unhalt_then_s2_cycle_clears_flag_and_detector_launches_once(self):
        fr, root = self.approved_root()
        agent = self.agent(root)
        flag = Layout(root).agent_halt_flag
        rec = agent.halt_agent("observation_unavailable", {"run_id": "run-x"})
        doc = json.load(open(flag))
        self.assertEqual(doc, {"pending": False, "event_ids": [rec["event_id"]]})
        self.assertEqual(self.once(root)[1]["reason"], "halted")
        self.assertIn(("halt_agent_flag", "kept"), self.cycle(root, agent))  # 未解除の間は残す
        self.assertTrue(os.path.exists(flag))
        code, _ = self.quiet(fr.main, ["unhalt", "--root", root, "--reason", "test"])
        self.assertEqual(code, 0)
        self.assertTrue(os.path.exists(flag))  # 解除の記録だけではまだ残る（S2 が片付ける）
        self.assertNotIn(("halt_agent_flag", "kept"), self.cycle(root, agent))
        self.assertFalse(os.path.exists(flag))
        supervise.write_s2_heartbeat(Layout(root))
        code, d = self.once(root)
        self.assertEqual((d["decision"], d["status"]), ("launched", "ended_checks_passed"), d)
        self.assertTrue(os.path.exists(os.path.join(Layout(root).reports, d["run_id"] + ".md")))
        self.assertEqual(self.once(root)[1]["reason"], "approval already used")  # 2回目の CLAIM はしない
        self.assertEqual(len(self.calls()), 1)

    def test_flag_is_kept_unless_the_log_proves_the_unhalt(self):
        fr, root = self.approved_root()
        agent = self.agent(root)
        flag = Layout(root).agent_halt_flag
        cases = {"legacy empty flag": "", "pending record": json.dumps({"pending": True, "event_ids": []}),
                 "unknown event id": json.dumps({"pending": False, "event_ids": ["not-in-log"]}),
                 "not json": "{", "no ids": json.dumps({"pending": False, "event_ids": []})}
        for name, text in cases.items():
            with self.subTest(case=name):
                with open(flag, "w") as f:
                    f.write(text)
                self.assertFalse(agent.sync_flags())
                self.assertTrue(os.path.exists(flag))
                self.assertEqual(self.once(root)[1]["reason"], "halted")
        self.assertEqual(self.calls(), [])

    def test_failed_record_leaves_a_pending_flag(self):
        fr, root = self.approved_root()
        agent = self.agent(root)
        agent.halt_agent("first")  # 解除済みの HALT の event_id がフラグに残っている状態で、次の記録が失敗する
        self.quiet(fr.main, ["unhalt", "--root", root, "--reason", "test"])
        with mock.patch.object(agent.agent_events, "append", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                agent.halt_agent("observation_unavailable")
        self.assertEqual(json.load(open(Layout(root).agent_halt_flag))["pending"], True)
        self.assertFalse(agent.sync_flags())
        self.assertEqual(self.once(root)[1]["reason"], "halted")

    def test_new_halt_after_unhalt_keeps_the_flag(self):
        fr, root = self.approved_root()
        agent = self.agent(root)
        agent.halt_agent("first")
        self.quiet(fr.main, ["unhalt", "--root", root, "--reason", "test"])
        agent.halt_agent("second")  # 解除の後の新しい HALT（未解除）
        self.assertFalse(agent.sync_flags())
        self.assertEqual(len(json.load(open(Layout(root).agent_halt_flag))["event_ids"]), 2)
        self.assertEqual(self.once(root)[1]["reason"], "halted")


class ApprovalReuse(BlockersBase):

    def test_second_approve_for_the_same_approval_is_refused_and_records_nothing(self):
        fr, root = self.approved_root()
        control, _ = autorun.open_control(root)
        before = len(control.control.read_all())
        with self.assertRaises(SystemExit) as cm:
            self.quiet(fr.main, ["approve", "--root", root, "--cli", self.cli, "--source-repo", self.repo])
        self.assertIn("new phase2_approval_id", str(cm.exception))
        self.assertEqual(len(control.control.read_all()), before)  # CONFIRM も GO も追記しない
        self.assertEqual(self.go_count(root), 1)

    def test_direct_second_go_is_refused_under_the_lock(self):
        from g10runner.control import GoReuseError
        fr, root = self.approved_root()
        control, _ = autorun.open_control(root)
        go = dict(control.read_state().real_gos[0])
        go.pop("event_id")
        for over in ({}, {"go_id": "go-other"}, {"approval_id": "other"}):
            with self.subTest(over=over):
                with self.assertRaises(GoReuseError):
                    control.approve_real_claude_go(dict(go, expires_at=go["expires_at"] + 3600, **over))
        self.assertEqual(self.go_count(root), 1)

    def test_claimed_approval_is_refused(self):
        fr, root = self.approved_root()
        self.assertEqual(self.once(root)[1]["decision"], "launched")
        control, _ = autorun.open_control(root)
        problem = control.go_reuse_problem("g10-p2-test-0001", records=[])
        self.assertIsNotNone(problem)
        self.assertIn("already claimed", problem)
        with self.assertRaises(SystemExit):
            self.quiet(fr.main, ["approve", "--root", root, "--cli", self.cli, "--source-repo", self.repo])
        self.assertEqual(len(self.calls()), 1)


class TerminalObservation(BlockersBase):

    def finished_run(self):
        fr, root = self.approved_root()
        code, d = self.once(root)
        self.assertEqual(d["decision"], "launched", d)
        e = registry.load(Layout(root), d["run_id"])
        self.assertIn(e["state"], registry.TERMINAL)
        return root, d["run_id"]

    def halts(self, root):
        return [r for r in self.agent(root).agent_events.read_all() if r["type"] == "HALT_AGENT"]

    def test_transient_failures_do_not_halt_but_a_persistent_one_does(self):
        root, run_id = self.finished_run()
        agent = self.agent(root)
        with mock.patch.object(supervise, "run_processes_present", return_value=None):
            for _ in range(supervise.TERMINAL_OBSERVATION_FAILURE_LIMIT - 1):
                self.assertIn((run_id, "observation_unavailable_transient"), self.cycle(root, agent))
            self.assertEqual(self.halts(root), [])
        self.cycle(root, agent)  # 観測できたら数え直す
        self.assertEqual(json.load(open(supervise.terminal_observation_path(Layout(root)))), {})
        with mock.patch.object(supervise, "run_processes_present", return_value=None):
            for _ in range(supervise.TERMINAL_OBSERVATION_FAILURE_LIMIT - 1):
                self.cycle(root, agent)
            self.assertEqual(self.halts(root), [])
            self.assertIn((run_id, "observation_unavailable"), self.cycle(root, agent))
        halts = self.halts(root)
        self.assertEqual([h["payload"]["reason"] for h in halts], ["observation_unavailable"])
        self.assertEqual(halts[0]["payload"]["details"]["consecutive_failures"],
                         supervise.TERMINAL_OBSERVATION_FAILURE_LIMIT)

    def test_corrupt_counter_halts_at_the_first_failure(self):
        root, run_id = self.finished_run()
        with open(supervise.terminal_observation_path(Layout(root)), "w") as f:
            f.write("{")
        with mock.patch.object(supervise, "run_processes_present", return_value=None):
            self.assertIn((run_id, "observation_unavailable"), self.cycle(root, self.agent(root)))
        self.assertEqual(len(self.halts(root)), 1)

    def test_orphan_of_a_finished_run_still_halts_at_once(self):
        root, run_id = self.finished_run()
        with mock.patch.object(supervise, "run_processes_present", return_value=True), \
                mock.patch.object(supervise.procs, "terminate", return_value={"absent": True, "unknown": False}):
            self.assertIn((run_id, "orphan"), self.cycle(root, self.agent(root)))
        self.assertEqual([h["payload"]["reason"] for h in self.halts(root)], ["orphan_process"])


if __name__ == "__main__":
    import unittest
    unittest.main()
