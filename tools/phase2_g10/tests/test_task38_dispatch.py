"""設計 §15.7 Q1 の実結線（dispatch）: handoff の署名付きジョブ → ResidentLoop → Dispatcher →
実行プレーン Agent → スタブ → 代役CLI → 終端、を1本通す E2E。実 Claude は使わない。

役割分担（モック・同一レイアウト）:
- yuya（制御）= GO 承認 → try_claim で runner 署名つき request 封筒を作る → それを handoff ジョブに載せて human 署名。
- _kaburun（実行）= ResidentLoop が accept（検証＋at-most-once CLAIM）→ Dispatcher が封筒を request_file に置いて
  Agent でスタブ起動 → 終端。ソースは bundle（元 repo を消しても完走）。
handoff の human 署名は試験用 HMAC、request の runner 署名は env の本物（ecdsa）。別層であることを示す。
"""
import json
import os
import shutil
import time

from g10runner import handoff, issue as issue_mod, resident, signing
from g10runner.fsutil import canonical, read_json, sha256_hex
from helpers import TRUSTED_ISSUE
from test_task17_real_adapter import RealAdapterBase, git

HUMAN = {"human": b"handoff-human-key"}


class DispatchBase(RealAdapterBase):
    def setUp(self):
        super().setUp()
        # handoff の受け渡しフォルダ
        self.hin = os.path.join(self.env.real, "hin")
        self.claims = os.path.join(self.env.real, "claims")
        self.hout = os.path.join(self.env.real, "hout")
        self.flags = os.path.join(self.env.real, "flags")
        for d, mode in ((self.hin, 0o755), (self.claims, 0o700), (self.hout, 0o700), (self.flags, 0o755)):
            os.makedirs(d, mode)
        self.human = signing.HmacTestSigner(HUMAN)
        self.hverifier = signing.HmacTestVerifier(HUMAN)

    def go_doc(self, **over):
        doc = {"go_id": "go-test-1", "approval_id": "g10-p2-test-0001",
               "task_sha256": issue_mod.norm.compute_hash(self.body),
               "body_sha256": sha256_hex(self.body.encode("utf-8")), "cli_realpath": self.cli,
               "cli_version": "9.9.9", "home": self.home, "max_turns": 10, "source_repo": self.repo,
               "expires_at": time.time() + 600, "max_runs": 1}
        doc.update(over)
        return doc

    def make_bundle(self):
        bundle = os.path.join(self.env.real, "src.bundle")
        git(["bundle", "create", bundle, "--all"], self.repo)
        shutil.rmtree(self.repo)  # 元 repo を消す: bundle だけで完走することを示す
        return bundle

    def place_job(self, go, request_doc, job_id="job-1", filename="j1.json", role="human", sign_role=None):
        now = time.time()
        body = {"job_id": job_id, "go": go, "request_doc": request_doc,
                "issued_at": now, "expires_at": now + 300, "role": role}
        sig = self.human.sign(sign_role or role, canonical(body))
        with open(os.path.join(self.hin, filename), "w", encoding="utf-8") as f:
            f.write(json.dumps(dict(body, sig=sig), ensure_ascii=False))

    def loop(self):
        inbox = handoff.HandoffInbox(self.hin, self.claims, self.hverifier)
        dispatcher = resident.Dispatcher(self.env.agent, self.env.layout, wait_seconds=60)
        return resident.ResidentLoop(inbox, self.flags, self.hout, self.cli, self.home, dispatcher,
                                     log_path=os.path.join(self.env.real, "resident.log"))

    def approve_and_claim(self, go):
        self.env.control.approve_real_claude_go(go)
        run_id, reason = self.env.control.try_claim(self.body, TRUSTED_ISSUE, time.time())
        self.assertIsNotNone(run_id, reason)
        return run_id, read_json(self.env.layout.request_file(run_id))


class DispatchE2E(DispatchBase):
    def test_signed_handoff_job_runs_through_the_execution_plane_from_bundle(self):
        bundle = self.make_bundle()
        go = self.go_doc(source_bundle=bundle)
        run_id, request_doc = self.approve_and_claim(go)
        self.place_job(go, request_doc)

        rec = self.loop().step()
        self.assertEqual(rec["decision"], "ran", rec)
        self.assertEqual(rec["run_id"], run_id)

        # 終端・finalize（yuya 側）
        entry = self.wait_terminal(run_id, 60)
        status, _end = self.env.control.finalize(run_id, current_body=self.body)
        self.assertEqual(status, "ended_checks_passed",
                         (status, {k: entry.get(k) for k in ("state", "stop_reason", "abort_reason")}))
        # 代役CLIはちょうど1回、作業フォルダは bundle から checkout（元 repo は消してある）
        calls = self.calls()
        self.assertEqual(len(calls), 1)
        self.assertTrue(calls[0]["cwd_has_marker"])
        # CLAIM 跡と out/ の結果
        self.assertTrue(os.path.isfile(os.path.join(self.claims, "job-1.claim")))
        disp = json.load(open(os.path.join(self.hout, "job-1.json")))
        self.assertEqual(disp["run_id"], run_id)

    def test_tampered_request_in_job_is_rejected_by_handoff_human_signature(self):
        bundle = self.make_bundle()
        go = self.go_doc(source_bundle=bundle)
        _run_id, request_doc = self.approve_and_claim(go)
        # human 署名後にファイル上で request の中身を書き換える（配送中の改ざん相当）
        now = time.time()
        body = {"job_id": "job-1", "go": go, "request_doc": request_doc,
                "issued_at": now, "expires_at": now + 300, "role": "human"}
        sig = self.human.sign("human", canonical(body))
        tampered = dict(body, sig=sig)
        tampered["request_doc"]["request"]["prompt"] = "evil"
        with open(os.path.join(self.hin, "j1.json"), "w", encoding="utf-8") as f:
            f.write(json.dumps(tampered, ensure_ascii=False))

        rec = self.loop().step()
        self.assertEqual(rec["decision"], "skip")
        self.assertEqual(self.calls(), [])                       # 起動しない
        self.assertEqual(os.listdir(self.claims), [])            # CLAIM しない

    def test_second_cycle_does_not_rerun_a_claimed_job(self):
        bundle = self.make_bundle()
        go = self.go_doc(source_bundle=bundle)
        run_id, request_doc = self.approve_and_claim(go)
        self.place_job(go, request_doc)
        self.assertEqual(self.loop().step()["decision"], "ran")
        self.wait_terminal(run_id, 60)
        again = self.loop().step()                                # 同じジョブは claim 済み
        self.assertEqual(again["decision"], "skip")
        self.assertIn("already claimed", again["reason"])
        self.assertEqual(len(self.calls()), 1)                    # 二度目は起動しない


if __name__ == "__main__":
    import unittest
    unittest.main()
