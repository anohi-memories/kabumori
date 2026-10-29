"""TASK 28: 実 Claude の Edit の一時ファイル（第27TASKの実機で EPERM）と、常駐のポリシーの読み直し。

- 代役の CLI の Edit は実 CLI（2.1.305）と同じ書き方（同じフォルダの `<許可ファイル>.tmp.<pid>.<16進12文字>` を作って
  rename）。許可は、その名前の形の普通のファイルだけ。リンク・フォルダ・FIFO・別の名前・他のファイルへの rename は
  カーネルが拒否し、一時ファイルが残れば実行後の照合で HALT。
- 常駐（検知役・S2）は周期ごとにポリシーを読み直す。正本と公開用が一致して有効なときだけ切り替え、読めない・食い違う・
  ランの途中・判定のあとの置き換えでは起動しない。本文のポリシーのハッシュが合わなければ起動しない。
実 Claude・launchd・ネットワークは使わない。
"""
import json
import os
import subprocess
import tempfile
import unittest
from unittest import mock

from g10runner import autorun, code_edit, policy as policy_mod, registry, supervise
from g10runner.control import Control
from g10runner.layout import Layout
from test_task26_code_edit import FIX, CodeEditBase


def temp_files(root):
    found = []
    for dirpath, dirnames, filenames in os.walk(root):
        found += [n for n in dirnames + filenames if ".tmp." in n]
    return found


class TempFileE2E(CodeEditBase):

    def test_atomic_edit_like_the_real_cli_passes_and_leaves_nothing(self):
        self.scenario([FIX])
        fr, root = self.code_root()
        code, d = self.once(root)
        self.assertEqual((d["decision"], d["status"]), ("launched", "ended_checks_passed"), self.explain(root, d))
        self.assertEqual(self.record(root, d["run_id"])["record"], [["edit trial/calc.py", "ok"]])
        work = os.path.join(Layout(root).root, "work", d["run_id"])
        self.assertEqual(temp_files(work), [])
        self.assertIn("+    return a + b", self.report(root, d["run_id"]))
        self.assertFalse(self.halted(root))

    def test_temp_file_tricks_are_denied_by_the_kernel(self):
        calc = "trial/calc.py"
        self.scenario([
            ["temp_kind", calc, "symlink"], ["temp_kind", calc, "dir"], ["temp_kind", calc, "fifo"],
            ["temp_kind", calc, "hardlink", self.outside],
            ["temp_over", calc, "trial/other.py"], ["temp_over", calc, "trial/test_calc.py"],
            ["leave_temp", "trial/other.py"],  # 許可していないファイルの一時ファイルの名前
            ["temp_name_variant", calc, ".tmp.1.zz"], ["temp_name_variant", calc, ".tmp.1.0123456789abX"],
            ["temp_name_variant", calc, ".tmp.x.0123456789ab"],
            ["write", "trial/new.py"],
            FIX])
        fr, root = self.code_root()
        code, d = self.once(root)
        self.assertEqual((d["decision"], d["status"]), ("launched", "ended_checks_passed"), self.explain(root, d))
        rec = self.record(root, d["run_id"])["record"]
        self.assertEqual(rec[-1], ["edit trial/calc.py", "ok"])
        for name, result in rec[:-1]:
            self.assertEqual(result, "denied:1", name)  # どれもカーネルの拒否（EPERM）
        with open(self.outside) as f:
            self.assertEqual(f.read(), "ORIGINAL\n")
        self.assertEqual(temp_files(os.path.join(Layout(root).root, "work", d["run_id"])), [])

    def test_leftover_temp_file_halts(self):
        self.scenario([FIX, ["leave_temp", "trial/calc.py"]])
        fr, root = self.code_root()
        code, d = self.once(root)
        self.assertEqual(self.record(root, d["run_id"])["record"][1], ["leave_temp trial/calc.py", "ok"])
        self.assertNotEqual(d["status"], "ended_checks_passed")
        end = self.end_checks(root, d["run_id"])
        self.assertIs(end["checks"]["edit_within_bounds"], False)
        self.assertTrue(any("created outside the approval: trial/calc.py.tmp." in v for v in end["safety_violations"]),
                        end["safety_violations"])
        self.assertTrue(self.halted(root))


class PolicyReload(CodeEditBase):

    def opened_before_the_policy_write(self, approve=True):
        """常駐が policy-v1 を読み込んだあとで policy-v2 を書き、本文と承認を置いた状態。"""
        seen = {}
        fr, root = self.code_root(approve=approve,
                                  before_policy=lambda r: seen.update(zip(("control", "policy"), autorun.open_control(r))))
        self.assertEqual(seen["policy"]["version"], "policy-v1")
        return root, seen["control"], seen["policy"]

    def step(self, root, control, policy):
        return autorun.step(root, control, policy, True, out=lambda *_: None)

    def no_claim(self, root):
        self.assertEqual(autorun.claimed_approvals(autorun.open_control(root)[0]), set())

    def test_resident_reloads_the_new_policy_and_launches_once(self):
        self.scenario([FIX])
        root, control, policy = self.opened_before_the_policy_write()
        control, policy, entries = self.step(root, control, policy)
        self.assertEqual([e["decision"] for e in entries], ["policy_reloaded", "launched"], entries)
        self.assertEqual(entries[0]["policy_to"], policy["_digest"])
        self.assertEqual(policy["version"], "policy-v2")
        self.assertEqual(entries[1]["status"], "ended_checks_passed", self.explain(root, entries[1]))
        snap = autorun.fetch(control, policy)  # 同じ本文での二度目の CLAIM は拒否される
        run_id, reason = control.try_claim(snap["body"], {"state": snap["state"], "number": snap["number"],
                                                          "author": snap["author"], "editor": None}, 0)
        self.assertIsNone(run_id)
        control, policy, entries = self.step(root, control, policy)
        self.assertEqual([(e["decision"], e["reason"]) for e in entries], [("idle", "approval already used")])

    def test_inconsistent_policy_copies_do_not_launch(self):
        self.scenario([FIX])
        root, control, policy = self.opened_before_the_policy_write()
        layout = Layout(root)
        original = policy_mod.load_current(layout)
        with open(layout.policy_priv) as f:
            pub = json.load(f)
        pub["version"] = "policy-v9"
        with open(layout.policy_pub, "w") as f:  # 書き換えの途中（公開用だけ別の版）
            json.dump(pub, f)
        control, policy, entries = self.step(root, control, policy)
        self.assertEqual([(e["decision"], e["reason"], e.get("error")) for e in entries],
                         [("wait", "policy not usable", "policy copies differ (control and pub)")])
        self.assertEqual(policy["version"], "policy-v1")
        with open(layout.policy_priv, "w") as f:  # 壊れた正本
            f.write("{not json")
        entries = self.step(root, control, policy)[2]
        self.assertEqual((entries[0]["reason"], entries[0].get("error", "")[:28]), ("policy not usable",
                                                                            "policy unreadable or invalid"))
        Control.install_policy(layout, original)
        self.no_claim(root)

    def test_policy_change_during_a_run_is_not_picked_up(self):
        self.scenario([FIX])
        root, control, policy = self.opened_before_the_policy_write()
        with mock.patch.object(registry, "non_terminal", return_value=["run-x"]):
            control, policy, entries = self.step(root, control, policy)
        self.assertEqual((entries[0]["reason"], entries[0].get("error")),
                         ("policy not usable", "policy changed while a run is in progress"))
        self.assertEqual(policy["version"], "policy-v1")
        self.no_claim(root)

    def test_policy_replaced_after_the_decision_does_not_launch(self):
        self.scenario([FIX])
        fr, root = self.code_root()
        control, policy = autorun.open_control(root)

        def auth_then_replace(cli, home):  # 判定の最後（ログインの確認）のあとでポリシーが置き換わる
            other = {k: v for k, v in policy.items() if not k.startswith("_")}
            other["version"] = "policy-v3"
            Control.install_policy(Layout(root), other)
            return {"logged_in": True}

        entries = autorun.step(root, control, policy, True, auth_fn=auth_then_replace, out=lambda *_: None)[2]
        self.assertEqual([(e["decision"], e["reason"]) for e in entries], [("wait", "policy changed before launch")])
        self.no_claim(root)

    def test_reloaded_policy_must_match_the_approved_body(self):
        self.scenario([FIX])
        fr, root = self.code_root()
        control, policy = autorun.open_control(root)
        other = {k: v for k, v in policy.items() if not k.startswith("_")}
        other["version"] = "policy-v3"
        Control.install_policy(Layout(root), other)
        control, policy, entries = self.step(root, control, policy)
        self.assertEqual([e["decision"] for e in entries], ["policy_reloaded", "idle"])
        self.assertIn("bad value: phase2_policy_sha256", entries[1]["problems"])
        self.no_claim(root)

    def test_watchdog_reloads_only_a_consistent_policy_outside_a_run(self):
        root, control, policy = self.opened_before_the_policy_write(approve=False)
        layout = Layout(root)
        made, said = [], []
        make = lambda pol: made.append(pol["version"]) or "agent-" + pol["version"]  # noqa: E731
        with mock.patch.object(registry, "non_terminal", return_value=["run-x"]):
            self.assertEqual(supervise.reload_policy(layout, policy, "old", make, out=said.append), (policy, "old"))
        new_policy, agent = supervise.reload_policy(layout, policy, "old", make, out=said.append)
        self.assertEqual((new_policy["version"], agent, made), ("policy-v2", "agent-policy-v2", ["policy-v2"]))
        self.assertEqual(supervise.reload_policy(layout, new_policy, agent, make, out=said.append),
                         (new_policy, agent))
        with open(layout.policy_pub, "w") as f:
            f.write("{}")
        self.assertEqual(supervise.reload_policy(layout, new_policy, agent, make, out=said.append),
                         (new_policy, agent))
        self.assertEqual([json.loads(s)["watchdog"] for s in said],
                         ["policy changed while a run is in progress; keeping the loaded policy", "policy reloaded",
                          "policy not usable; keeping the loaded policy"])


class TempFileSandbox(unittest.TestCase):
    """cli_profile の一時ファイルの規則そのもの（Python の子プロセスで、実 CLI と同じ手順とすり抜けを試す）。"""

    PROBE = r'''
import json, os, sys
target, other, outside = sys.argv[1:4]
tmp = lambda: "%s.tmp.%d.%s" % (target, os.getpid(), os.urandom(6).hex())
out = []
def attempt(name, fn):
    try:
        fn(); out.append([name, "ok"])
    except OSError as e:
        out.append([name, e.errno])
def atomic():
    p = tmp()
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    os.write(fd, b"new\n"); os.fchmod(fd, 0o644); os.fsync(fd); os.close(fd)
    os.rename(p, target)
def create(p):
    os.close(os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644))
def over(dst):
    p = tmp(); create(p)
    try:
        os.rename(p, dst)
    finally:
        os.path.lexists(p) and os.unlink(p)
def created_then_removed():
    p = tmp(); create(p); os.unlink(p)
attempt("atomic", atomic)
attempt("temp create and unlink", created_then_removed)
def upper():
    create(target + ".tmp.1.0123456789AB"); os.unlink(target + ".tmp.1.0123456789AB")
attempt("upper hex", upper)
attempt("symlink", lambda: os.symlink(outside, tmp()))
attempt("dir", lambda: os.mkdir(tmp()))
attempt("fifo", lambda: os.mkfifo(tmp()))
attempt("hardlink outside", lambda: os.link(outside, tmp()))
attempt("hardlink other", lambda: os.link(other, tmp()))
attempt("rename temp over other", lambda: over(other))
attempt("rename other to temp", lambda: os.rename(other, tmp()))
attempt("other name", lambda: create(os.path.join(os.path.dirname(target), "evil.py")))
attempt("other file temp", lambda: create("%s.tmp.1.0123456789ab" % other))
attempt("suffix after hex", lambda: create(target + ".tmp.1.0123456789abX"))
attempt("short hex", lambda: create(target + ".tmp.1.0123456789a"))
attempt("no pid", lambda: create(target + ".tmp..0123456789ab"))
attempt("unlink other", lambda: os.unlink(other))
attempt("chmod dir", lambda: os.chmod(os.path.dirname(target), 0o777))
print(json.dumps(out))
'''

    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(__import__("shutil").rmtree, self.tmp, True)
        self.work = os.path.join(self.tmp, "work", "pkg")
        os.makedirs(self.work)
        os.makedirs(os.path.join(self.tmp, "cli-tmp"))
        self.target = os.path.join(self.work, "a.py")
        self.other = os.path.join(self.work, "b.py")
        self.outside = os.path.join(self.tmp, "outside.txt")
        for p in (self.target, self.other, self.outside):
            with open(p, "w") as f:
                f.write("old\n")
        os.chmod(self.work, 0o750)

    def run_probe(self, profile):
        path = os.path.join(self.tmp, "p.sb")
        with open(path, "w") as f:
            f.write(profile)
        r = subprocess.run(code_edit.wrap(path, ["/usr/bin/python3", "-I", "-c", self.PROBE, self.target, self.other,
                                                 self.outside]), capture_output=True, text=True, timeout=30)
        self.assertEqual(r.returncode, 0, r.stderr)
        return json.loads(r.stdout)

    def test_only_the_real_cli_temp_file_pattern_is_allowed(self):
        profile = code_edit.cli_profile([self.target], os.path.join(self.tmp, "cli-tmp"), os.path.join(self.tmp, "h"))
        self.assertNotIn("{", profile)  # sandbox の正規表現は {n} を黙って無視する（一致しなくなる）
        out = self.run_probe(profile)
        # 大文字の16進も通る（このディスクではカーネルのパスの照合が大文字・小文字を区別しない）。作れるのは普通の
        # ファイルだけで、残れば実行後の照合で HALT になる
        self.assertEqual(out[:3], [["atomic", "ok"], ["temp create and unlink", "ok"], ["upper hex", "ok"]])
        for name, result in out[3:]:
            self.assertEqual(result, 1, name)
        with open(self.target) as f:
            self.assertEqual(f.read(), "new\n")
        for p in (self.other, self.outside):
            with open(p) as f:
                self.assertEqual(f.read(), "old\n")
        self.assertEqual(sorted(os.listdir(self.work)), ["a.py", "b.py"])

    def test_prepare_opens_only_the_parent_folders_of_allowed_files(self):
        work = os.path.join(self.tmp, "clone")
        for d in ("pkg/sub", "pkg/other", "tests"):
            os.makedirs(os.path.join(work, d))
        for rel in ("pkg/sub/a.py", "pkg/other/c.py", "tests/t.py"):
            with open(os.path.join(work, rel), "w") as f:
                f.write("x\n")
        __import__("g10runner.stub", fromlist=["x"])._readonly_tree(work)
        run_dir = os.path.join(self.tmp, "run")
        os.makedirs(run_dir)
        spec = {"paths": ["pkg/sub/a.py", "tests/t.py"], "max_lines": 4, "test_id": "t", "test": {}}
        code_edit.prepare(work, run_dir, spec, os.path.join(self.tmp, "h"))
        mode = lambda rel: os.stat(os.path.join(work, rel)).st_mode & 0o777  # noqa: E731
        self.assertEqual([mode(r) for r in ("pkg/sub", "tests", "pkg", "pkg/other", ".")],
                         [0o750, 0o750, 0o550, 0o550, 0o550])
        self.assertEqual((mode("pkg/sub/a.py"), mode("pkg/other/c.py")), (0o644, 0o440))
        pre = json.load(open(os.path.join(run_dir, "edit_manifest_pre.json")))
        self.assertEqual(pre["pkg/sub"][1], 0o750)  # 実行前の一覧は書き込み可にしたあとの状態


if __name__ == "__main__":
    unittest.main()
