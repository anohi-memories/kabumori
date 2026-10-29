"""TASK 26: 限定コード編集→テスト→ローカル REPORT の一回限りの実行モード。実 Claude・launchd・ネットワークは使わない。

代役の CLI（sandbox-exec の中で動く）が、許可ファイルの Edit と、許可外への書き込み・新規・削除・リンク・子プロセスの
書き込み・CLI の設定への書き込みを試みる。カーネルの拒否・実行後の照合（はみ出しは HALT）・実行係のテスト・
二重起動なし・署名（GO）なし・停止中・テスト失敗・費用超過を確かめる。
"""
import json
import os
import socket
import subprocess
import tempfile
import unittest
from unittest import mock

from g10runner import code_edit, issue as issue_mod, meta, policy as policy_mod, state
from g10runner.adapter import FakeClaudeAdapter
from g10runner.control import Control
from g10runner.layout import Layout
from helpers import make_body
from test_task17_real_adapter import git
from test_task24_blockers import BlockersBase

CFG = {"allowed_path_prefixes": ["trial/"], "max_files": 2, "max_changed_lines": 6,
       "tests": {"trial-unittest": {"argv": ["/usr/bin/python3", "-I", "-B", "-m", "unittest", "discover", "-s", "trial"],
                                    "timeout_seconds": 60}}}
CALC = "def add(a, b):\n    return a - b\n"
TEST_CALC = ("import unittest\nfrom calc import add\n\n\nclass T(unittest.TestCase):\n"
             "    def test_add(self):\n        self.assertEqual(add(2, 3), 5)\n")
FIX = ["edit", "trial/calc.py", "return a - b", "return a + b"]

CODE_STAND_IN = r'''#!/usr/bin/python3 -I
"""代役の CLI（限定コード編集の試験専用）。実 Claude ではない。scenario.json の操作を試み、結果を TMPDIR に記録する。"""
import json, os, subprocess, sys
argv = sys.argv[1:]
here = os.path.dirname(os.path.abspath(__file__))
if argv[:2] == ["auth", "status"]:
    print(json.dumps({"loggedIn": True, "authMethod": "claude.ai", "apiProvider": "firstParty", "subscriptionType": "max"}))
    sys.exit(0)
prompt = sys.stdin.read()
def opt(name):
    return argv[argv.index(name) + 1] if name in argv else None
allowed = [r[len("Edit(/"):-1] for r in opt("--allowedTools").split(",") if r.startswith("Edit(")]
sc = json.load(open(os.path.join(here, "scenario.json")))
record = []
def attempt(name, fn):
    try:
        fn()
        record.append([name, "ok"])
    except OSError as e:
        record.append([name, "denied:%d" % e.errno])
def temp_name(path, pid=None):
    return "%s.tmp.%d.%s" % (path, os.getpid() if pid is None else pid, os.urandom(6).hex())
def edit(path, old, new):
    # TASK 28: 実 CLI（2.1.305）の Edit と同じ書き方。同じフォルダの一時ファイルを O_CREAT|O_EXCL|O_NOFOLLOW で作り、
    # 書いて権限を合わせ fsync し、許可ファイルへ rename する（失敗したら一時ファイルを消す）
    text = open(path, encoding="utf-8").read()
    tmp = temp_name(path)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o644)
    try:
        os.write(fd, text.replace(old, new).encode("utf-8"))
        os.fchmod(fd, os.stat(path).st_mode & 0o7777)
        os.fsync(fd)
    finally:
        os.close(fd)
    try:
        os.rename(tmp, path)
    except OSError:
        os.unlink(tmp)
        raise
def make_file(path):
    os.close(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644))
def rename_new_over(src, dst):
    make_file(src)
    try:
        os.rename(src, dst)
    finally:
        if os.path.lexists(src):
            os.unlink(src)
for act in sc.get("actions", []):
    kind, target = act[0], act[1]
    if kind == "edit":  # CLI の Edit の道具: 許可の規則にあるファイルだけ
        path = os.path.abspath(target)
        if path not in allowed:
            record.append(["edit " + target, "refused by permission rules"])
        else:
            attempt("edit " + target, lambda: edit(path, act[2], act[3]))
    elif kind == "write":
        attempt("write " + target, lambda: open(target, "a").write("x\n"))
    elif kind == "delete":
        attempt("delete " + target, lambda: os.remove(target))
    elif kind == "symlink":
        attempt("symlink " + target, lambda: os.symlink("/etc/hosts", target))
    elif kind == "leave_temp":  # 一時ファイルを作ったまま残す（rename しない）
        attempt("leave_temp " + target, lambda: make_file(temp_name(os.path.abspath(target))))
    elif kind == "temp_kind":  # 一時ファイルの名前で、普通のファイル以外を作る
        p = temp_name(os.path.abspath(target))
        attempt("temp_kind %s %s" % (act[2], target), {"symlink": lambda: os.symlink("/etc/hosts", p),
                                                        "dir": lambda: os.mkdir(p), "fifo": lambda: os.mkfifo(p),
                                                        "hardlink": lambda: os.link(act[3], p)}[act[2]])
    elif kind == "temp_over":  # 許可ファイルの一時ファイルの名前で作り、別のファイル（act[2]）へ rename する
        attempt("temp_over %s %s" % (target, act[2]),
                lambda: rename_new_over(temp_name(os.path.abspath(target)), os.path.abspath(act[2])))
    elif kind == "temp_name_variant":  # 名前の形の違う一時ファイル（act[2] を後ろに付ける）
        attempt("temp_name_variant " + act[2], lambda: make_file(os.path.abspath(target) + act[2]))
    elif kind == "child_write":
        rc = subprocess.call(["/usr/bin/python3", "-I", "-c", "open(%r, 'a').write('x')" % target],
                             stderr=subprocess.DEVNULL)
        record.append(["child_write " + target, "ok" if rc == 0 else "denied"])
with open(os.path.join(os.environ["TMPDIR"], "standin_record.json"), "w") as f:
    json.dump({"record": record, "cwd": os.getcwd(), "env_keys": sorted(os.environ), "allowed": allowed}, f)
model = opt("--model")
print(json.dumps({"type": "result", "subtype": "success", "is_error": False,
                  "result": "代役の CLI の結果\npending_questions: なし", "session_id": opt("--session-id"),
                  "modelUsage": {model: {"inputTokens": 1, "outputTokens": 1, "costUSD": 0.0}},
                  "total_cost_usd": sc.get("cost", 0.01), "terminal_reason": "completed"}))
'''


def code_body(policy, base_sha, paths="trial/calc.py", max_lines="4", test_id="trial-unittest", extra=""):
    keys = "- phase2_edit_paths: %s\n- phase2_edit_max_lines: %s\n- phase2_test_id: %s\n%s" % (
        paths, max_lines, test_id, extra)
    return make_body(policy, mutate=lambda b: b.replace("0c42933ca5030ab31a56267529430d0473d9b155", base_sha)
                     .replace("- phase2_scope: readonly_trial\n", "- phase2_scope: limited_code_edit\n" + keys))


class CodeEditBase(BlockersBase):

    def setUp(self):
        super().setUp()
        with open(self.cli, "w") as f:
            f.write(CODE_STAND_IN)
        os.makedirs(os.path.join(self.repo, "trial"))
        for name, text in (("calc.py", CALC), ("test_calc.py", TEST_CALC), ("other.py", "X = 1\n")):
            with open(os.path.join(self.repo, "trial", name), "w") as f:
                f.write(text)
        git(["add", "trial"], self.repo)
        git(["commit", "-q", "-m", "trial"], self.repo)
        self.base_sha = subprocess.run(["/usr/bin/git", "rev-parse", "HEAD"], cwd=self.repo, capture_output=True,
                                       text=True, check=True).stdout.strip()
        # 「他の slot の worktree」に見立てた、作業フォルダの外のファイル
        self.outside = os.path.join(self.env.real, "other-slot-worktree", "app.py")
        os.makedirs(os.path.dirname(self.outside))
        with open(self.outside, "w") as f:
            f.write("ORIGINAL\n")
        for d in (".claude/projects/p/memory", ".claude/hooks"):
            os.makedirs(os.path.join(self.home, d), exist_ok=True)

    def scenario(self, actions, **extra):
        with open(os.path.join(self.cli_dir, "scenario.json"), "w") as f:
            json.dump(dict(extra, actions=actions), f)

    def code_root(self, approve=True, body_kw=None, before_policy=None):
        fr = __import__("test_task17_real_adapter").load_first_run()
        root = os.path.join(self.env.real, "code-root")
        self.addCleanup(__import__("shutil").rmtree, root, True)
        self.assertEqual(self.quiet(fr.main, ["init", "--root", root, "--issue-source", "file"])[0], 0)
        if before_policy is not None:  # TASK 28: 常駐が古いポリシーを読み込んだ状態を作る
            before_policy(root)
        cfg_path = os.path.join(self.env.real, "code_edit.json")
        with open(cfg_path, "w") as f:
            json.dump(CFG, f)
        code, out = self.quiet(fr.main, ["code-edit-policy", "--root", root, "--config", cfg_path, "--write"])
        self.assertEqual(code, 0)
        self.assertTrue(json.loads(out)["written"])
        policy = policy_mod.load(Layout(root).policy_pub)
        self.assertEqual(policy["version"], "policy-v2")
        body = code_body(policy, self.base_sha, **(body_kw or {}))
        issue_mod.FileIssueSource(issue_mod.mock_issue_path(root)).publish(body)
        if approve:
            self.assertEqual(self.quiet(fr.main, ["approve", "--root", root, "--cli", self.cli,
                                                  "--source-repo", self.repo])[0], 0)
        __import__("g10runner.supervise", fromlist=["x"]).write_s2_heartbeat(Layout(root))
        return fr, root

    def run_dir(self, root, run_id):
        return Layout(root).run_dir(run_id)

    def record(self, root, run_id):
        with open(os.path.join(self.run_dir(root, run_id), "cli-tmp", "standin_record.json")) as f:
            return json.load(f)

    def report(self, root, run_id):
        with open(os.path.join(Layout(root).reports, run_id + ".md"), encoding="utf-8") as f:
            return f.read()

    def end_checks(self, root, run_id):
        control = __import__("g10runner.autorun", fromlist=["x"]).open_control(root)[0]
        ends = [r["payload"] for r in control.ledger.read_all() if r["type"] == "END"
                and r["payload"]["run_id"] == run_id]
        self.assertEqual(len(ends), 1)
        return ends[0]

    def explain(self, root, d):
        """失敗時の説明（END の確認・違反と、テストの出力の末尾）。"""
        if "run_id" not in d:
            return d
        end = self.end_checks(root, d["run_id"])
        test = os.path.join(self.run_dir(root, d["run_id"]), "test_result.json")
        tail = json.load(open(test)).get("output_tail", "")[-800:] if os.path.exists(test) else "no test_result"
        return {"failed": [k for k, v in end["checks"].items() if not v], "violations": end["safety_violations"],
                "test": tail}

    def halted(self, root):
        control = __import__("g10runner.autorun", fromlist=["x"]).open_control(root)[0]
        return control.read_state().halted


class CodeEditE2E(CodeEditBase):

    def test_edit_test_report_once(self):
        self.scenario([FIX])
        fr, root = self.code_root()
        code, d = self.once(root)
        self.assertEqual((d["decision"], d["status"]), ("launched", "ended_checks_passed"), self.explain(root, d))
        run_id = d["run_id"]
        end = self.end_checks(root, run_id)
        for name in ("edit_within_bounds", "edit_present", "tests_passed", "cost_within_budget"):
            self.assertIs(end["checks"][name], True, name)
        self.assertNotIn("work_unchanged", end["checks"])
        rec = self.record(root, run_id)
        self.assertEqual(rec["record"], [["edit trial/calc.py", "ok"]])
        self.assertIn("TMPDIR", rec["env_keys"])
        test = json.load(open(os.path.join(self.run_dir(root, run_id), "test_result.json")))
        self.assertEqual((test["exit_code"], test["timed_out"], test["tree_unchanged"]), (0, False, True))
        text = self.report(root, run_id)
        self.assertIn("-    return a - b", text)
        self.assertIn("+    return a + b", text)
        self.assertIn("changed_files: trial/calc.py", text)
        self.assertIn("監督付きのラン", text)
        with open(os.path.join(self.repo, "trial", "calc.py")) as f:
            self.assertEqual(f.read(), CALC)  # 元のリポジトリには戻していない
        self.assertEqual(self.once(root)[1]["reason"], "approval already used")  # 二度目は起動しない
        self.assertFalse(self.halted(root))

    def test_kernel_denies_every_write_outside_the_allowed_file(self):
        work = "trial/"
        settings = os.path.join(self.home, ".claude", "settings.json")
        self.scenario([
            ["edit", "trial/other.py", "X = 1", "X = 2"],  # 許可の規則にない Edit（CLI が拒否）
            ["write", work + "other.py"], ["write", work + "new.py"], ["delete", work + "test_calc.py"],
            ["symlink", work + "link.py"], ["write", ".git/config"],
            ["write", self.outside], ["child_write", self.outside],
            ["write", settings], ["write", os.path.join(self.home, ".claude", "hooks", "h.sh")],
            ["write", os.path.join(self.home, ".claude", "projects", "p", "memory", "m.md")],
            FIX])  # GO の HOME は実行者の本物の HOME なので、ここでは試験用の HOME への書き込みを試す（設定の拒否の規則そのものは
        # SandboxProfiles で確かめる。本物の ~/.claude には書かない）
        fr, root = self.code_root()
        code, d = self.once(root)
        self.assertEqual((d["decision"], d["status"]), ("launched", "ended_checks_passed"), self.explain(root, d))
        rec = dict((name, result) for name, result in self.record(root, d["run_id"])["record"])
        self.assertEqual(rec.pop("edit trial/other.py"), "refused by permission rules")
        self.assertEqual(rec.pop("child_write " + self.outside), "denied")
        self.assertEqual(rec.pop("edit trial/calc.py"), "ok")
        for name, result in rec.items():  # 作業フォルダの外は EPERM（カーネルの拒否）。中は読み取り専用の EACCES もありうる
            inside = name.split(" ", 1)[1].startswith(("trial/", ".git/"))
            self.assertIn(result, ("denied:1", "denied:13") if inside else ("denied:1",), name)
        with open(self.outside) as f:
            self.assertEqual(f.read(), "ORIGINAL\n")
        self.assertFalse(os.path.exists(settings))


class CodeEditFailClosed(CodeEditBase):

    def test_change_outside_the_bounds_after_the_run_halts(self):
        """サンドボックスをすり抜けた変更を想定: 終了後・判定前に、承認の外のファイルが作業フォルダに増えていれば HALT。"""
        self.scenario([FIX])
        fr, root = self.code_root()
        real_finalize = Control.finalize

        def tamper_then_finalize(control, run_id, current_body=None):
            work = Layout(root).work_dir(run_id)
            os.chmod(os.path.join(work, "trial"), 0o755)
            with open(os.path.join(work, "trial", "sneaky.py"), "w") as f:
                f.write("pass\n")
            return real_finalize(control, run_id, current_body)
        with mock.patch.object(Control, "finalize", tamper_then_finalize):
            code, d = self.once(root)
        self.assertEqual(d["status"], "ended_checks_failed", d)
        end = self.end_checks(root, d["run_id"])
        self.assertIs(end["checks"]["edit_within_bounds"], False)
        self.assertTrue(any("created outside the approval: trial/sneaky.py" in v for v in end["safety_violations"]))
        self.assertTrue(self.halted(root))

    def test_too_many_changed_lines_halts(self):
        self.scenario([["edit", "trial/calc.py", "return a - b", "return a + b\n# 1\n# 2\n# 3\n# 4"]])
        fr, root = self.code_root()
        code, d = self.once(root)
        self.assertEqual(d["status"], "ended_checks_failed", d)
        end = self.end_checks(root, d["run_id"])
        self.assertTrue(any("exceed the approved 4" in v for v in end["safety_violations"]))
        self.assertFalse(os.path.exists(os.path.join(self.run_dir(root, d["run_id"]), "test_result.json")))
        self.assertTrue(self.halted(root))

    def test_failing_test_is_reported_not_passed(self):
        self.scenario([["edit", "trial/calc.py", "return a - b", "return a * b"]])
        fr, root = self.code_root()
        code, d = self.once(root)
        self.assertEqual(d["status"], "ended_checks_failed", d)
        end = self.end_checks(root, d["run_id"])
        self.assertIs(end["checks"]["edit_within_bounds"], True)
        self.assertIs(end["checks"]["tests_passed"], False)
        self.assertEqual(end["safety_violations"], [])
        self.assertIn("FAILED", self.report(root, d["run_id"]))

    def test_cost_over_the_approved_budget_fails(self):
        self.scenario([FIX], cost=0.75)
        fr, root = self.code_root()
        code, d = self.once(root)
        self.assertEqual(d["status"], "ended_checks_failed", d)
        self.assertIs(self.end_checks(root, d["run_id"])["checks"]["cost_within_budget"], False)

    def test_no_human_go_or_halt_means_no_launch(self):
        self.scenario([FIX])
        fr, root = self.code_root(approve=False)
        self.assertNotEqual(self.once(root)[1].get("decision"), "launched")
        self.assertEqual(self.quiet(fr.main, ["approve", "--root", root, "--cli", self.cli,
                                              "--source-repo", self.repo])[0], 0)
        self.quiet(fr.main, ["halt", "--root", root, "--reason", "test"])
        self.assertEqual(self.once(root)[1]["reason"], "halted")
        self.assertFalse(os.listdir(Layout(root).work))


class CodeEditValidation(unittest.TestCase):

    def setUp(self):
        self.policy = policy_mod.with_digest(dict(policy_mod.DEFAULT_POLICY, version="policy-v2", code_edit=CFG))

    def problems(self, policy=None, **kw):
        policy = policy or self.policy
        return meta.validate_task(code_body(policy, "a" * 40, **kw), policy).problems

    def test_valid_body(self):
        self.assertEqual(self.problems(), [])

    def test_bad_bodies_are_refused(self):
        cases = {"outside prefix": {"paths": "app/x.py"}, "dot dot": {"paths": "trial/../app/x.py"},
                 "hidden": {"paths": "trial/.git/config"}, "absolute": {"paths": "/etc/hosts"},
                 "glob": {"paths": "trial/*.py"}, "too many": {"paths": "trial/a.py,trial/b.py,trial/c.py"},
                 "duplicate": {"paths": "trial/a.py,trial/a.py"}, "lines over cap": {"max_lines": "7"},
                 "zero lines": {"max_lines": "0"}, "unknown test": {"test_id": "rm-rf"}}
        for name, kw in cases.items():
            with self.subTest(case=name):
                self.assertTrue(self.problems(**kw), name)

    def test_policy_without_code_edit_refuses_the_scope(self):
        plain = policy_mod.with_digest(dict(policy_mod.DEFAULT_POLICY))
        self.assertTrue(any("limited_code_edit is not enabled" in p for p in self.problems(policy=plain)))

    def test_code_edit_keys_need_the_scope_and_budget_cap_holds(self):
        body = make_body(self.policy, mutate=lambda b: b.replace(
            "- phase2_scope: readonly_trial\n", "- phase2_scope: readonly_trial\n- phase2_edit_paths: trial/calc.py\n"))
        self.assertIn("code edit keys are only allowed with phase2_scope: limited_code_edit",
                      meta.validate_task(body, self.policy).problems)
        over = code_body(self.policy, "a" * 40).replace("- max_budget_usd: 0.50", "- max_budget_usd: 0.51")
        self.assertIn("bad value: max_budget_usd", meta.validate_task(over, self.policy).problems)

    def test_envelope_never_covers_code_edits_and_fake_adapter_refuses(self):
        env = {"scopes": ["readonly_trial", "limited_code_edit"], "models": {"sonnet": "m"}, "efforts": ["medium"],
               "max_minutes_cap": 120, "max_budget_cap": 1, "base_ref_prefixes": ["refs/"], "policy_sha256": "p"}
        req = {"phase2_scope": "limited_code_edit", "model": "sonnet", "model_id": "m", "effort": "medium",
               "max_minutes": "10", "max_budget_usd": "0.10", "base_ref": "refs/heads/main", "policy_sha256": "p",
               "production_permission": "NO_GO", "report_mode": "local_only"}
        self.assertFalse(state.envelope_covers(env, req))
        self.assertTrue(state.envelope_covers(env, dict(req, phase2_scope="readonly_trial")))
        self.assertIsNotNone(FakeClaudeAdapter().prelaunch({}, "", "", [], edit={"abs_paths": []}))

    def test_policy_shape_is_checked(self):
        for bad in ({}, dict(CFG, max_files=0), dict(CFG, allowed_path_prefixes=["trial"]),
                    dict(CFG, tests={"x": {"argv": ["python3"], "timeout_seconds": 5}})):
            with self.subTest(cfg=bad):
                with self.assertRaises(policy_mod.PolicyError):
                    policy_mod.with_digest(dict(policy_mod.DEFAULT_POLICY, code_edit=bad))


class SandboxProfiles(unittest.TestCase):
    """sandbox-exec の設定そのものの強制（Python の子プロセスで確かめる。ネットワークは 127.0.0.1 だけ）。"""

    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(__import__("shutil").rmtree, self.tmp, True)
        self.home = os.path.join(self.tmp, "home")
        for d in ("work", "cli-tmp", "home/.claude/projects/p/memory", "home/.claude/hooks"):
            os.makedirs(os.path.join(self.tmp, d))
        self.allowed = os.path.join(self.tmp, "work", "ok.py")
        open(self.allowed, "w").close()

    def try_writes(self, profile, paths):
        path = os.path.join(self.tmp, "p.sb")
        with open(path, "w") as f:
            f.write(profile)
        code = ("import json, sys\nout = {}\nfor p in sys.argv[1:]:\n    try:\n        open(p, 'a').write('x')\n"
                "        out[p] = 'ok'\n    except OSError as e:\n        out[p] = e.errno\nprint(json.dumps(out))")
        r = subprocess.run(code_edit.wrap(path, ["/usr/bin/python3", "-I", "-c", code] + paths),
                           capture_output=True, text=True, timeout=30)
        return json.loads(r.stdout)

    def test_cli_profile(self):
        profile = code_edit.cli_profile([self.allowed], os.path.join(self.tmp, "cli-tmp"), self.home)
        j = lambda *p: os.path.join(self.home, *p)  # noqa: E731
        out = self.try_writes(profile, [self.allowed, os.path.join(self.tmp, "cli-tmp", "t"), j(".claude.json"),
                                        j(".claude", "projects", "p", "s.jsonl"), os.path.join(self.tmp, "work", "x.py"),
                                        j(".claude", "settings.json"), j(".claude", "hooks", "h"),
                                        j(".claude", "projects", "p", "memory", "m.md"), j("Documents.txt"),
                                        os.path.join(self.tmp, "p.sb")])
        values = list(out.values())
        self.assertEqual(values[:4], ["ok"] * 4)
        self.assertEqual(values[4:], [1] * 6)

    def test_test_profile_denies_network_and_writes(self):
        server = socket.socket()
        server.bind(("127.0.0.1", 0))
        server.listen(1)
        self.addCleanup(server.close)
        tmp = os.path.join(self.tmp, "cli-tmp")
        path = os.path.join(self.tmp, "t.sb")
        with open(path, "w") as f:
            f.write(code_edit.test_profile(tmp))
        code = ("import socket, sys\ntry:\n    socket.create_connection(('127.0.0.1', %d), 3)\n    print('net ok')\n"
                "except OSError:\n    print('net denied')\ntry:\n    open(sys.argv[1], 'a')\n    print('write ok')\n"
                "except OSError:\n    print('write denied')\nopen(sys.argv[2], 'a')\nprint('tmp ok')"
                % server.getsockname()[1])
        r = subprocess.run(code_edit.wrap(path, ["/usr/bin/python3", "-I", "-c", code, self.allowed,
                                                 os.path.join(tmp, "x")]), capture_output=True, text=True, timeout=30)
        self.assertEqual(r.stdout.split(), ["net", "denied", "write", "denied", "tmp", "ok"])

    def test_paths_that_cannot_be_quoted_are_refused(self):
        for bad in ('/tmp/a"b', "/tmp/a\\b", "relative/x", "/tmp/a\nb"):
            with self.subTest(path=bad):
                with self.assertRaises(code_edit.CodeEditError):
                    code_edit.cli_profile([bad], self.tmp, self.home)


if __name__ == "__main__":
    unittest.main()
