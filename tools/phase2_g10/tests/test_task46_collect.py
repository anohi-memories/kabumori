"""B5: 制御側 collect（handoff/out 回収）と close_absent。CLAIM 済みで未終了の run を閉じる——
バンドルが無く disposition だけある run は END(absence_confirmed) で枠を解放、disposition も無い run は触らない、
--write 無しでは台帳に書かない。close_absent 単体の性質（解放・冪等・結果dir があれば拒否・CLAIM 無しは拒否）も確かめる。"""
import contextlib
import io
import json
import os
import shutil
import tempfile
import time
import unittest

from g10runner.layout import Layout
from test_task17_real_adapter import load_first_run


def _run(fr, argv):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = fr.main(argv)
    return code, buf.getvalue()


class CollectBase(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.fr = load_first_run()
        self.root = os.path.join(self.tmp, "control")
        self.assertEqual(_run(self.fr, ["init", "--root", self.root, "--issue-source", "file"])[0], 0)
        self.layout = Layout(self.root)
        self.out = os.path.join(self.tmp, "out")
        os.makedirs(self.out, 0o755)
        self.control = self.fr.open_control(self.root)[0]

    def claim(self, run_id, approval_id=None):
        self.control.ledger.append("CLAIM", {"run_id": run_id, "approval_id": approval_id or ("appr-" + run_id),
                                             "request_id": "req-" + run_id}, self.control.signer, "runner", time.time())

    def running(self):
        return self.control.running_count(self.control.ledger.read_all())

    def ends(self):
        return {r["payload"]["run_id"]: r["payload"] for r in self.control.ledger.read_all() if r["type"] == "END"}


class CloseAbsent(CollectBase):
    def test_closes_and_frees_the_slot(self):
        self.claim("run-aaaaaaaaaaaaaaaa")
        self.assertEqual(self.running(), 1)
        self.control.close_absent("run-aaaaaaaaaaaaaaaa", "exec rejected")
        self.assertEqual(self.running(), 0)
        e = self.ends()["run-aaaaaaaaaaaaaaaa"]
        self.assertTrue(e["absence_confirmed"])
        self.assertEqual(e["status"], "not_accepted")

    def test_idempotent(self):
        self.claim("run-bbbbbbbbbbbbbbbb")
        self.control.close_absent("run-bbbbbbbbbbbbbbbb", "r")
        self.assertIsNone(self.control.close_absent("run-bbbbbbbbbbbbbbbb", "r"))
        self.assertEqual(len([1 for r in self.control.ledger.read_all() if r["type"] == "END"]), 1)

    def test_refuses_when_a_result_dir_exists(self):
        self.claim("run-cccccccccccccccc")
        os.makedirs(self.layout.run_dir("run-cccccccccccccccc"))
        with self.assertRaises(ValueError):
            self.control.close_absent("run-cccccccccccccccc", "r")

    def test_refuses_without_a_claim(self):
        with self.assertRaises(ValueError):
            self.control.close_absent("run-dddddddddddddddd", "r")


class Collect(CollectBase):
    def _disposition(self, run_id, **kw):
        with open(os.path.join(self.out, run_id + ".json"), "w", encoding="utf-8") as f:
            json.dump(dict({"job_id": run_id, "status": "not_accepted", "run_id": run_id}, **kw), f)

    def test_reconciles_absent_run_with_disposition_only(self):
        rid = "run-1111111111111111"
        self.claim(rid)
        self._disposition(rid, reason="issue evidence stale")
        code, out = _run(self.fr, ["collect", "--root", self.root, "--out", self.out, "--write"])
        self.assertEqual(code, 0, out)
        d = json.loads(out)
        self.assertEqual(d["closed"][0]["action"], "reconcile_absent")
        self.assertEqual(self.running(), 0)
        self.assertTrue(self.ends()[rid]["absence_confirmed"])

    def test_pending_run_without_disposition_is_untouched(self):
        rid = "run-2222222222222222"
        self.claim(rid)
        code, out = _run(self.fr, ["collect", "--root", self.root, "--out", self.out, "--write"])
        self.assertEqual(json.loads(out)["closed"][0]["action"], "pending")
        self.assertEqual(self.running(), 1)
        self.assertNotIn(rid, self.ends())

    def test_dry_run_does_not_write(self):
        rid = "run-3333333333333333"
        self.claim(rid)
        self._disposition(rid)
        code, out = _run(self.fr, ["collect", "--root", self.root, "--out", self.out])
        self.assertFalse(json.loads(out)["written"])
        self.assertEqual(self.running(), 1)
        self.assertNotIn(rid, self.ends())


if __name__ == "__main__":
    unittest.main()
