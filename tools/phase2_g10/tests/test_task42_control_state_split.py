"""B0-3: 鍵と制御状態の配り方（分割レイアウト SplitLayout）。制御の公開状態（control_events・policy・HALT/STOP・
halt.lock）は yuya 所有の読み取り専用 control_pub から読み、実行プレーンの書き込み（agent-out・work・requests）は
_kaburun 所有の exec_root の下だけ。ジョブ発行後に yuya が置いた HALT も、exec の Agent は最新の制御状態として読む
（凍結した写しではない）。control_pub が _kaburun から書ける（group/other 書き込み可）なら build_loop は拒否。実 Claude は使わない。"""
import json
import os
import shutil
import tempfile
import time
import unittest

from g10runner import handoff, jobrunner, result_handoff, supervise, wiring
from g10runner.layout import SplitLayout
from test_task40_jobrunner import JobRunnerBase, make_writable


class SplitLayoutPaths(unittest.TestCase):
    def test_control_paths_in_pub_and_exec_writes_in_root(self):
        tmp = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        exec_root = os.path.join(tmp, "exec")
        cpub = os.path.join(tmp, "cpub")
        lay = SplitLayout(exec_root, cpub)
        # 制御の公開状態は exec_root/pub の下（ensure 後に control_pub への symlink になる）
        self.assertEqual(lay.pub, os.path.join(exec_root, "pub"))
        self.assertEqual(lay.control_events, os.path.join(exec_root, "pub", "control_events.log"))
        self.assertEqual(lay.policy_pub, os.path.join(exec_root, "pub", "policy.json"))
        self.assertEqual(lay.halt_flag, os.path.join(exec_root, "pub", "HALT"))
        self.assertEqual(lay.control_pub, cpub)
        # 実行プレーンが書く request の置き場は pub から外して agent-out の下に（exec 所有）
        self.assertEqual(lay.requests, os.path.join(exec_root, "agent-out", "requests"))
        self.assertTrue(lay.proc.startswith(exec_root) and lay.runs.startswith(exec_root))
        self.assertTrue(lay.work.startswith(exec_root) and lay.control_seen.startswith(exec_root))
        # ensure() は exec 側だけ作り、exec_root/pub を control_pub への symlink にする（中身は触らない）
        os.makedirs(cpub)
        lay.ensure()
        self.assertTrue(os.path.islink(os.path.join(exec_root, "pub")))
        self.assertEqual(os.path.realpath(os.path.join(exec_root, "pub")), os.path.realpath(cpub))
        self.assertTrue(os.path.isdir(os.path.join(exec_root, "agent-out", "requests")))
        self.assertTrue(os.path.isdir(os.path.join(exec_root, "work")))


class SplitBase(JobRunnerBase):
    def setUp(self):
        super().setUp()
        self.control_pub = self.env.layout.pub           # yuya の公開状態（env.control が書く）
        os.chmod(self.control_pub, 0o755)                # _kaburun から書けない（group/other に w なし）
        self.exec_root = os.path.join(self.env.real, "exec-root")
        os.makedirs(self.exec_root)
        shutil.copy(os.path.join(self.env.tmp, "wiring.json"), os.path.join(self.exec_root, "wiring.json"))
        os.chmod(os.path.join(self.exec_root, "wiring.json"), 0o600)
        # S2（見張り役）の心拍は exec 側にある（実機では _kaburun の watchdog が書く）。試験では新鮮な心拍を置く
        supervise.write_s2_heartbeat(SplitLayout(self.exec_root, self.control_pub).ensure())

    def split_loop(self):
        return jobrunner.build_loop(self.exec_root, self.hin, self.claims, self.hout, self.flags, self.cli, self.home,
                                    wait_seconds=60, control_pub=self.control_pub)


class SplitRun(SplitBase):
    def test_split_run_reads_control_from_pub_isolates_writes_and_finalizes(self):
        bundle = self.make_bundle()
        go = self.go_doc(source_bundle=bundle)
        run_id, request_doc = self.approve_and_claim(go)   # yuya: control_events/policy in control_pub, request envelope
        self.place_signed_job(go, request_doc)

        rec = self.split_loop().step()
        self.assertEqual(rec["decision"], "ran", rec)
        self.assertEqual(rec["run_id"], run_id)
        self.assertEqual(len(self.calls()), 1)

        # 実行プレーンの書き込みは exec_root の下だけ（request も含む）。control_pub にも yuya の agent-out にも作らない
        self.assertTrue(os.path.isdir(os.path.join(self.exec_root, "agent-out", "runs", run_id)))
        self.assertTrue(os.path.isfile(os.path.join(self.exec_root, "agent-out", "requests", run_id + ".json")))
        self.assertTrue(os.path.isfile(os.path.join(self.exec_root, "agent-out", "control_seen.json")))
        self.assertFalse(os.path.exists(os.path.join(self.control_pub, "agent-out")))
        self.assertFalse(os.path.exists(os.path.join(self.control_pub, "runs")))
        self.assertFalse(os.path.exists(os.path.join(self.env.tmp, "agent-out", "runs", run_id)))

        # 分割で走ったランも、out 経由で yuya が ingest → 既存 finalize が緑（使えることを示す）
        agent_signer, _v = wiring.agent_side(self.exec_root)
        src = SplitLayout(self.exec_root, self.control_pub)
        rout = os.path.join(self.env.real, "rout")
        os.makedirs(rout, 0o700)
        result_handoff.export_result(src, run_id, rout, agent_signer)
        verifier = wiring.agent_side(self.exec_root)[1]
        # yuya 側のレイアウトに取り込む（finalize は yuya の layout を読む）
        for d in (self.env.layout.run_dir(run_id), self.env.layout.work_dir(run_id)):
            if os.path.isdir(d):
                make_writable(d)
                shutil.rmtree(d)
        result_handoff.ingest_result(rout, run_id, self.env.layout, verifier)
        status, _end = self.env.control.finalize(run_id, current_body=self.body)
        self.assertEqual(status, "ended_checks_passed", status)


class ControlPlaneHaltIsLive(SplitBase):
    def test_halt_placed_in_pub_after_issue_blocks_the_exec_agent(self):
        bundle = self.make_bundle()
        go = self.go_doc(source_bundle=bundle)
        _run_id, request_doc = self.approve_and_claim(go)
        self.place_signed_job(go, request_doc)
        # yuya がジョブ発行後に共有 pub へ HALT を置く（凍結した写しではなく最新を読むなら効く）
        self.env.control.halt("hard", "operator stop")

        rec = self.split_loop().step()
        self.assertEqual(rec["status"], "not_accepted", rec)  # Agent が最新の制御状態で拒否
        self.assertEqual(self.calls(), [])                    # CLI は起動しない
        self.assertTrue(os.path.lexists(os.path.join(self.control_pub, "HALT")))


class WritableControlPubRefused(SplitBase):
    def test_group_or_other_writable_control_pub_is_refused(self):
        os.chmod(self.control_pub, 0o777)  # _kaburun から書けてしまう置き場は信用しない
        try:
            with self.assertRaises(handoff.HandoffError):
                self.split_loop()
        finally:
            os.chmod(self.control_pub, 0o755)


if __name__ == "__main__":
    unittest.main()
