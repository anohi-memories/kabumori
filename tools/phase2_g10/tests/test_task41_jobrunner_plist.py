"""B0-2: 専用ユーザー _kaburun の常駐ジョブ実行（bin/g10_jobrunner.py）の LaunchAgent（gui/503）の plist を
作って検査するだけ（登録しない）。固定版の中の g10_jobrunner.py だけを指す・ハッシュ一致・全パス絶対・間隔 300 秒以上・
環境は PATH/LANG だけ。開発 worktree を指す計画・ハッシュ違い・余分なキー・短い間隔・API キーは拒否。launchd は使わない。"""
import json
import os
import plistlib

from g10runner import launchd_plan
from test_task17_real_adapter import load_first_run
from test_task22_release import PKG, ReleaseBase


class JobRunnerPlist(ReleaseBase):
    def setUp(self):
        super().setUp()
        self.root = os.path.join(self.env.real, "exec-root")
        os.makedirs(self.root)
        # handoff のパス（向きは呼び出し側が固定。plist 生成はパスが絶対であることだけを見る）
        self.hin = os.path.join(self.env.real, "g10-handoff", "in")
        self.claims = os.path.join(self.env.real, "g10-kaburun", "claims")
        self.hout = os.path.join(self.env.real, "g10-kaburun", "out")
        self.flags = os.path.join(self.env.real, "g10-handoff", "flags")
        self.cli = "/Users/_kaburun/clirun/2.1.305"
        self.home = "/Users/_kaburun"
        self.plans = os.path.join(self.env.real, "plans")

    def generate(self):
        return self.run_release(
            "g10_first_run.py", "jobrunner-plist", "--root", self.root, "--in", self.hin, "--claims", self.claims,
            "--out", self.hout, "--flags", self.flags, "--cli", self.cli, "--home", self.home, "--plans", self.plans)

    def test_release_jobrunner_plist_and_rules(self):
        code, stdout, err = self.generate()
        self.assertEqual(code, 0, err)
        doc = json.loads(stdout)
        self.assertIs(doc["registered"], False)
        self.assertEqual(doc["release_digest"], self.digest)
        self.assertTrue(doc["lint_ok"])
        self.assertIn("gui/$(id -u)", doc["commands_not_run"]["install"])  # _kaburun のセッションで id -u=503

        plan = plistlib.loads(open(doc["path"], "rb").read())
        args = plan["ProgramArguments"]
        self.assertEqual(args[2], os.path.join(self.rel, "bin", "g10_jobrunner.py"))  # 固定版の中のものだけ
        self.assertEqual(args[-2:], ["--release-digest", self.digest])
        self.assertEqual(plan["Label"], launchd_plan.JOBRUNNER_LABEL)
        self.assertNotIn("--once", args)  # 常駐（--once は付けない）
        self.assertTrue(launchd_plan.validate_job_runner_plan(plan, self.rel))

        # 規則: 開発 worktree を指す計画・ハッシュ違い・余分なキー・短い間隔・相対パス・API キーは不可
        dev = launchd_plan.job_runner_agent_plan("/usr/bin/python3", self.root, self.hin, self.claims, self.hout,
                                                 self.flags, self.cli, self.home, 300, self.digest)
        wrong_digest = dict(plan, ProgramArguments=args[:20] + ["b" * 64])
        fast = launchd_plan.job_runner_agent_plan("/usr/bin/python3", self.root, self.hin, self.claims, self.hout,
                                                  self.flags, self.cli, self.home, 60, self.digest,
                                                  package_root=self.rel)
        rel_path = launchd_plan.job_runner_agent_plan("/usr/bin/python3", self.root, "relative/in", self.claims,
                                                      self.hout, self.flags, self.cli, self.home, 300, self.digest,
                                                      package_root=self.rel)
        for plan_, pkg in ((dev, PKG), (wrong_digest, self.rel), (fast, self.rel), (rel_path, self.rel),
                           (dict(plan, Program="/bin/sh"), self.rel),
                           (dict(plan, EnvironmentVariables={"PATH": "/usr/bin", "ANTHROPIC_API_KEY": "x"}), self.rel)):
            with self.assertRaises(launchd_plan.PlanError):
                launchd_plan.validate_job_runner_plan(plan_, pkg)

    def test_development_tree_refuses_to_make_the_plist(self):
        fr = load_first_run()  # 開発 worktree の g10_first_run.py（固定版ではない）
        with self.assertRaises(SystemExit):
            fr.main(["jobrunner-plist", "--root", self.root, "--in", self.hin, "--claims", self.claims,
                     "--out", self.hout, "--flags", self.flags, "--cli", self.cli, "--home", self.home])


if __name__ == "__main__":
    import unittest
    unittest.main()
