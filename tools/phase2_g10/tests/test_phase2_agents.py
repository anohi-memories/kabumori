"""Phase 2 無人エージェント（producer / collector）の LaunchAgent 計画の検査（TASK: B6 無人化）。

producer/collector は yuya の gui ドメインで常時 --live で動く。plist は:
  - 同梱（インストール済みリリース）の bin/g10_producer.py / g10_collector.py だけを指す（開発 worktree は不可）。
  - パス引数（--root/--in/--bundles-dir/--source-repo/--cli/--home/--out）は絶対パス。
  - --interval >= 300（認証なし GitHub 取得上限）。--live 必須。release-digest がその版と一致。
実 launchd は使わない（計画を作って検査するだけ）。
"""
import os
import plistlib

from g10runner import launchd_plan, release
from g10runner.launchd_plan import PlanError
from test_task22_release import PKG, FAKE_COMMIT, ReleaseBase


class Phase2AgentBase(ReleaseBase):
    def _abs(self, name):
        d = os.path.join(self.env.real, name)
        os.makedirs(d, exist_ok=True)
        return d

    def producer(self, **over):
        kw = dict(python="/usr/bin/python3", root=self._abs("ctl"), in_dir=self._abs("hin"),
                  bundles_dir=self._abs("bun"), source_repo=self._abs("repo"),
                  cli=self._abs("cli"), home=self._abs("home"), interval=300.0,
                  release_digest=self.digest, package_root=self.rel)
        kw.update(over)
        return launchd_plan.producer_agent_plan(**kw)

    def dispatcher(self, **over):
        disp = self._abs("disp")
        kw = dict(python="/usr/bin/python3", root=self._abs("ctl"),
                  registry=os.path.join(disp, "registry.json"),
                  cursor_file=os.path.join(disp, "cursor.json"),
                  interval=120.0, release_digest=self.digest, package_root=self.rel)
        kw.update(over)
        return launchd_plan.dispatcher_agent_plan(**kw)

    def collector(self, **over):
        kw = dict(python="/usr/bin/python3", root=self._abs("ctl"), out_dir=self._abs("hout"),
                  interval=300.0, release_digest=self.digest, package_root=self.rel)
        kw.update(over)
        return launchd_plan.collector_agent_plan(**kw)


class Phase2AgentValid(Phase2AgentBase):
    def test_producer_plan_validates_and_renders(self):
        plan = self.producer()
        self.assertTrue(launchd_plan.validate_agent_plan(plan, self.rel))
        data = launchd_plan.render_validated_agent(plan, self.rel)
        self.assertEqual(plistlib.loads(data), plan)                 # round-trip 一致
        self.assertEqual(plan["Label"], "com.kabumori.g10.phase2.agent.producer")
        self.assertIs(plan["KeepAlive"], True)

    def test_collector_plan_validates_and_renders(self):
        plan = self.collector()
        self.assertTrue(launchd_plan.validate_agent_plan(plan, self.rel))
        self.assertEqual(plan["Label"], "com.kabumori.g10.phase2.agent.collector")

    def test_dispatcher_plan_validates_at_two_minutes(self):
        plan = self.dispatcher()                               # interval=120（2分）
        self.assertTrue(launchd_plan.validate_agent_plan(plan, self.rel))
        self.assertEqual(plan["Label"], "com.kabumori.g10.phase2.agent.dispatcher")

    def test_collector_validates_at_two_minutes(self):
        plan = self.collector(interval=120.0)                  # collector の下限は 120（ローカル）
        self.assertTrue(launchd_plan.validate_agent_plan(plan, self.rel))

    def test_agent_commands_use_gui_domain(self):
        cmds = launchd_plan.agent_commands("com.kabumori.g10.phase2.agent.collector", "/x.plist")
        self.assertIn("launchctl bootstrap gui/$(id -u)", cmds["install"])  # sudo 不要・主ユーザーの gui


class Phase2AgentRejections(Phase2AgentBase):
    def test_development_tree_is_refused(self):
        # 開発 worktree（マニフェスト無し）を指す計画は拒否（起動しない）
        plan = self.producer(package_root=PKG)
        with self.assertRaises(PlanError):
            launchd_plan.validate_agent_plan(plan, PKG)

    def test_relative_path_is_refused(self):
        plan = self.producer()
        i = plan["ProgramArguments"].index("--in")
        plan["ProgramArguments"][i + 1] = "relative/in"
        with self.assertRaises(PlanError):
            launchd_plan.validate_agent_plan(plan, self.rel)

    def test_interval_below_floor_is_refused(self):
        plan = self.producer(interval=60.0)
        with self.assertRaises(PlanError):
            launchd_plan.validate_agent_plan(plan, self.rel)

    def test_missing_live_is_refused(self):
        plan = self.collector()
        plan["ProgramArguments"].remove("--live")
        with self.assertRaises(PlanError):
            launchd_plan.validate_agent_plan(plan, self.rel)

    def test_tampered_release_digest_is_refused(self):
        plan = self.producer(release_digest="f" * 64)
        with self.assertRaises(PlanError):
            launchd_plan.validate_agent_plan(plan, self.rel)

    def test_unexpected_flag_is_refused(self):
        plan = self.collector()
        plan["ProgramArguments"] += ["--comment", "x"]
        with self.assertRaises(PlanError):
            launchd_plan.validate_agent_plan(plan, self.rel)

    def test_dispatcher_interval_below_120_is_refused(self):
        plan = self.dispatcher(interval=60.0)                  # dispatcher 下限 120
        with self.assertRaises(PlanError):
            launchd_plan.validate_agent_plan(plan, self.rel)

    def test_dispatcher_relative_registry_is_refused(self):
        plan = self.dispatcher()
        i = plan["ProgramArguments"].index("--registry")
        plan["ProgramArguments"][i + 1] = "relative/registry.json"
        with self.assertRaises(PlanError):
            launchd_plan.validate_agent_plan(plan, self.rel)

    def test_non_bundled_script_is_refused(self):
        plan = self.producer()
        plan["ProgramArguments"][2] = "/tmp/evil_producer.py"
        with self.assertRaises(PlanError):
            launchd_plan.validate_agent_plan(plan, self.rel)


if __name__ == "__main__":
    import unittest
    unittest.main()
