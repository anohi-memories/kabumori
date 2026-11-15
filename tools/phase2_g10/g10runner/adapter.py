"""実行アダプタ。**偽Claudeだけを実行できる**（TASK 実行6）。

- 実行するファイルは、このパッケージに同梱の fake_claude/fake_claude.py に固定（設定・環境変数・
  ポリシーで変更できない）。実Claude CLI の起動経路、任意コマンドの実行は、実装していない。
- 環境変数は許可リスト方式（APIキー・トークン・GitHub認証などは渡さない）。
"""
import os
import sys

PACKAGE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FAKE_CLAUDE = os.path.join(PACKAGE_ROOT, "fake_claude", "fake_claude.py")
ENV_ALLOWLIST = ("LANG",)


class AdapterError(ValueError):
    pass


class FakeClaudeAdapter:
    name = "fake"
    uses_stdin = False

    def settings_doc(self, run_id, policy, edit=None):
        return {"g10_run": run_id, "tools": ["Read", "Glob", "Grep"], "policy_sha256": policy["_digest"]}

    def source_preparer(self):
        from .ifaces import FakeSourcePreparer
        return FakeSourcePreparer()

    def prelaunch(self, request, prompt_path, settings_path, used_states, now=None, edit=None):
        return "the fake Claude adapter does not support code edits" if edit else None

    def command(self, request, prompt_path, settings_path, edit=None):
        return [
            sys.executable, "-I", FAKE_CLAUDE,
            "--session-id", request["session_id"],
            "--settings", settings_path,
            "--model", request["model_id"],
            "--effort", request["effort"],
            "--output-format", "json",
            "--max-budget-usd", request["max_budget_usd"],
            "--prompt-file", prompt_path,
        ]

    def environment(self, scenario_path, edit=None):
        env = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}
        if scenario_path:
            env["FAKE_CLAUDE_SCENARIO"] = scenario_path
        return env


def get_adapter(policy, st=None, req=None, now=None):
    """偽Claude（既定）。実 Claude CLI は、ポリシーが "claude_cli" で、かつ人の REAL_CLAUDE_GO がこの要求に
    一致して期限内のときだけ（TASK 17。GO 1件につき1回）。それ以外はすべて拒否。"""
    if policy.get("adapter") == "claude_cli":
        import time
        from . import real_claude
        go = real_claude.find_go(st, req or {}, time.time() if now is None else now) if st is not None else None
        if go is None:
            raise AdapterError("real Claude CLI needs a matching, unexpired human REAL_CLAUDE_GO")
        return real_claude.RealClaudeAdapter(go)
    if policy.get("adapter") != "fake":
        raise AdapterError("only the fake Claude adapter exists in this build")
    if not os.path.isfile(FAKE_CLAUDE):
        raise AdapterError("fake Claude not found")
    return FakeClaudeAdapter()
