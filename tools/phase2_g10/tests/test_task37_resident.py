"""設計 §15: 常駐ループ resident.ResidentLoop。1周期の fail-closed（HALT/STOP・ログイン前チェック・accept・
dispatch・out 記録）を、代役の dispatch と代役の auth で確かめる。実 Claude・ネットワーク・本物の HOME は使わない。
"""
import json
import os
import shutil
import tempfile
import time
import unittest

from g10runner import handoff, resident, signing
from g10runner.fsutil import canonical, sha256_hex

KEYS = {"human": b"human-key"}


def make_go(prompt, **over):
    go = {"go_id": "go-1", "approval_id": "appr-1", "task_sha256": "a" * 64,
          "body_sha256": sha256_hex(prompt.encode("utf-8")), "cli_realpath": "/opt/claude/2.1.305",
          "cli_version": "2.1.305", "home": "/Users/_kaburun", "max_turns": 10,
          "source_repo": "/Users/_kaburun/src", "expires_at": time.time() + 600, "max_runs": 1}
    go.update(over)
    return go


class FakeDispatch:
    def __init__(self, result=None, raises=False):
        self.calls = []
        self.result = result or {"run_id": "run-x", "status": "ended_checks_passed"}
        self.raises = raises

    def __call__(self, decision):
        self.calls.append(decision)
        if self.raises:
            raise RuntimeError("boom")
        return self.result


class LoopBase(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.in_dir = os.path.join(self.tmp, "in")
        self.claims = os.path.join(self.tmp, "claims")
        self.out = os.path.join(self.tmp, "out")
        self.flags = os.path.join(self.tmp, "flags")
        for d, mode in ((self.in_dir, 0o755), (self.claims, 0o700), (self.out, 0o700), (self.flags, 0o755)):
            os.makedirs(d, mode)
        self.signer = signing.HmacTestSigner(KEYS)
        self.verifier = signing.HmacTestVerifier(KEYS)
        self.now = [time.time()]
        self.auth_calls = []
        self.logged_in = True
        self.dispatch = FakeDispatch()
        self.log = os.path.join(self.tmp, "resident.log")

    def auth_check(self, cli, home):
        self.auth_calls.append((cli, home))
        return {"logged_in": self.logged_in}

    def inbox(self):
        return handoff.HandoffInbox(self.in_dir, self.claims, self.verifier, now=lambda: self.now[0])

    def loop(self, dispatch=None):
        return resident.ResidentLoop(self.inbox(), self.flags, self.out, "/opt/claude/2.1.305", "/Users/_kaburun",
                                     dispatch or self.dispatch, auth_check=self.auth_check,
                                     now=lambda: self.now[0], log_path=self.log)

    def write_job(self, filename, job_id, prompt="do it", role="human", sign_role=None, sig=None, go_over=None):
        body = {"job_id": job_id, "go": make_go(prompt, **(go_over or {})),
                "request": {"approval_id": "appr-1", "task_sha256": "a" * 64, "prompt": prompt,
                            "base_ref": "refs/heads/main", "base_sha": "b" * 40},
                "issued_at": self.now[0], "expires_at": self.now[0] + 300, "role": role}
        signature = sig if sig is not None else self.signer.sign(sign_role or role, canonical(body))
        with open(os.path.join(self.in_dir, filename), "w", encoding="utf-8") as f:
            f.write(json.dumps(dict(body, sig=signature), ensure_ascii=False))

    def flag(self, name):
        open(os.path.join(self.flags, name), "w").close()


class Cycle(LoopBase):
    def test_valid_job_runs_and_writes_out(self):
        self.write_job("j1.json", "job-1")
        rec = self.loop().step()
        self.assertEqual(rec["decision"], "ran")
        self.assertEqual(rec["status"], "ended_checks_passed")
        self.assertEqual(len(self.dispatch.calls), 1)
        self.assertEqual(self.dispatch.calls[0].source_kind, "git")
        self.assertTrue(os.path.isfile(os.path.join(self.claims, "job-1.claim")))
        disp = json.load(open(os.path.join(self.out, "job-1.json")))
        self.assertEqual(disp["status"], "ended_checks_passed")
        self.assertEqual(disp["run_id"], "run-x")

    def test_no_jobs_is_idle(self):
        rec = self.loop().step()
        self.assertEqual(rec["decision"], "idle")
        self.assertEqual(self.dispatch.calls, [])

    def test_only_first_job_is_processed_per_cycle(self):
        self.write_job("a.json", "job-a")
        self.write_job("b.json", "job-b")
        self.loop().step()
        self.assertEqual(len(self.dispatch.calls), 1)  # 1周期1件
        # 2件目は次の周期まで残る（claim されていない）
        self.assertFalse(os.path.exists(os.path.join(self.claims, "job-b.claim")))

    def test_dispatch_failure_is_recorded_and_not_retried(self):
        self.write_job("j1.json", "job-1")
        boom = FakeDispatch(raises=True)
        rec = self.loop(dispatch=boom).step()
        self.assertEqual(rec["status"], "dispatch_failed")
        self.assertTrue(os.path.isfile(os.path.join(self.claims, "job-1.claim")))  # CLAIM 済み
        # 次の周期: 同じジョブは claim 済みなので再実行されない
        again = self.loop().step()
        self.assertEqual(again["decision"], "skip")
        self.assertIn("already claimed", again["reason"])


class FailClosed(LoopBase):
    def test_halt_blocks_before_auth_and_accept(self):
        self.write_job("j1.json", "job-1")
        self.flag(resident.HALT_FLAG)
        rec = self.loop().step()
        self.assertEqual(rec["reason"], "halted")
        self.assertEqual(self.auth_calls, [])          # 認証確認すらしない
        self.assertEqual(self.dispatch.calls, [])
        self.assertEqual(os.listdir(self.claims), [])  # CLAIM しない

    def test_stop_blocks(self):
        self.write_job("j1.json", "job-1")
        self.flag(resident.STOP_FLAG)
        self.assertEqual(self.loop().step()["reason"], "stopped")
        self.assertEqual(self.dispatch.calls, [])

    def test_not_logged_in_does_not_claim(self):
        self.write_job("j1.json", "job-1")
        self.logged_in = False
        rec = self.loop().step()
        self.assertEqual(rec["reason"], "cli not logged in")
        self.assertEqual(self.dispatch.calls, [])       # 起動しない
        self.assertEqual(os.listdir(self.claims), [])   # 承認を消費しない（accept 前で止める）

    def test_bad_signature_job_is_skipped_without_dispatch(self):
        self.write_job("j1.json", "job-1", sig="hmac-sha256:" + "0" * 64)
        rec = self.loop().step()
        self.assertEqual(rec["decision"], "skip")
        self.assertEqual(self.dispatch.calls, [])
        self.assertEqual(os.listdir(self.claims), [])


class RunAndSafety(LoopBase):
    def test_run_max_cycles_polls_and_keeps_going_while_halted(self):
        self.flag(resident.HALT_FLAG)
        slept = []
        recs = self.loop().run(max_cycles=3, interval=5, sleep=lambda s: slept.append(s))
        self.assertEqual(len(recs), 3)
        self.assertTrue(all(r["reason"] == "halted" for r in recs))  # 止まらず周回は続く
        self.assertEqual(slept, [5, 5])  # 周期の間だけ待つ（最後の後は待たない）

    def test_flags_dir_group_writable_is_refused(self):
        os.chmod(self.flags, 0o777)
        with self.assertRaises(handoff.HandoffError):
            self.loop()

    def test_out_dir_not_owned_or_group_writable_is_refused(self):
        os.chmod(self.out, 0o777)
        with self.assertRaises(handoff.HandoffError):
            self.loop()

    def test_relative_cli_realpath_is_refused(self):
        with self.assertRaises(handoff.HandoffError):
            resident.ResidentLoop(self.inbox(), self.flags, self.out, "claude", "/Users/_kaburun",
                                  self.dispatch, auth_check=self.auth_check)


if __name__ == "__main__":
    unittest.main()
