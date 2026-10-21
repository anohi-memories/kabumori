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

    def command(self, request, prompt_path, settings_path):
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

    def environment(self, scenario_path):
        env = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"}
        if scenario_path:
            env["FAKE_CLAUDE_SCENARIO"] = scenario_path
        return env


def get_adapter(policy):
    if policy.get("adapter") != "fake":
        raise AdapterError("only the fake Claude adapter exists in this build")
    if not os.path.isfile(FAKE_CLAUDE):
        raise AdapterError("fake Claude not found")
    return FakeClaudeAdapter()
