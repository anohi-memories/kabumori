"""B6 無人 producer の判定: 有効な ENVELOPE（人の日次同意）の下で #323 の ready・未claim・窓内 TASK を emit 判定する。
ENVELOPE 無し・claim 済み・窓外では emit しない。実 Claude は呼ばない（起動は exec の resident）。"""
import contextlib
import io
import os
import time
import unittest

from g10runner import producer
from helpers import EnvTestCase, TRUSTED_ISSUE, make_body
from test_task17_real_adapter import load_first_run


class ProducerEvaluate(EnvTestCase):
    def _publish(self, **kw):
        body = make_body(self.env.policy, **kw)
        self.env.issue.publish(body)
        return body

    def test_emit_when_envelope_covers_ready_unclaimed_task(self):
        self._publish()
        self.env.envelope()
        d = producer.evaluate(self.env.control, self.env.policy)
        self.assertEqual(d["decision"], "emit", d)
        self.assertEqual(d["approval_id"], "g10-p2-test-0001")

    def test_idle_without_an_envelope(self):
        self._publish()  # ready な TASK はあるが、人の日次同意（ENVELOPE）が無い
        d = producer.evaluate(self.env.control, self.env.policy)
        self.assertEqual(d["decision"], "idle")
        self.assertIn("no active envelope", d["reason"])

    def test_idle_when_approval_already_claimed(self):
        body = self._publish()
        self.env.envelope()
        self.assertIsNotNone(self.env.control.try_claim(body, TRUSTED_ISSUE, time.time())[0])
        d = producer.evaluate(self.env.control, self.env.policy)
        self.assertEqual(d["decision"], "idle")
        self.assertIn("already used", d["reason"])

    def test_idle_when_task_outside_envelope(self):
        self._publish()
        self.env.envelope(scopes=["limited_code_edit"])  # readonly_trial を覆わない窓
        d = producer.evaluate(self.env.control, self.env.policy)
        self.assertEqual(d["decision"], "idle")
        self.assertIn("outside the active envelope", d["reason"])


class ApproveTrialEnvelope(ProducerEvaluate):
    def test_grants_readonly_trial_daily_window_then_emits(self):
        self.assertIsNone(self.env.control.read_state().envelope)      # 最初は envelope 無し
        env = producer.approve_trial_envelope(self.env.control, self.env.policy)
        self.assertEqual(env["scopes"], ["readonly_trial"])            # scope は readonly_trial 固定
        self.assertEqual(env["policy_sha256"], self.env.policy["_digest"])
        self.assertGreater(env["expires_at"], self.env.control.now())  # 翌 04:00 の未来
        self._publish()                                               # ready なタスクを置くと
        self.assertEqual(producer.evaluate(self.env.control, self.env.policy)["decision"], "emit")  # emit になる


class BinSmoke(unittest.TestCase):
    """bin/g10_producer.py・g10_collector.py の --once dry-run が、初期化した control で 0 を返し判定を記録する。"""
    def _load(self, name):
        import importlib.util
        here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        spec = importlib.util.spec_from_file_location(name, os.path.join(here, "bin", name + ".py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    def setUp(self):
        import tempfile, shutil
        self.tmp = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.fr = load_first_run()
        self.root = os.path.join(self.tmp, "control")
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.assertEqual(self.fr.main(["init", "--root", self.root, "--issue-source", "file"]), 0)

    def test_producer_once_dry_run_returns_zero(self):
        prod = self._load("g10_producer")
        d = os.path.join(self.tmp, "x"); os.makedirs(d)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = prod.main(["--root", self.root, "--in", d, "--bundles-dir", d, "--source-repo", d,
                            "--cli", "/opt/claude/2.1.305", "--home", "/Users/_kaburun", "--once"])
        self.assertEqual(rc, 0, buf.getvalue())
        self.assertIn("decision", buf.getvalue())  # 判定を1件出す（ENVELOPE 無しなら idle）

    def test_collector_once_dry_run_returns_zero(self):
        coll = self._load("g10_collector")
        out = os.path.join(self.tmp, "out"); os.makedirs(out)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = coll.main(["--root", self.root, "--out", out, "--once"])
        self.assertEqual(rc, 0, buf.getvalue())


if __name__ == "__main__":
    unittest.main()
