"""§14.5/§14.9 指摘1: ソースを handoff の git bundle から用意する BundleSourcePreparer。
yuya 本人の repo を読まない（bundle は自己完結ファイル）ことを、bundle 作成後に元 repo を消しても
作業フォルダを用意できる、で証明する。実 Claude・ネットワーク・本物の HOME は使わない。
"""
import os
import shutil
import subprocess
import tempfile
import unittest

from g10runner.real_claude import BundleSourcePreparer, RealClaudeError

GIT = "/usr/bin/git"


def git(args, cwd):
    env = {"PATH": "/usr/bin:/bin", "HOME": "/tmp", "GIT_CONFIG_NOSYSTEM": "1", "GIT_TERMINAL_PROMPT": "0",
           "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.test",
           "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.test"}
    r = subprocess.run([GIT] + args, cwd=cwd, env=env, capture_output=True, text=True)
    if r.returncode != 0:
        raise AssertionError("git %s failed: %s" % (args, r.stderr))
    return r.stdout.strip()


class BundleSource(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.src = os.path.join(self.tmp, "src")
        os.makedirs(self.src)
        git(["init", "-q"], self.src)
        with open(os.path.join(self.src, "f.txt"), "w") as f:
            f.write("hello\n")
        git(["add", "f.txt"], self.src)
        git(["commit", "-q", "-m", "c1"], self.src)
        self.base = git(["rev-parse", "HEAD"], self.src)
        self.bundle = os.path.join(self.tmp, "s.bundle")
        git(["bundle", "create", self.bundle, "--all"], self.src)

    def test_prepares_from_bundle_without_touching_source_repo(self):
        shutil.rmtree(self.src)  # 元 repo を消す = bundle が自己完結でないと失敗する
        work = os.path.join(self.tmp, "work")
        BundleSourcePreparer(self.bundle).prepare(work, "refs/heads/main", self.base)
        self.assertEqual(git(["rev-parse", "HEAD"], work), self.base)
        with open(os.path.join(work, "f.txt")) as f:
            self.assertEqual(f.read(), "hello\n")
        self.assertFalse(os.path.exists(self.src))  # 元 repo は無いまま（参照していない）

    def test_missing_bundle_is_rejected(self):
        work = os.path.join(self.tmp, "w2")
        with self.assertRaises(RealClaudeError):
            BundleSourcePreparer(os.path.join(self.tmp, "nope.bundle")).prepare(work, "r", self.base)
        self.assertFalse(os.path.exists(work))

    def test_symlink_bundle_is_rejected(self):
        link = os.path.join(self.tmp, "link.bundle")
        os.symlink(self.bundle, link)
        with self.assertRaises(RealClaudeError):
            BundleSourcePreparer(link).prepare(os.path.join(self.tmp, "w3"), "r", self.base)

    def test_bad_base_sha_is_rejected(self):
        with self.assertRaises(RealClaudeError):
            BundleSourcePreparer(self.bundle).prepare(os.path.join(self.tmp, "w4"), "r", "not-a-sha")

    def test_absent_commit_in_bundle_is_caught(self):
        work = os.path.join(self.tmp, "w5")
        missing = "0" * 40
        with self.assertRaises(RealClaudeError):
            BundleSourcePreparer(self.bundle).prepare(work, "r", missing)

    def test_existing_work_dir_is_rejected(self):
        work = os.path.join(self.tmp, "w6")
        os.makedirs(work)
        with self.assertRaises(RealClaudeError):
            BundleSourcePreparer(self.bundle).prepare(work, "r", self.base)


if __name__ == "__main__":
    unittest.main()


class GoSourceBundleWiring(unittest.TestCase):
    """GO の任意欄 source_bundle: go_problem の検査と、アダプタが Bundle/Git を選ぶこと（§14.9 指摘1 の配線）。"""

    def _go(self, **over):
        import time
        go = {"go_id": "g", "approval_id": "a", "task_sha256": "a" * 64, "body_sha256": "b" * 64,
              "cli_realpath": "/opt/claude/2.1.305", "cli_version": "2.1.305", "home": "/Users/x",
              "max_turns": 10, "source_repo": "/r", "expires_at": time.time() + 60, "max_runs": 1}
        go.update(over)
        return go

    def test_go_without_source_bundle_still_valid(self):
        from g10runner import real_claude
        self.assertIsNone(real_claude.go_problem(self._go()))

    def test_absolute_source_bundle_is_accepted(self):
        from g10runner import real_claude
        self.assertIsNone(real_claude.go_problem(self._go(source_bundle="/h/in/src.bundle")))

    def test_relative_source_bundle_is_refused(self):
        from g10runner import real_claude
        self.assertIsNotNone(real_claude.go_problem(self._go(source_bundle="src.bundle")))

    def test_unknown_extra_field_still_refused(self):
        from g10runner import real_claude
        self.assertIsNotNone(real_claude.go_problem(self._go(bogus=1)))

    def test_adapter_selects_bundle_when_source_bundle_present(self):
        from g10runner.real_claude import RealClaudeAdapter, BundleSourcePreparer, GitSourcePreparer
        with_bundle = RealClaudeAdapter(self._go(source_bundle="/h/in/src.bundle"))
        self.assertIsInstance(with_bundle.source_preparer(), BundleSourcePreparer)
        without = RealClaudeAdapter(self._go())
        self.assertIsInstance(without.source_preparer(), GitSourcePreparer)
