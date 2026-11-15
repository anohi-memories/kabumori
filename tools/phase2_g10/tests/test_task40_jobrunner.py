"""B0-1: 常駐ジョブ実行を1本に組む driver（g10runner.jobrunner.build_loop / ExportingDispatcher）。

初期化済みの exec プレーンのルート（wiring の鍵・ポリシー）から常駐ループを組み、署名付きジョブを1件通して
実行プレーンで1回起動し、結果の束を handoff/out へ agent 署名つきで自動で書き出すこと。固定版の検証で周期が止まること
（CLAIM の前・fail-closed）。exec プレーンは wiring の human 公開鍵でしか human 署名を受け付けないこと。実 Claude は使わない。

DispatchBase（env・bundle・GO・CLAIM の足場）を使うが、ジョブの human 署名は wiring の **ECDSA human 鍵**で作る
（＝本番の配り方: exec は wiring の公開鍵で検証する。DispatchBase の HMAC human は別層を示すための試験用）。
"""
import json
import os
import shutil
import time
import unittest

from g10runner import jobrunner, result_handoff, signing
from g10runner.fsutil import canonical
from test_task38_dispatch import DispatchBase


def make_writable(root):
    for dirpath, _dirnames, filenames in os.walk(root):
        for name in [dirpath] + [os.path.join(dirpath, f) for f in filenames]:
            try:
                os.chmod(name, 0o700)
            except OSError:
                pass


class JobRunnerBase(DispatchBase):
    def place_signed_job(self, go, request_doc, job_id="job-1", filename="j1.json", signer=None, role="human"):
        """ジョブを署名して handoff/in に置く。既定は wiring の ECDSA human 鍵（本番の配り方）で署名する。"""
        signer = signer or self.env.control_signer
        now = time.time()
        body = {"job_id": job_id, "go": go, "request_doc": request_doc,
                "issued_at": now, "expires_at": now + 300, "role": role}
        sig = signer.sign(role, canonical(body))
        with open(os.path.join(self.hin, filename), "w", encoding="utf-8") as f:
            f.write(json.dumps(dict(body, sig=sig), ensure_ascii=False))

    def build(self, release_check=None):
        return jobrunner.build_loop(self.env.tmp, self.hin, self.claims, self.hout, self.flags,
                                    self.cli, self.home, wait_seconds=60, release_check=release_check)


class BuildLoopE2E(JobRunnerBase):
    def test_run_auto_exports_a_bundle_yuya_can_finalize(self):
        """build_loop で組んだループが1件を通し、結果の束を out へ自動 export → 実行プレーンの成果物を消しても
        out の束だけで既存 finalize が緑になる（export は ExportingDispatcher が自動で行う）。"""
        bundle = self.make_bundle()
        go = self.go_doc(source_bundle=bundle)
        run_id, request_doc = self.approve_and_claim(go)
        self.place_signed_job(go, request_doc)

        rec = self.build().step()
        self.assertEqual(rec["decision"], "ran", rec)
        self.assertEqual(rec["run_id"], run_id)
        self.wait_terminal(run_id, 60)

        # disposition と agent 署名つきの束が out に揃っている
        disp = json.load(open(os.path.join(self.hout, "job-1.json")))
        self.assertEqual(disp["run_id"], run_id)
        self.assertTrue(os.path.isfile(os.path.join(self.hout, run_id, result_handoff.MANIFEST)))
        self.assertEqual(len(self.calls()), 1)  # 実起動はちょうど1回

        # 実行プレーンの成果物を消し、out の束だけから ingest → 既存 finalize（yuya 側）が緑
        for p in (self.env.layout.request_file(run_id), self.env.layout.proc_file(run_id)):
            os.remove(p)
        for d in (self.env.layout.run_dir(run_id), self.env.layout.work_dir(run_id)):
            make_writable(d)
            shutil.rmtree(d)
        _signer, wverifier = jobrunner.wiring.agent_side(self.env.tmp)  # wiring の agent 検証器
        result_handoff.ingest_result(self.hout, run_id, self.env.layout, wverifier)
        status, _end = self.env.control.finalize(run_id, current_body=self.body)
        self.assertEqual(status, "ended_checks_passed", status)


class ReleaseGate(JobRunnerBase):
    def test_release_verification_failure_blocks_the_cycle_before_claim(self):
        """固定版の検証が失敗したら、auth も accept もせず止まる（CLAIM しない＝承認を消費しない）。"""
        bundle = self.make_bundle()
        go = self.go_doc(source_bundle=bundle)
        _run_id, request_doc = self.approve_and_claim(go)
        self.place_signed_job(go, request_doc)

        rec = self.build(release_check=lambda: ["pinned release was modified"]).step()
        self.assertEqual(rec["decision"], "wait")
        self.assertEqual(rec["reason"], "release verification failed")
        self.assertEqual(self.calls(), [])                 # 起動しない
        self.assertEqual(os.listdir(self.claims), [])      # CLAIM しない
        self.assertFalse(os.path.exists(os.path.join(self.hout, "job-1.json")))


class HumanKeyBoundary(JobRunnerBase):
    def test_job_signed_with_a_key_not_in_wiring_is_rejected(self):
        """exec プレーンは wiring の human 公開鍵でしか human 署名を受け付けない（偽の鍵は拒否・CLAIM しない）。"""
        bundle = self.make_bundle()
        go = self.go_doc(source_bundle=bundle)
        _run_id, request_doc = self.approve_and_claim(go)
        forged = signing.HmacTestSigner({"human": b"not-the-wiring-human-key"})
        self.place_signed_job(go, request_doc, signer=forged)

        rec = self.build().step()
        self.assertEqual(rec["decision"], "skip", rec)
        self.assertEqual(self.calls(), [])
        self.assertEqual(os.listdir(self.claims), [])


if __name__ == "__main__":
    unittest.main()
