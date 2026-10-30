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
real = os.path.realpath(sys.argv[1]); cli = os.path.realpath(sys.argv[2]); A = sys.argv[3]
C = real + "/.claude"
out = []
def t(name, fn):
    try:
        fn(); out.append([name, "ok"])
    except OSError as e:
        out.append([name, e.errno])
def w(p, text="x"):
    with open(p, "w") as f:
        f.write(text)
# 使い捨ての HOME（CLI の設定・projects・キャッシュの置き場）には書ける
t("cli_home .claude.json", lambda: w(cli + "/.claude.json"))
t("cli_home .claude project", lambda: (os.makedirs(cli + "/.claude/projects/x"), w(cli + "/.claude/projects/x/s.jsonl")))
t("cli_home .config.json", lambda: w(cli + "/.config.json"))
t("cli_home cache", lambda: (os.makedirs(cli + "/Library/Caches/claude-cli-nodejs"), w(cli + "/Library/Caches/claude-cli-nodejs/c")))
# 本物の ~/.claude は、直接も・.config.json も・改名も、一切書けない（H2 を原因ごと解消）
t("real settings.json", lambda: w(C + "/settings.json"))
t("real .config.json", lambda: w(C + "/.config.json"))
t("real .claude.json", lambda: w(real + "/.claude.json"))
t("real new file", lambda: w(C + "/anything"))
t("real mkdir .claudeX", lambda: os.makedirs(real + "/.claudeX"))
t("real rename .claude", lambda: os.rename(C, real + "/.claude-old"))
t("real write existing memory", lambda: w(C + "/projects/user-repo/memory/m.md"))
t("real new project", lambda: os.makedirs(C + "/projects/-run-1"))
# 許可ファイルの名前の位置の種類すり替え（普通のファイル以外は作らせない）
t("symlink at approved temp", lambda: os.symlink("/etc/hosts", A + ".tmp.1.0123456789ab"))
t("fifo at approved temp", lambda: os.mkfifo(A + ".tmp.1.0123456789ab"))
t("symlink at approved file", lambda: (os.unlink(A), os.symlink("/etc/hosts", A)))
t("fifo at approved file", lambda: os.mkfifo(A))
print(json.dumps(out))
'''


class HomeAndApprovedNameRules(unittest.TestCase):
    """H2: 本物の ~/.claude は全拒否・使い捨ての HOME は書ける。許可ファイルの名前の種類の拒否も（設定そのもの）。"""

    def test_real_home_fully_denied_disposable_home_writable(self):
        tmp = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        home = os.path.join(tmp, "home")  # 本物の HOME（書けてはいけない）
        for d in (".claude/projects/user-repo/memory", ".claude/projects/empty-proj", ".claude/hooks"):
            os.makedirs(os.path.join(home, d))
        with open(os.path.join(home, ".claude/projects/user-repo/memory/m.md"), "w") as f:
            f.write("m\n")
        cli_home = os.path.join(tmp, "cli-home")  # 使い捨ての HOME（CLI が書く先）
        os.makedirs(cli_home)
        os.makedirs(os.path.join(tmp, "w"))
        approved = os.path.join(tmp, "w", "a.py")
        with open(approved, "w") as f:
            f.write("old\n")
        os.makedirs(os.path.join(tmp, "cli-tmp"))
        profile = os.path.join(tmp, "p.sb")
        with open(profile, "w") as f:
            f.write(code_edit.cli_profile([approved], os.path.join(tmp, "cli-tmp"), cli_home, home))
        r = subprocess.run(code_edit.wrap(profile, ["/usr/bin/python3", "-I", "-c", HOME_PROBE, home, cli_home, approved]),
                           capture_output=True, text=True, timeout=30)
        out = json.loads(r.stdout)
        d = dict(out)
        for n in ("cli_home .claude.json", "cli_home .claude project", "cli_home .config.json", "cli_home cache"):
            self.assertEqual(d[n], "ok", n)  # 使い捨ての HOME は書ける
        for name, result in out:
            if name.startswith("cli_home"):
                continue
            self.assertEqual(result, 1, name)  # 本物の HOME と種類すり替えは、どれもカーネルの拒否（EPERM）
        self.assertTrue(os.path.isdir(os.path.join(home, ".claude", "projects", "user-repo", "memory")))
        self.assertFalse(os.path.exists(os.path.join(home, ".claude", "settings.json")))
        self.assertFalse(os.path.exists(os.path.join(home, ".claude", ".config.json")))
        self.assertEqual([n for n in os.listdir(home) if n != ".claude"], [])  # 本物の HOME に何も作られていない


    def test_setsid_descendant_still_cannot_write_real_home(self):
        """H1 の核心: プロセスグループの外へ逃げた（setsid）子孫も、カーネルのサンドボックスは外れないので、本物の
        ~/.claude には書けない。停止処理をすり抜けても、本物の設定を書き換える道はない。"""
        tmp = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, tmp, True)
        home = os.path.join(tmp, "home")
        os.makedirs(os.path.join(home, ".claude"))
        cli_home = os.path.join(tmp, "cli-home")
        os.makedirs(cli_home)
        os.makedirs(os.path.join(tmp, "w"))
        approved = os.path.join(tmp, "w", "a.py")
        with open(approved, "w") as f:
            f.write("old\n")
        os.makedirs(os.path.join(tmp, "cli-tmp"))
        profile = os.path.join(tmp, "p.sb")
        with open(profile, "w") as f:
            f.write(code_edit.cli_profile([approved], os.path.join(tmp, "cli-tmp"), cli_home, home))
        result = os.path.join(cli_home, "result.json")  # 子は結果をここ（使い捨て HOME = 書ける）に残す
        probe = ("import os, sys, json\n"
                 "real, out = sys.argv[1], sys.argv[2]\n"
                 "pid = os.fork()\n"
                 "if pid == 0:\n"
                 "    os.setsid()\n"  # グループの外へ逃げる
                 "    rec = []\n"
                 "    for target in (real + '/.claude/evil.json', real + '/.claude/.config.json'):\n"
                 "        try:\n"
                 "            open(target, 'w').write('x'); rec.append([target, 'WROTE'])\n"
                 "        except OSError as e:\n"
                 "            rec.append([target, e.errno])\n"
                 "    json.dump(rec, open(out, 'w'))\n"
                 "    os._exit(0)\n"
                 "os.waitpid(pid, 0)\n")
        r = subprocess.run(code_edit.wrap(profile, ["/usr/bin/python3", "-I", "-c", probe, home, result]),
                           capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        rec = json.load(open(result))
        for target, outcome in rec:
            self.assertEqual(outcome, 1, (target, outcome))  # 2 件とも EPERM（カーネルの拒否）
        self.assertFalse(os.path.exists(os.path.join(home, ".claude", "evil.json")))
        self.assertFalse(os.path.exists(os.path.join(home, ".claude", ".config.json")))


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
