"""実行アダプタが偽Claudeに固定されていること・実Claudeを起動する経路がないこと（TASK 実行6）。"""
import os
import re
import unittest

from g10runner import adapter
from helpers import test_policy

PKG = os.path.dirname(os.path.dirname(os.path.abspath(adapter.__file__)))
SOURCE_DIRS = [os.path.join(PKG, "g10runner"), os.path.join(PKG, "bin"), os.path.join(PKG, "fake_claude")]


def sources():
    for d in SOURCE_DIRS:
        for name in os.listdir(d):
            if name.endswith(".py"):
                path = os.path.join(d, name)
                with open(path, encoding="utf-8") as f:
                    yield path, f.read()


class TestAdapterFixed(unittest.TestCase):
    def test_only_fake_adapter(self):
        for value in ("real", "claude", "", None):
            with self.subTest(adapter=value):
                with self.assertRaises(adapter.AdapterError):
                    adapter.get_adapter(test_policy(adapter=value))
        self.assertIsInstance(adapter.get_adapter(test_policy()), adapter.FakeClaudeAdapter)

    def test_command_targets_bundled_fake_only(self):
        a = adapter.get_adapter(test_policy())
        req = {"session_id": "s", "model_id": "claude-sonnet-5-5", "effort": "medium", "max_budget_usd": "0.50"}
        cmd = a.command(req, "/tmp/p", "/tmp/s")
        self.assertEqual(cmd[2], adapter.FAKE_CLAUDE)
        self.assertTrue(cmd[2].endswith(os.path.join("fake_claude", "fake_claude.py")))
        self.assertNotIn("--dangerously-skip-permissions", cmd)
        self.assertNotIn("--bare", cmd)

    def test_environment_variable_cannot_switch_executable(self):
        os.environ["G10_CLAUDE_BIN"] = "/usr/local/bin/claude"
        os.environ["CLAUDE_BIN"] = "/usr/local/bin/claude"
        try:
            a = adapter.get_adapter(test_policy(executable="/usr/local/bin/claude"))
            cmd = a.command({"session_id": "s", "model_id": "m", "effort": "low", "max_budget_usd": "0.1"}, "p", "s")
            self.assertEqual(cmd[2], adapter.FAKE_CLAUDE)
        finally:
            os.environ.pop("G10_CLAUDE_BIN", None)
            os.environ.pop("CLAUDE_BIN", None)

    def test_environment_allowlist(self):
        os.environ["ANTHROPIC_API_KEY"] = "sk-ant-test"
        os.environ["GH_TOKEN"] = "ghp_test"
        try:
            env = adapter.get_adapter(test_policy()).environment("/tmp/scen.json")
            self.assertEqual(set(env), {"PATH", "LANG", "FAKE_CLAUDE_SCENARIO"})
        finally:
            os.environ.pop("ANTHROPIC_API_KEY", None)
            os.environ.pop("GH_TOKEN", None)

    def test_no_real_claude_path_or_dangerous_flags_in_sources(self):
        forbidden = [r"\.local/bin/claude", r"share/claude/versions", r"/usr/local/bin/claude",
                     r"dangerously-skip-permissions\"", r"\"--bare\"", r"setup-token", r"ANTHROPIC_API_KEY\"\s*:",
                     r"gh\", \"issue\", \"comment", r"git\", \"push"]
        for path, text in sources():
            if path.endswith("test_adapter_static.py"):
                continue
            for pattern in forbidden:
                with self.subTest(path=os.path.basename(path), pattern=pattern):
                    self.assertIsNone(re.search(pattern, text))

    def test_subprocess_use_is_limited(self):
        """subprocess を使うのは、ps（観測）・スタブ／S1の起動・偽Claudeの起動、および固定のシステムの道具
        （/usr/bin/openssl による署名・/usr/bin/plutil -lint による plist の検査。TASK 13）だけ。"""
        allowed = {"procs.py", "agent.py", "stub.py", "fake_claude.py", "ecdsa_signing.py", "launchd_plan.py"}
        for path, text in sources():
            if re.search(r"\bsubprocess\.(run|Popen|call|check_output)\b", text):
                with self.subTest(path=os.path.basename(path)):
                    self.assertIn(os.path.basename(path), allowed)

    def test_system_tool_subprocess_targets_are_fixed(self):
        """TASK 13 の2つのファイルが起動するのは、固定の絶対パスのシステムの道具だけ（Claude・launchctl は起動しない）。"""
        texts = {os.path.basename(p): t for p, t in sources()}
        ecdsa = texts["ecdsa_signing.py"]
        self.assertIn('OPENSSL = "/usr/bin/openssl"', ecdsa)
        self.assertEqual(re.findall(r"subprocess\.(?:run|Popen|call|check_output)\(([^,]+)", ecdsa), ["[OPENSSL] + args"])
        launchd = texts["launchd_plan.py"]
        self.assertEqual(re.findall(r"subprocess\.(?:run|Popen|call|check_output)\(([^,]+)", launchd),
                         ['["/usr/bin/plutil"'])
        for line in launchd.splitlines():
            if "launchctl" in line and not line.strip().startswith(("#", "-", '"', "return", "#", "*")):
                self.assertRegex(line, r'^\s*("|return \[")', line)  # 停止手順の文字列だけ


if __name__ == "__main__":
    unittest.main()
