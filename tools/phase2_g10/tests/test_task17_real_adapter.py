"""TASK 17: 実 Claude CLI のアダプタの経路（dry-run）。実 Claude は使わない。

人の REAL_CLAUDE_GO で固定した「代役の CLI」（引数・環境変数・標準入力を検査して、Claude と同じ形の JSON を返す
だけのスクリプト）を、実アダプタの経路（GO の照合・起動直前の再検証・git の作業フォルダ・標準入力・環境の許可
リスト）でスタブから起動し、監督・finalize・REPORT まで通す。GO が無い・期限切れ・別の承認・CLI の差し替えは起動しない。
"""
import json
import os
import subprocess
import time

from g10runner import adapter, issue as issue_mod, real_claude, signing
from g10runner.fsutil import read_json, sha256_hex
from helpers import TRUSTED_ISSUE, make_body
from test_task15_wired_e2e import WiredEnv, WiredBase, WIRED_TIMING
from helpers import test_policy

STAND_IN = r'''#!/usr/bin/python3 -I
"""代役の CLI（試験専用）。実 Claude ではない。受け取ったものを検査して記録し、Claude と同じ形の JSON を返す。"""
import json, os, sys
argv = sys.argv[1:]
here = os.path.dirname(os.path.abspath(__file__))
if argv[:2] == ["auth", "status"]:  # TASK 19: ログインの確認（NOT_LOGGED_IN があれば未ログイン。メール等も返す）
    with open(os.path.join(here, "auth_calls.jsonl"), "a") as f:
        f.write(json.dumps({"argv": argv, "env_keys": sorted(os.environ), "cwd": os.getcwd()}) + "\n")
    ok = not os.path.exists(os.path.join(here, "NOT_LOGGED_IN"))
    print(json.dumps({"loggedIn": ok, "authMethod": "claude.ai" if ok else "none", "apiProvider": "firstParty",
                      "email": "secret-person@example.invalid", "orgName": "Secret Org", "subscriptionType": "max"}))
    sys.exit(0 if ok else 1)
prompt = sys.stdin.read()
def opt(name):
    return argv[argv.index(name) + 1] if name in argv else None
record = {"argv": argv, "env_keys": sorted(os.environ), "prompt_len": len(prompt), "cwd": os.getcwd(),
          "cwd_has_marker": os.path.exists("MARKER.txt")}
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "calls.jsonl"), "a") as f:
    f.write(json.dumps(record) + "\n")
model = opt("--model")
print(json.dumps({"type": "result", "subtype": "success", "is_error": False,
                  "result": "代役の CLI の結果\npending_questions: なし", "session_id": opt("--session-id"),
                  "modelUsage": {model: {"inputTokens": 1, "outputTokens": 1, "costUSD": 0.0}},
                  "total_cost_usd": 0.0, "terminal_reason": "completed"}))
'''


def git(args, cwd):
    subprocess.run(["/usr/bin/git"] + args, cwd=cwd, check=True, capture_output=True,
                   env={"PATH": "/usr/bin:/bin", "HOME": "/nonexistent", "GIT_CONFIG_NOSYSTEM": "1",
                        "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid",
                        "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.invalid"})


class RealAdapterBase(WiredBase):
    def setUp(self):
        self.env = WiredEnv(mode="ecdsa", ledger_limit=200,
                            policy=test_policy(timing=dict(WIRED_TIMING), adapter="claude_cli"))
        self.addCleanup(self.env.cleanup)
        real = self.env.real
        # 作業フォルダの元（小さなローカルリポジトリ）
        self.repo = os.path.join(real, "repo")
        os.makedirs(self.repo)
        git(["init", "-q"], self.repo)
        with open(os.path.join(self.repo, "MARKER.txt"), "w") as f:
            f.write("fixture\n")
        git(["add", "MARKER.txt"], self.repo)
        git(["commit", "-q", "-m", "fixture"], self.repo)
        self.base_sha = subprocess.run(["/usr/bin/git", "rev-parse", "HEAD"], cwd=self.repo, capture_output=True,
                                       text=True, check=True).stdout.strip()
        # 代役の CLI（版の名前のファイル）
        self.cli_dir = os.path.join(real, "cli")
        os.makedirs(self.cli_dir)
        self.cli = os.path.join(self.cli_dir, "9.9.9")
        with open(self.cli, "w") as f:
            f.write(STAND_IN)
        os.chmod(self.cli, 0o755)
        self.home = os.path.join(real, "home")
        os.makedirs(self.home)
        self.env.envelope()
        self.env.s2_heartbeat()
        # 上限 60分（試験の時間では 30秒）: git の用意と代役の起動が負荷で遅れても、期限で止められないように
        self.body = make_body(self.env.policy, max_minutes="60", mutate=lambda b: b.replace(
            "0c42933ca5030ab31a56267529430d0473d9b155", self.base_sha))
        self.env.issue.publish(self.body)

    def go(self, **over):
        doc = {"go_id": "go-test-1", "approval_id": "g10-p2-test-0001",
               "task_sha256": issue_mod.norm.compute_hash(self.body),
               "body_sha256": sha256_hex(self.body.encode("utf-8")), "cli_realpath": self.cli,
               "cli_version": "9.9.9", "home": self.home, "max_turns": 10, "source_repo": self.repo,
               "expires_at": time.time() + 600, "max_runs": 1}
        doc.update(over)
        return self.env.control.approve_real_claude_go(doc)

    def calls(self):
        path = os.path.join(self.cli_dir, "calls.jsonl")
        return [json.loads(x) for x in open(path)] if os.path.exists(path) else []

    def run_once(self):
        run_id = self.claim()
        stub, reason = self.env.agent.handle_request_file(self.env.layout.request_file(run_id))
        self.assertIsNotNone(stub, reason)
        self.addCleanup(lambda: (stub.poll() is None and stub.kill(), stub.wait(timeout=30)))
        stub.wait(timeout=60)
        return run_id


class RealAdapterPath(RealAdapterBase):
    def test_one_supervised_launch_through_the_real_adapter_path(self):
        self.go()
        run_id = self.run_once()
        entry = self.wait_terminal(run_id, 60)
        status, end = self.env.control.finalize(run_id, current_body=self.body)
        self.assertEqual(status, "ended_checks_passed",
                         (end["payload"], {k: entry.get(k) for k in ("state", "stop_reason", "stop_by", "abort_reason")}))
        calls = self.calls()
        self.assertEqual(len(calls), 1)  # 起動はちょうど1回
        c = calls[0]
        self.assertEqual(c["prompt_len"], len(self.body))  # 本文は標準入力から（argv には入れない）
        self.assertFalse(any("readonly_trial" in a for a in c["argv"]))
        # /usr/bin/python3（Xcode の中継）が代役の起動時に自分で足す変数を除けば、渡すのは PATH・LANG・HOME だけ
        shim = {"CPATH", "LIBRARY_PATH", "MANPATH", "SDKROOT", "__CF_USER_TEXT_ENCODING", "PWD"}
        self.assertEqual(set(c["env_keys"]) - shim, {"PATH", "LANG", "HOME", "USER"}, c["env_keys"])  # USER: TASK 19
        self.assertFalse([k for k in c["env_keys"] if k.startswith(("ANTHROPIC", "CLAUDE", "GH_", "GITHUB"))])
        self.assertTrue(c["cwd_has_marker"])  # 作業フォルダは base_sha の checkout
        for flag in ("--allowedTools", "--disallowedTools", "--strict-mcp-config", "--setting-sources",
                     "--max-turns", "--max-budget-usd"):
            self.assertIn(flag, c["argv"])
        settings = read_json(os.path.join(self.env.layout.run_dir(run_id), "settings.json"))
        self.assertIn("Bash", settings["permissions"]["deny"])
        # 同じ承認では二度と起動しない
        self.assertEqual(self.env.agent.spawn_stub(run_id).wait(timeout=60), 3)
        refused, reason = self.env.control.try_claim(self.body, TRUSTED_ISSUE, time.time())
        self.assertIsNone(refused)
        self.assertEqual(len(self.calls()), 1)

    def assert_not_launched(self, run_id):
        self.assertNotIn("SPAWNED", self.env.agent.used_state(run_id))
        self.assertEqual(self.calls(), [])

    def test_no_go_means_no_launch(self):
        run_id = self.run_once()
        self.assert_not_launched(run_id)
        self.assertIn("adapter unavailable", json.dumps(self.env.agent.used.read_all()[-1]["payload"]))

    def test_expired_or_mismatched_go_means_no_launch(self):
        cases = {"expired": dict(expires_at=time.time() - 1), "other approval": dict(approval_id="other"),
                 "other body": dict(body_sha256="0" * 64)}
        for i, (name, over) in enumerate(cases.items()):
            with self.subTest(case=name):
                self.go(go_id="go-%d" % i, **over)
        run_id = self.run_once()
        self.assert_not_launched(run_id)

    def test_cli_replaced_after_go_is_not_launched(self):
        self.go()
        with open(self.cli, "a") as f:
            f.write("\n")
        newer = os.path.join(self.cli_dir, "9.9.10")
        os.rename(self.cli, newer)
        os.symlink(newer, self.cli)  # GO のパスは別の版を指すようになった
        run_id = self.run_once()
        self.assert_not_launched(run_id)
        e = self.wait_terminal(run_id, 30)
        self.assertIn("prelaunch check failed", e.get("abort_reason", ""))


class GoRules(RealAdapterBase):
    def test_invalid_go_documents_are_refused(self):
        good = {"go_id": "g", "approval_id": "a", "task_sha256": "a" * 64, "body_sha256": "b" * 64,
                "cli_realpath": "/opt/claude/2.1.305", "cli_version": "2.1.305", "home": "/Users/x",
                "max_turns": 10, "source_repo": "/r", "expires_at": time.time() + 60, "max_runs": 1}
        self.assertIsNone(real_claude.go_problem(good))
        bad = {"two runs": dict(max_runs=2), "relative cli": dict(cli_realpath="claude"),
               "version mismatch": dict(cli_version="2.1.304"), "turns": dict(max_turns=500),
               "extra": dict(good, extra=1)}
        for name, over in bad.items():
            with self.subTest(case=name):
                self.assertIsNotNone(real_claude.go_problem(dict(good, **over)))
                with self.assertRaises(ValueError):
                    self.env.control.approve_real_claude_go(dict(good, **over))

    def test_go_needs_the_human_role_and_the_claude_cli_policy(self):
        self.go()
        st = self.env.control.read_state()
        req = {"approval_id": "g10-p2-test-0001", "task_sha256": issue_mod.norm.compute_hash(self.body),
               "prompt": self.body}
        self.assertIsInstance(adapter.get_adapter(self.env.policy, st, req), real_claude.RealClaudeAdapter)
        fake_policy = dict(self.env.policy, adapter="fake")
        self.assertIsInstance(adapter.get_adapter(fake_policy, st, req), adapter.FakeClaudeAdapter)
        for other in ("real", "claude", ""):
            with self.assertRaises(adapter.AdapterError):
                adapter.get_adapter(dict(self.env.policy, adapter=other), st, req)
        with self.assertRaises(adapter.AdapterError):
            adapter.get_adapter(self.env.policy, None, req)


class EditorBoundByGo(RealAdapterBase):
    """認証なしの REST は編集者を返さない。人の GO が本文を承認しているときだけ、その本文を信頼する。"""

    def evidence(self, body):
        src = issue_mod.MockIssueSource()
        src.publish(body, editor=issue_mod.UNKNOWN_EDITOR)
        w = issue_mod.IssueWitness(src, signing.HmacTestSigner({"witness": b"k"}))
        return w.observe("claim"), signing.HmacTestVerifier({"witness": b"k"})

    def test_unknown_editor_only_with_a_go_for_this_body(self):
        doc, verifier = self.evidence(self.body)
        now = time.time()
        reason = issue_mod.check_evidence(doc, verifier, self.body, now, 120)
        self.assertIsNotNone(reason, "an unknown editor was accepted without a GO")
        self.assertIn("not trusted", reason)
        approved = frozenset([sha256_hex(self.body.encode("utf-8"))])
        self.assertIsNone(issue_mod.check_evidence(doc, verifier, self.body, now, 120, go_bodies=approved))
        other = frozenset([sha256_hex(b"other body")])
        reason = issue_mod.check_evidence(doc, verifier, self.body, now, 120, go_bodies=other)
        self.assertIsNotNone(reason, "a GO for another body was accepted")
        self.assertIn("not trusted", reason)
        src = issue_mod.MockIssueSource()
        src.publish(self.body, editor="someone-else")  # 別の人が編集したと分かるものは、GO があっても拒否
        w = issue_mod.IssueWitness(src, signing.HmacTestSigner({"witness": b"k"}))
        self.assertIn("not trusted", issue_mod.check_evidence(w.observe("claim"), verifier, self.body, now, 120,
                                                              go_bodies=approved))


def load_first_run():
    import importlib.util
    spec = importlib.util.spec_from_file_location("g10_first_run", os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "bin", "g10_first_run.py"))
    fr = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(fr)
    return fr


class FirstRunCommands(RealAdapterBase):
    """初回起動の手順コマンド（init → approve → run）を、模擬 Issue（ファイル）と代役の CLI で通す。"""

    def approved_root(self):
        import shutil
        from g10runner import supervise
        from g10runner.layout import Layout
        fr = load_first_run()
        root = os.path.join(self.env.real, "first-run-root")
        self.addCleanup(shutil.rmtree, root, True)
        self.assertEqual(fr.main(["init", "--root", root, "--issue-source", "file"]), 0)
        policy = __import__("g10runner.policy", fromlist=["load"]).load(Layout(root).policy_pub)
        self.assertEqual(policy["adapter"], "claude_cli")
        body = make_body(policy, mutate=lambda b: b.replace("0c42933ca5030ab31a56267529430d0473d9b155",
                                                             self.base_sha))
        issue_mod.FileIssueSource(issue_mod.mock_issue_path(root)).publish(body)
        self.assertEqual(fr.main(["approve", "--root", root, "--cli", self.cli, "--source-repo", self.repo]), 0)
        supervise.write_s2_heartbeat(Layout(root))
        return fr, root

    def auth_calls(self):
        path = os.path.join(self.cli_dir, "auth_calls.jsonl")
        return [json.loads(x) for x in open(path)] if os.path.exists(path) else []

    def test_init_approve_run(self):
        fr, root = self.approved_root()
        self.assertEqual(fr.main(["run", "--root", root]), 0)
        self.assertEqual(len(self.calls()), 1)
        self.assertEqual(len(self.auth_calls()), 1)  # TASK 19: CLAIM の前にログインを1回確認
        with self.assertRaises(SystemExit):  # 同じ承認では二度目を起動しない
            fr.main(["run", "--root", root])
        self.assertEqual(len(self.calls()), 1)

    def test_not_logged_in_stops_before_claim_and_keeps_the_approval(self):
        """TASK 19: 子の環境でログインしていなければ、CLAIM の前に止まり、承認は消費されない（直してから使える）。"""
        fr, root = self.approved_root()
        marker = os.path.join(self.cli_dir, "NOT_LOGGED_IN")
        open(marker, "w").close()
        with self.assertRaises(SystemExit) as cm:
            fr.main(["run", "--root", root])
        self.assertIn("auth preflight failed", str(cm.exception))
        self.assertEqual(self.calls(), [])
        self.assertEqual(len(self.auth_calls()), 1)
        os.remove(marker)
        self.assertEqual(fr.main(["run", "--root", root]), 0)  # 同じ承認がまだ使える
        self.assertEqual(len(self.calls()), 1)


class AuthStatusCheck(RealAdapterBase):
    """TASK 19: `<CLI> auth status --json` の確認は、子と同じ環境で、安全な項目だけを返す。"""

    def auth_calls(self):
        path = os.path.join(self.cli_dir, "auth_calls.jsonl")
        return [json.loads(x) for x in open(path)] if os.path.exists(path) else []

    def test_returns_only_safe_fields_in_the_child_environment(self):
        r = real_claude.auth_status(self.cli, self.home)
        self.assertIs(r["logged_in"], True)
        self.assertEqual((r["exit_code"], r["auth_method"], r["subscription_type"]), (0, "claude.ai", "max"))
        self.assertEqual(r["env_names"], ["HOME", "LANG", "PATH", "USER"])
        self.assertNotIn("secret-person", json.dumps(r))
        self.assertNotIn("Secret Org", json.dumps(r))
        call = self.auth_calls()[0]
        self.assertEqual(call["argv"], ["auth", "status", "--json"])
        self.assertEqual(call["cwd"], "/")
        self.assertIn("USER", call["env_keys"])  # TASK 19: 無いと CLI が Keychain のログイン情報を見つけない
        for name in ("LOGNAME", "TMPDIR", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_SESSION_ID"):
            self.assertNotIn(name, call["env_keys"])

    def test_not_logged_in_and_unparseable_output(self):
        open(os.path.join(self.cli_dir, "NOT_LOGGED_IN"), "w").close()
        r = real_claude.auth_status(self.cli, self.home)
        self.assertIs(r["logged_in"], False)
        self.assertEqual(r["exit_code"], 1)
        bad = os.path.join(self.cli_dir, "1.0.0")
        with open(bad, "w") as f:
            f.write("#!/bin/sh\necho not-json\n")
        os.chmod(bad, 0o755)
        r = real_claude.auth_status(bad, self.home)
        self.assertIsNone(r["logged_in"])
        self.assertEqual(r["problem"], "unparseable auth status output")

    def test_extra_environment_names_are_allowlisted(self):
        with self.assertRaises(real_claude.RealClaudeError):
            real_claude.auth_status(self.cli, self.home, extra_env={"ANTHROPIC_API_KEY": "x"})
        self.assertEqual(self.auth_calls(), [])
        r = real_claude.auth_status(self.cli, self.home, extra_env={"TMPDIR": "/tmp"})
        self.assertEqual(r["env_names"], ["HOME", "LANG", "PATH", "TMPDIR", "USER"])
        self.assertIn("TMPDIR", self.auth_calls()[0]["env_keys"])

    def test_child_user_is_the_uid_name_and_is_masked_in_displays(self):
        import pwd
        from g10runner import claude_cli_plan as ccp
        env = real_claude.child_environment(self.home)
        self.assertEqual(env["USER"], pwd.getpwuid(os.getuid()).pw_name)
        plan = ccp.build_plan(self.cli, {"model_id": "m", "session_id": "s", "run_id": "r", "max_budget_usd": "0.10"},
                              "/r/prompt.md", "/r/settings.json", self.home)
        self.assertEqual(plan["env"], env)
        self.assertTrue(ccp.check_env(plan["env"]))
        self.assertEqual(ccp.describe(plan)["env"]["USER"], "<USER>")

    def test_auth_check_command_prints_no_email(self):
        import contextlib
        import io
        fr = load_first_run()
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.assertEqual(fr.main(["auth-check", "--cli", self.cli]), 0)
        self.assertNotIn("secret-person", buf.getvalue())
        self.assertIn('"logged_in": true', buf.getvalue())
        with self.assertRaises(SystemExit):  # 決まった名前以外は受け付けない
            with contextlib.redirect_stderr(io.StringIO()):
                fr.main(["auth-check", "--cli", self.cli, "--with-env", "ANTHROPIC_BASE_URL"])


if __name__ == "__main__":
    import unittest
    unittest.main()
