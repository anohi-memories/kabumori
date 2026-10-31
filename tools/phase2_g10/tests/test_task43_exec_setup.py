"""B1 の非特権の仕上げ: exec プレーンの組み立て補助。
- `wiring.exec_wiring_doc`: control 側の wiring を雛形に、exec 側の wiring（private は {agent,witness} だけ）を作る。
- `g10_first_run.py exec-init`: その wiring.json を置き、agent-out/work/requests と pub→control_pub の symlink を作って検証（B1c）。
- `g10_first_run.py watchdog-plist`: exec の S2 見張り役の LaunchAgent（gui/503）の plist を作って検査するだけ（B1d）。
launchd 登録・実 Claude・特権は使わない。"""
import json
import os
import plistlib
import unittest

from g10runner import wiring
from g10runner.layout import SplitLayout
from test_task17_real_adapter import load_first_run
from test_task22_release import PKG, ReleaseBase
from test_task40_jobrunner import JobRunnerBase


class ExecWiringDoc(unittest.TestCase):
    TEMPLATE = {"version": 3, "mode": "ecdsa",
                "public_keys": {"runner": "/x/runner.pub", "human": "/x/human.pub",
                                "agent": "/x/agent.pub", "witness": "/x/witness.pub"},
                "private_keys": {"agent": "/x/agent.key", "witness": "/x/witness.key"},
                "issue_source": {"kind": "github_rest_anonymous"},
                "ledger": {"path": "/x/ledger.json", "limit_per_hour": 10, "reserve_fraction": 0.0,
                           "watchdog_interval": 60.0}}

    def test_private_keys_are_agent_and_witness_only(self):
        doc = wiring.exec_wiring_doc(self.TEMPLATE, "/kab/keys")
        self.assertEqual(set(doc["private_keys"]), {"agent", "witness"})  # runner/human の秘密鍵は入れない
        self.assertNotIn("runner", doc["private_keys"])
        self.assertNotIn("human", doc["private_keys"])
        self.assertEqual(set(doc["public_keys"]), {"runner", "human", "agent", "witness"})
        self.assertEqual(doc["private_keys"]["agent"], os.path.join("/kab/keys", "agent.key"))
        # issue_source・ledger・version・mode は雛形のまま写す
        self.assertEqual(doc["issue_source"], self.TEMPLATE["issue_source"])
        self.assertEqual(doc["ledger"], self.TEMPLATE["ledger"])
        self.assertEqual((doc["version"], doc["mode"]), (3, "ecdsa"))

    def test_hmac_template_is_refused(self):
        with self.assertRaises(wiring.WiringError):
            wiring.exec_wiring_doc(dict(self.TEMPLATE, mode="hmac"), "/kab/keys")


class ExecInit(JobRunnerBase):
    """exec-init が、yuya の wiring を雛形に agent-only の wiring.json を組み、pub を control_pub への symlink にする（B1c）。"""

    def setUp(self):
        super().setUp()
        self.control_pub = os.path.join(self.env.real, "control-pub")
        os.makedirs(self.control_pub)
        self.exec_root = os.path.join(self.env.real, "exec-root")
        self.fr = load_first_run()

    def test_exec_init_builds_agent_only_wiring_and_pub_symlink(self):
        rc = self.fr.main(["exec-init", "--root", self.exec_root, "--control-pub", self.control_pub,
                           "--keys-dir", os.path.join(self.env.real, "keys"),
                           "--from-wiring", os.path.join(self.env.tmp, "wiring.json")])
        self.assertEqual(rc, 0)
        cfg = wiring.load(self.exec_root)
        self.assertIsNotNone(cfg)
        self.assertEqual(set(cfg["private_keys"]), {"agent", "witness"})  # 権限鍵は入らない
        self.assertEqual(os.path.realpath(os.path.join(self.exec_root, "pub")), os.path.realpath(self.control_pub))
        self.assertTrue(os.path.isdir(os.path.join(self.exec_root, "agent-out", "requests")))
        signer, _v = wiring.agent_side(self.exec_root)   # agent 鍵が実際に使える
        self.assertTrue(signer.can_sign("agent"))
        self.assertFalse(signer.can_sign("runner"))


class WatchdogPlist(ReleaseBase):
    def test_release_watchdog_plist(self):
        root = os.path.join(self.env.real, "exec-root")
        os.makedirs(root)
        out = os.path.join(self.env.real, "plans")
        code, stdout, err = self.run_release("g10_first_run.py", "watchdog-plist", "--root", root, "--plans", out)
        self.assertEqual(code, 0, err)
        doc = json.loads(stdout)
        self.assertIs(doc["registered"], False)
        self.assertEqual(doc["kind"], "watchdog")
        self.assertTrue(doc["lint_ok"])
        self.assertIn("gui/$(id -u)", doc["commands_not_run"]["install"])
        plan = plistlib.loads(open(doc["path"], "rb").read())
        self.assertEqual(plan["ProgramArguments"][2], os.path.join(self.rel, "bin", "g10_watchdog.py"))
        self.assertNotIn("--live", plan["ProgramArguments"])  # 見張り役は live にしない
        from g10runner import launchd_plan
        self.assertTrue(launchd_plan.validate_agent_plan(plan, self.rel))


if __name__ == "__main__":
    unittest.main()
