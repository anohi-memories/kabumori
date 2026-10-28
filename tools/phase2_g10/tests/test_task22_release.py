"""TASK 22: 固定版（不変のスナップショット）と、固定版から動く検知役・S2・plist。実 Claude・launchd は使わない。

固定版を一時フォルダに作り、その中の bin/g10_autorun.py を別プロセスで動かして、代役の CLI で1回起動・2回目なしを確かめる。
中身の差し替え・余分なファイル・書き込み可・ハッシュ違い・開発 worktree からの live / plist は拒否（起動しない）ことを確かめる。
"""
import json
import os
import plistlib
import subprocess
import sys

from g10runner import autorun, launchd_plan, release
from g10runner.layout import Layout
from helpers import make_writable
from test_task17_real_adapter import FirstRunBase, git

PKG = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FAKE_COMMIT = "0" * 40


class ReleaseBase(FirstRunBase):

    def setUp(self):
        super().setUp()
        self.parent = os.path.join(self.env.real, "releases")
        self.addCleanup(make_writable, self.parent)
        self.rel, self.digest = release.install(PKG, self.parent, git_commit=FAKE_COMMIT)

    def run_release(self, script, *args):
        r = subprocess.run([sys.executable, "-I", os.path.join(self.rel, "bin", script)] + list(args),
                           capture_output=True, text=True, timeout=120)
        return r.returncode, r.stdout, r.stderr

    def tamper(self, rel_path, text="# changed\n"):
        p = os.path.join(self.rel, rel_path)
        os.chmod(os.path.dirname(p), 0o755)
        os.chmod(p, 0o644)
        with open(p, "a") as f:
            f.write(text)
        os.chmod(p, 0o444)
        os.chmod(os.path.dirname(p), 0o555)


class ReleaseInstall(ReleaseBase):

    def test_install_is_frozen_verified_and_idempotent(self):
        self.assertEqual(release.verify(self.rel, self.digest), [])
        self.assertEqual(os.path.basename(self.rel), self.digest[:16])
        self.assertFalse(os.stat(os.path.join(self.rel, "bin", "g10_autorun.py")).st_mode & 0o222)
        self.assertNotIn("tests", os.listdir(self.rel))
        again, digest = release.install(PKG, self.parent, git_commit=FAKE_COMMIT)
        self.assertEqual((again, digest), (self.rel, self.digest))
        other, digest2 = release.install(PKG, self.parent, git_commit="1" * 40)  # 元のコミットが違えば別の版
        self.assertNotEqual(digest2, self.digest)

    def test_verify_rejects_changes(self):
        self.assertTrue(release.verify(self.rel, "f" * 64))
        self.tamper("g10runner/autorun.py")
        self.assertTrue(any("content differs" in p for p in release.verify(self.rel, self.digest)))

    def test_verify_rejects_extra_and_writable_files(self):
        os.chmod(os.path.join(self.rel, "bin"), 0o755)
        with open(os.path.join(self.rel, "bin", "extra.py"), "w") as f:
            f.write("print(1)\n")
        problems = release.verify(self.rel, self.digest)
        self.assertTrue(any("file set differs" in p for p in problems))
        self.assertTrue(any("writable" in p for p in problems))

    def test_source_with_uncommitted_changes_is_refused(self):
        src = os.path.join(self.env.real, "src")
        for d in release.DIRS:
            os.makedirs(os.path.join(src, d))
            with open(os.path.join(src, d, "a.py"), "w") as f:
                f.write("x = 1\n")
        git(["init", "-q"], src)
        git(["add", "."], src)
        git(["commit", "-q", "-m", "s"], src)
        with open(os.path.join(src, "bin", "a.py"), "a") as f:
            f.write("y = 2\n")
        with self.assertRaises(release.ReleaseError):
            release.install(src, os.path.join(self.env.real, "r2"))
        git(["commit", "-q", "-am", "s2"], src)
        rel, digest = release.install(src, os.path.join(self.env.real, "r2"))
        self.addCleanup(make_writable, os.path.join(self.env.real, "r2"))
        self.assertEqual(release.verify(rel, digest), [])


class ReleaseAutorun(ReleaseBase):

    def test_release_autorun_launches_once(self):
        fr, root = self.approved_root()
        code, out, err = self.run_release("g10_autorun.py", "--root", root, "--once", "--live",
                                          "--release-digest", self.digest)
        last = json.loads(out.strip().splitlines()[-1])
        self.assertEqual((code, last["decision"], last["status"]), (0, "launched", "ended_checks_passed"), err)
        self.assertEqual(len(self.calls()), 1)
        code, out, err = self.run_release("g10_autorun.py", "--root", root, "--once", "--live",
                                          "--release-digest", self.digest)
        self.assertEqual(json.loads(out.strip().splitlines()[-1])["reason"], "approval already used")
        self.assertEqual(len(self.calls()), 1)

    def test_release_autorun_refuses_tampered_or_mismatched_release(self):
        fr, root = self.approved_root()
        code, out, err = self.run_release("g10_autorun.py", "--root", root, "--once", "--live")
        self.assertNotEqual(code, 0)
        self.assertIn("needs --release-digest", err)
        code, out, err = self.run_release("g10_autorun.py", "--root", root, "--once", "--live",
                                          "--release-digest", "a" * 64)
        self.assertIn("release verification failed", err)
        self.tamper("g10runner/real_claude.py")
        code, out, err = self.run_release("g10_autorun.py", "--root", root, "--once", "--live",
                                          "--release-digest", self.digest)
        self.assertIn("release verification failed", err)
        code, out, err = self.run_release("g10_watchdog.py", "--root", root, "--once",
                                          "--release-digest", self.digest)
        self.assertIn("release verification failed", err)
        self.assertEqual(self.calls(), [])

    def test_failed_check_before_launch_hard_halts(self):
        fr, root = self.approved_root()
        control, policy = autorun.open_control(root)
        entry = autorun.cycle(control, policy, True, release_check=lambda: ["content differs: x"])
        self.assertEqual((entry["decision"], entry["reason"]), ("halted", "release verification failed"))
        self.assertTrue(control.read_state().halted)
        self.assertEqual(self.calls(), [])

    def test_release_plists_and_rules(self):
        fr, root = self.approved_root()
        out = os.path.join(self.env.real, "plans")
        code, stdout, err = self.run_release("g10_first_run.py", "plists", "--root", root, "--out", out, "--live")
        self.assertEqual(code, 0, err)
        doc = json.loads(stdout)
        self.assertIs(doc["registered"], False)
        self.assertEqual(doc["release_digest"], self.digest)
        plans = {p["kind"]: plistlib.loads(open(p["path"], "rb").read()) for p in doc["plists"]}
        self.assertTrue(all(p["lint_ok"] for p in doc["plists"]))
        auto = plans["autorun"]["ProgramArguments"]
        self.assertEqual(auto[2], os.path.join(self.rel, "bin", "g10_autorun.py"))
        self.assertEqual(auto[7:], ["--release-digest", self.digest, "--live"])
        self.assertNotIn("--live", plans["watchdog"]["ProgramArguments"])
        self.assertTrue(launchd_plan.validate_agent_plan(plans["autorun"], self.rel))
        # 規則: 開発 worktree を指す計画・ハッシュ違い・余分なキー・短い間隔の live・API キーは不可
        dev = launchd_plan.user_agent_plan("autorun", "/usr/bin/python3", root, 300, self.digest, live=True)
        wrong = dict(plans["autorun"], ProgramArguments=auto[:8] + ["b" * 64, "--live"])
        fast = launchd_plan.user_agent_plan("autorun", "/usr/bin/python3", root, 60, self.digest, live=True,
                                            package_root=self.rel)
        for plan, pkg in ((dev, PKG), (wrong, self.rel), (dict(plans["autorun"], Program="/bin/sh"), self.rel),
                          (fast, self.rel),
                          (dict(plans["autorun"], EnvironmentVariables={"PATH": "/usr/bin", "ANTHROPIC_API_KEY": "x"}),
                           self.rel)):
            with self.assertRaises(launchd_plan.PlanError):
                launchd_plan.validate_agent_plan(plan, pkg)
        # 開発 worktree の g10_first_run.py からは plist を作らない
        with self.assertRaises(SystemExit):
            fr.main(["plists", "--root", root, "--out", out])


if __name__ == "__main__":
    import unittest
    unittest.main()
