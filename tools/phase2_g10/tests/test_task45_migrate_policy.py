"""B5: migrate-policy の結線。ライブ制御の policy を、このリリースの first_run_policy()（現行コードの timing）へ
安全に移行する。古い timing(120) を入れた状態から、--write で新 timing(600) の digest へ入れ替わり、正本/公開の
両方が read-back で一致すること、--write 無しでは書き換えないことを確かめる。実 Claude・ネットワークは使わない。"""
import contextlib
import io
import json
import os
import shutil
import tempfile
import unittest

from g10runner import policy as policy_mod
from g10runner.control import Control
from g10runner.layout import Layout
from test_task17_real_adapter import load_first_run


def _run(fr, argv):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        code = fr.main(argv)
    return code, buf.getvalue()


class MigratePolicy(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.fr = load_first_run()
        self.root = os.path.join(self.tmp, "control")
        self.assertEqual(_run(self.fr, ["init", "--root", self.root, "--issue-source", "file"])[0], 0)
        self.layout = Layout(self.root)

    def _install_old(self):
        # 現役ライブ相当: timing を旧値(120)に戻した policy を正本/公開へ入れておく
        old = json.loads(json.dumps(policy_mod.DEFAULT_POLICY))
        old["timing"]["issue_monitor_interval"] = 300.0
        old["timing"]["request_ttl"] = 120.0
        old["timing"]["issue_evidence_max_age"] = 120.0
        Control.install_policy(self.layout, old)
        return policy_mod.with_digest(old)["_digest"]

    def test_write_migrates_to_the_release_policy_and_reads_back(self):
        old_digest = self._install_old()
        self.assertEqual(policy_mod.load_current(self.layout)["_digest"], old_digest)
        newpol = policy_mod.with_digest(self.fr.first_run_policy())
        self.assertNotEqual(newpol["_digest"], old_digest)
        code, out = _run(self.fr, ["migrate-policy", "--root", self.root, "--write"])
        self.assertEqual(code, 0, out)
        d = json.loads(out)
        self.assertTrue(d["written"])
        self.assertEqual(d["current_policy_sha256"], old_digest)
        self.assertEqual(d["new_policy_sha256"], newpol["_digest"])
        self.assertIn("request_ttl", d["timing_changes"])
        # 正本・公開の両方が新 digest（read-back）
        self.assertEqual(policy_mod.load_current(self.layout)["_digest"], newpol["_digest"])
        pub = policy_mod.with_digest(policy_mod.load(self.layout.policy_pub))
        self.assertEqual(pub["_digest"], newpol["_digest"])

    def test_dry_run_does_not_write(self):
        old_digest = self._install_old()
        code, out = _run(self.fr, ["migrate-policy", "--root", self.root])
        self.assertEqual(code, 0, out)
        self.assertFalse(json.loads(out)["written"])
        self.assertEqual(policy_mod.load_current(self.layout)["_digest"], old_digest)


if __name__ == "__main__":
    unittest.main()
