"""TASK 30: 第29TASKの独立レビューで再現された2つの穴の修正。

A. ~/.claude の保護が、親フォルダの改名・置き換えで抜けられた → 境界のある許可・フォルダそのものの改名の拒否・memory の
   名前の全面拒否（偽の HOME で sandbox-exec を実行して確かめる。本物の ~/.claude には触れない）。~/.claude.json の
   後のセッションに効く項目は、実行の前後の指紋で見張る。
B. CLI の終了後に残ったプロセスが、照合の最中に許可ファイルを差し替えられた → 同じグループの残りを止めて確かめ、親フォルダを
   封印し、リンク・FIFO を辿らない1回の読み取りでハッシュと差分を作る。
実 Claude・launchd・ネットワークは使わない。
"""
import json
import os
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import unittest
from unittest import mock

from g10runner import code_edit
from g10runner.layout import Layout
from test_task26_code_edit import FIX, CodeEditBase

HOME_PROBE = r'''
import json, os, sys
H = os.path.realpath(sys.argv[1]); C = H + "/.claude"; A = sys.argv[2]
out = []
def t(name, fn):
    try:
        fn(); out.append([name, "ok"])
    except OSError as e:
        out.append([name, e.errno])
def w(p, text="x"):
    with open(p, "w") as f:
        f.write(text)
def atomic(p):
    tmp = "%s.tmp.%d.0123456789ab" % (p, os.getpid()); w(tmp); os.rename(tmp, p)
t("need .claude.json atomic", lambda: atomic(H + "/.claude.json"))
t("need .claude.json.backup", lambda: w(H + "/.claude.json.backup"))
t("need new project transcript", lambda: (os.makedirs(C + "/projects/-run-1"), w(C + "/projects/-run-1/s.jsonl")))
t("need state file in .claude", lambda: atomic(C + "/statsig.json"))
t("need rename inside a project", lambda: os.rename(C + "/projects/-run-1/s.jsonl", C + "/projects/-run-1/t.jsonl"))
t("mkdir .claudeX", lambda: os.makedirs(H + "/.claudeX/hooks"))
t("file .claude-old", lambda: w(H + "/.claude-old"))
t("rename .claude away", lambda: os.rename(C, H + "/.claude-old"))
t("rename projects away", lambda: os.rename(C + "/projects", C + "/p-old"))
t("rename existing project away", lambda: os.rename(C + "/projects/user-repo", C + "/projects/x-old"))
t("remove empty project", lambda: os.rmdir(C + "/projects/empty-proj"))
t("rename existing memory away", lambda: os.rename(C + "/projects/user-repo/memory", C + "/projects/user-repo/m-old"))
t("crafted dir with memory", lambda: os.makedirs(C + "/crafted/memory"))
t("rename dir to <project>/memory", lambda: (os.makedirs(C + "/projects/-run-1/m"),
                                            os.rename(C + "/projects/-run-1/m", C + "/projects/-run-1/memory")))
t("rename crafted over empty project", lambda: (os.makedirs(C + "/crafted3"),
                                                os.rename(C + "/crafted3", C + "/projects/empty-proj")))
t("rename dir to hooks", lambda: (os.makedirs(C + "/crafted4"), os.rename(C + "/crafted4", C + "/hooks")))
t("rename file to settings.json", lambda: (w(C + "/s.tmp"), os.rename(C + "/s.tmp", C + "/settings.json")))
t("write rules", lambda: (os.makedirs(C + "/rules"), w(C + "/rules/r.md")))
t("unlink approved", lambda: os.unlink(A))
t("symlink at approved", lambda: os.symlink("/etc/hosts", A))
t("fifo at approved", lambda: os.mkfifo(A))
t("dir at approved", lambda: os.mkdir(A))
print(json.dumps(out))
'''


class HomeAndApprovedNameRules(unittest.TestCase):
    """A と、許可ファイルの名前の位置での種類の拒否（sandbox-exec の設定そのもの）。"""

    def test_home_rename_bypasses_are_denied_and_needed_state_still_works(self):
        tmp = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        home = os.path.join(tmp, "home")
        for d in (".claude/projects/user-repo/memory", ".claude/projects/empty-proj", ".claude/hooks", "w"):
            os.makedirs(os.path.join(home if d != "w" else tmp, d))
        with open(os.path.join(home, ".claude/projects/user-repo/memory/m.md"), "w") as f:
            f.write("m\n")
        approved = os.path.join(tmp, "w", "a.py")
        with open(approved, "w") as f:
            f.write("old\n")
        os.makedirs(os.path.join(tmp, "cli-tmp"))
        profile = os.path.join(tmp, "p.sb")
        with open(profile, "w") as f:
            f.write(code_edit.cli_profile([approved], os.path.join(tmp, "cli-tmp"), home))
        r = subprocess.run(code_edit.wrap(profile, ["/usr/bin/python3", "-I", "-c", HOME_PROBE, home, approved]),
                           capture_output=True, text=True, timeout=30)
        out = json.loads(r.stdout)
        self.assertEqual([x for x in out if x[0].startswith("need")], [[n, "ok"] for n, _ in out[:5]])
        denied = [x for x in out if not x[0].startswith("need") and x[0] != "unlink approved"]
        self.assertEqual(denied, [[n, 1] for n, _ in denied])  # どれもカーネルの拒否（EPERM）
        self.assertTrue(os.path.isdir(os.path.join(home, ".claude", "projects", "user-repo", "memory")))
        self.assertFalse(os.path.exists(os.path.join(home, ".claude", "settings.json")))
        self.assertEqual(sorted(n for n in os.listdir(home) if n.startswith(".claude")),
                         [".claude", ".claude.json", ".claude.json.backup"])


class PostRunGuards(unittest.TestCase):
    """B の単体: 1回の読み取り・FIFO で止まらない・封印・残りのプロセスの停止・~/.claude.json の指紋。"""

    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.work = os.path.join(self.tmp, "work")
        os.makedirs(os.path.join(self.work, "pkg"))
        for name, text in (("a.py", "x = 1\n"), ("b.py", "y = 2\n")):
            with open(os.path.join(self.work, "pkg", name), "w") as f:
                f.write(text)
        with open(os.path.join(self.tmp, "outside.txt"), "w") as f:
            f.write("OUTSIDE SECRET\n")
        __import__("g10runner.stub", fromlist=["x"])._readonly_tree(self.work)
        self.run_dir = os.path.join(self.tmp, "run")
        os.makedirs(self.run_dir)
        self.home = os.path.join(self.tmp, "home")
        os.makedirs(self.home)
        self.spec = {"paths": ["pkg/a.py"], "max_lines": 4, "test_id": "t", "test": {}}
        code_edit.prepare(self.work, self.run_dir, self.spec, self.home)
        self.a = os.path.join(self.work, "pkg", "a.py")

    def finish(self):
        # 試験のプロセスはグループの先頭ではない（止める処理は先頭でなければ何もしない）。停止そのものは別の試験で確かめる
        with mock.patch.object(code_edit, "stop_leftovers", return_value={"stopped": True, "killed": []}):
            return code_edit.finish_cli(self.work, self.run_dir, self.home)

    def test_not_the_group_leader_stops_nothing(self):
        if os.getpgid(0) == os.getpid():
            self.skipTest("the test process leads its own group")
        self.assertEqual(code_edit.stop_leftovers(), {"stopped": False, "killed": [],
                                                       "error": "not the process group leader"})

    def test_normal_finish_seals_and_verifies(self):
        with open(self.a, "w") as f:
            f.write("x = 2\n")
        with open(os.path.join(self.run_dir, "home_guard_pre.json"), "w") as f:
            json.dump(code_edit.home_guard(self.home, self.work), f)
        rec = self.finish()
        self.assertEqual((rec["stopped"], rec["sealed"]), (True, True))
        self.assertEqual(os.stat(os.path.join(self.work, "pkg")).st_mode & 0o777, 0o550)
        with self.assertRaises(PermissionError):  # 封印のあとは所有者でも作れない
            open(os.path.join(self.work, "pkg", "new.py"), "w")
        check = code_edit.verify(self.work, self.run_dir, self.spec)
        self.assertEqual((check["violations"], check["changed_lines"]), ([], 2))

    def test_missing_postrun_record_or_unsealed_folder_is_a_violation(self):
        check = code_edit.verify(self.work, self.run_dir, self.spec)  # finish_cli を通っていない
        self.assertTrue(any("not confirmed stopped" in v for v in check["violations"]))
        self.assertTrue(any("changed outside the allowed paths: pkg" in v for v in check["violations"]))

    def test_symlink_or_fifo_at_the_approved_name_never_leaks_or_hangs(self):
        with open(os.path.join(self.run_dir, "home_guard_pre.json"), "w") as f:
            json.dump(code_edit.home_guard(self.home, self.work), f)
        self.finish()
        pkg = os.path.join(self.work, "pkg")
        for kind in ("symlink", "fifo"):
            with self.subTest(kind=kind):
                os.chmod(pkg, 0o750)  # 封印より前に差し替えられた場合を想定（サンドボックスの外から作る）
                os.unlink(self.a)
                if kind == "symlink":
                    os.symlink(os.path.join(self.tmp, "outside.txt"), self.a)
                else:
                    os.mkfifo(self.a)
                os.chmod(pkg, 0o550)
                result = {}
                th = threading.Thread(target=lambda: result.update(code_edit.verify(self.work, self.run_dir, self.spec)),
                                      daemon=True)
                th.start()
                th.join(10)
                self.assertFalse(th.is_alive(), "verify blocked on a FIFO")
                self.assertTrue(any("allowed path changed type" in v for v in result["violations"]), result)
                self.assertNotIn("OUTSIDE SECRET", result["diff"])
                os.chmod(pkg, 0o750)
                os.unlink(self.a)
                with open(self.a, "w") as f:
                    f.write("x = 1\n")
                os.chmod(self.a, 0o644)
                os.chmod(pkg, 0o550)

    def test_leftover_process_group_members_are_killed_and_confirmed(self):
        # スタブと同じく、セッションの先頭の子プロセスで確かめる
        code = ("import json, os, subprocess, sys, time\n"
                "sys.path.insert(0, %r)\n"
                "from g10runner import code_edit\n"
                "kid = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
                "rec = code_edit.stop_leftovers(seconds=2)\n"
                "alive = kid.poll() is None\n"
                "kid.kill() if alive else None\n"
                "kid.wait()\n"
                "print(json.dumps(dict(rec, kid=kid.pid, rc=kid.returncode, alive=alive)))"
                % os.path.dirname(os.path.dirname(os.path.abspath(code_edit.__file__))))
        r = subprocess.run([__import__("sys").executable, "-I", "-c", code], capture_output=True, text=True,
                           timeout=30, start_new_session=True)
        rec = json.loads(r.stdout)
        self.assertEqual((rec["stopped"], rec["killed"], rec["alive"], rec["rc"]),
                         (True, [rec["kid"]], False, -signal.SIGKILL))

    def test_reading_a_file_swapped_for_a_fifo_does_not_block(self):
        """lstat の後に FIFO へ差し替えられた場合（静止した FIFO は lstat の段階で除かれる）。"""
        fifo = os.path.join(self.tmp, "fifo")
        os.mkfifo(fifo)
        st = os.lstat(os.path.join(self.work, "pkg", "b.py"))  # 差し替え前に見た普通のファイル
        result = {}
        th = threading.Thread(target=lambda: result.update(data=code_edit._read_regular(fifo, st)), daemon=True)
        th.start()
        th.join(5)
        self.assertFalse(th.is_alive(), "reading blocked on a FIFO")
        self.assertIsNone(result["data"])

    def test_home_guard_watches_only_settings_that_affect_later_sessions(self):
        path = os.path.join(self.home, ".claude.json")
        self.assertEqual(code_edit.home_guard(self.home, self.work), {"state": "missing"})
        doc = {"numStartups": 1, "mcpServers": {}, "projects": {"/repo": {"allowedTools": [], "lastCost": 1},
                                                                 self.work: {"allowedTools": []}}}
        with open(path, "w") as f:
            json.dump(doc, f)
        base = code_edit.home_guard(self.home, self.work)
        for change, same in ((lambda d: d.update(numStartups=9), True),
                             (lambda d: d["projects"]["/repo"].update(lastCost=5), True),
                             (lambda d: d["projects"][self.work].update(allowedTools=["Bash"]), True),
                             (lambda d: d["projects"].update({self.work + "/sub": {"mcpServers": {"x": 1}}}), True),
                             (lambda d: d["mcpServers"].update(evil={"command": "sh"}), False),
                             (lambda d: d["projects"]["/repo"].update(allowedTools=["Bash(*)"]), False),
                             (lambda d: d["projects"].update({"/other": {"hasTrustDialogAccepted": True}}), False)):
            d = json.loads(json.dumps(doc))
            change(d)
            with open(path, "w") as f:
                json.dump(d, f)
            self.assertEqual(code_edit.home_guard(self.home, self.work) == base, same, d)
        with open(os.path.join(self.run_dir, "home_guard_pre.json"), "w") as f:
            json.dump(base, f)
        self.finish()  # 最後に書いたのは /other の信頼の追加 → 違反
        check = code_edit.verify(self.work, self.run_dir, self.spec)
        self.assertTrue(any("~/.claude.json settings" in v for v in check["violations"]), check["violations"])


class LeftoverProcessE2E(CodeEditBase):
    """代役の CLI が、終了後も許可ファイルを書き換え続ける子孫を残す。"""

    def swapper_pid(self, root, run_id):
        rec = self.record(root, run_id)["record"]
        return int([r for n, r in rec if n.startswith("swapper")][0].split(":")[1])

    def test_leftover_in_the_same_group_is_stopped_before_the_check(self):
        self.scenario([FIX, ["swapper", "trial/calc.py", "pgid", ["def add(a, b):\n    return a + b\n"]]])
        fr, root = self.code_root()
        code, d = self.once(root)
        self.assertEqual((d["decision"], d["status"]), ("launched", "ended_checks_passed"), self.explain(root, d))
        pid = self.swapper_pid(root, d["run_id"])
        post = json.load(open(os.path.join(self.run_dir(root, d["run_id"]), "edit_postrun.json")))
        self.assertEqual((post["stopped"], post["sealed"]), (True, True))
        self.assertIn(pid, post["killed"])
        with self.assertRaises(ProcessLookupError):
            os.kill(pid, 0)

    def test_escaped_leftover_cannot_make_a_run_pass(self):
        texts = ["def add(a, b):\n    return a + b\n", "def add(a, b):\n    return a * b\n"]
        self.scenario([FIX, ["swapper", "trial/calc.py", "setsid", texts]])
        fr, root = self.code_root()
        code, d = self.once(root)
        pid = self.swapper_pid(root, d["run_id"])
        try:
            os.kill(pid, signal.SIGKILL)  # グループの外へ逃げた子孫（試験の後始末）
        except ProcessLookupError:
            pass
        self.assertEqual(d["decision"], "launched")
        self.assertNotEqual(d["status"], "ended_checks_passed", self.explain(root, d))
        self.assertEqual(os.stat(os.path.join(Layout(root).root, "work", d["run_id"], "trial")).st_mode & 0o777, 0o550)


if __name__ == "__main__":
    unittest.main()
