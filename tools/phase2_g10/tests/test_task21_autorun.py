"""TASK 21: 無人の検知と監督付き1回起動（bin/g10_autorun.py）の乾式 E2E。実 Claude・ネットワーク・launchd は使わない。

模擬 Issue（ファイル）と代役の CLI で、init → approve の後の検知役を --once で回し、
GO なし・S2 の停止・HALT・未ログイン・本文の差し替えでは起動せず、条件がそろったときだけ1回起動し、2回目は起動しない
ことを確かめる。あわせて unhalt・plists（作って検査するだけ）・作業フォルダの実行ビットの保持を確かめる。
"""
import contextlib
import importlib.util
import io
import json
import os
import stat
import subprocess

from g10runner import autorun, issue as issue_mod
from g10runner.layout import Layout
from helpers import make_body
from test_task17_real_adapter import FirstRunBase, git


def load_autorun_cli():
    spec = importlib.util.spec_from_file_location("g10_autorun", os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bin", "g10_autorun.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class AutorunE2E(FirstRunBase):

    def setUp(self):
        super().setUp()
        # 実行ビットつきのファイルを base_sha に含める（読み取り専用にしても実行ビットが残ることを見る）
        tool = os.path.join(self.repo, "tool.sh")
        with open(tool, "w") as f:
            f.write("#!/bin/sh\n")
        os.chmod(tool, 0o755)
        git(["add", "tool.sh"], self.repo)
        git(["commit", "-q", "-m", "tool"], self.repo)
        self.base_sha = subprocess.run(["/usr/bin/git", "rev-parse", "HEAD"], cwd=self.repo, capture_output=True,
                                       text=True, check=True).stdout.strip()
        self.ar = load_autorun_cli()

    def once(self, root, live=False):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = self.ar.main(["--root", root, "--once"] + (["--live", "--dev"] if live else []))
        last = json.loads(buf.getvalue().strip().splitlines()[-1])
        return code, last

    def test_detects_and_launches_once_then_stays_idle(self):
        fr, root = self.approved_root()
        code, d = self.once(root)  # 既定は dry-run: 判定だけで起動しない
        self.assertEqual((d["decision"], d["mode"]), ("dry_run", "dry_run"))
        self.assertEqual(self.calls(), [])
        code, d = self.once(root, live=True)
        self.assertEqual((code, d["decision"], d["status"]), (0, "launched", "ended_checks_passed"), d)
        self.assertEqual(len(self.calls()), 1)
        self.assertTrue(os.path.exists(os.path.join(Layout(root).reports, d["run_id"] + ".md")))
        code, d = self.once(root, live=True)  # 同じ承認では二度と起動しない
        self.assertEqual((d["decision"], d["reason"]), ("idle", "approval already used"))
        self.assertEqual(len(self.calls()), 1)
        # 作業フォルダ: 実行ビットが残り、git から見て変更なし（TASK 21）
        work = os.path.join(root, "work", self.calls()[0]["cwd"].rsplit("/", 1)[-1])
        self.assertTrue(os.stat(os.path.join(work, "tool.sh")).st_mode & stat.S_IXUSR)
        self.assertEqual(subprocess.run(["/usr/bin/git", "status", "--short"], cwd=work, capture_output=True,
                                        text=True, env={"PATH": "/usr/bin:/bin", "HOME": "/nonexistent"}).stdout, "")
        # 記録には本文・メールアドレスを書かない
        log = open(autorun.log_path(Layout(root)), encoding="utf-8").read()
        self.assertNotIn("目的", log)
        self.assertNotIn("secret-person", log)

    def test_no_launch_without_go_or_s2_or_login_or_with_a_changed_body(self):
        fr, root = self.approved_root()
        s2 = Layout(root).s2_heartbeat
        os.remove(s2)
        self.assertEqual(self.once(root, live=True)[1]["reason"], "S2 watchdog heartbeat is not fresh")
        __import__("g10runner.supervise", fromlist=["x"]).write_s2_heartbeat(Layout(root))
        marker = os.path.join(self.cli_dir, "NOT_LOGGED_IN")
        open(marker, "w").close()
        self.assertEqual(self.once(root, live=True)[1]["reason"], "CLI is not logged in in the child environment")
        os.remove(marker)
        # 本文の差し替え（同じ承認番号のまま内容が違う）: その本文への人の GO が無いので起動しない
        policy = __import__("g10runner.policy", fromlist=["load"]).load(Layout(root).policy_pub)
        other = make_body(policy, mutate=lambda b: b.replace("0c42933ca5030ab31a56267529430d0473d9b155",
                                                              self.base_sha).replace("食い違い", "相違"))
        issue_mod.FileIssueSource(issue_mod.mock_issue_path(root)).publish(other)
        self.assertEqual(self.once(root, live=True)[1]["reason"], "waiting for a human REAL_CLAUDE_GO for this body")
        self.assertEqual(self.calls(), [])

    def test_halt_blocks_and_unhalt_releases(self):
        fr, root = self.approved_root()
        with contextlib.redirect_stdout(io.StringIO()):
            fr.main(["halt", "--root", root, "--reason", "test"])
        self.assertEqual(self.once(root, live=True)[1]["reason"], "halted")
        self.assertEqual(self.calls(), [])
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.assertEqual(fr.main(["unhalt", "--root", root, "--reason", "test release"]), 0)
        self.assertTrue(json.loads(buf.getvalue())["unhalted"])
        self.assertEqual(self.once(root, live=True)[1]["decision"], "launched")
        self.assertEqual(len(self.calls()), 1)

    def test_single_instance(self):
        fr, root = self.approved_root()
        from g10runner.fsutil import FileLock
        lock_path = os.path.join(root, "control", "priv", "autorun.lock")
        open(lock_path, "a").close()
        with FileLock(lock_path, "ex", timeout=1) as held:
            self.assertTrue(held.acquired)
            with self.assertRaises(SystemExit):
                self.ar.main(["--root", root, "--once", "--live", "--dev"])
        self.assertEqual(self.calls(), [])
        with self.assertRaises(SystemExit):  # 繰り返しの live は 300秒以上の間隔だけ
            self.ar.main(["--root", root, "--live", "--dev", "--interval", "60"])
        with self.assertRaises(SystemExit):  # TASK 22: 開発 worktree からの live は --dev のときだけ
            self.ar.main(["--root", root, "--once", "--live"])
        self.assertEqual(self.calls(), [])


if __name__ == "__main__":
    import unittest
    unittest.main()
