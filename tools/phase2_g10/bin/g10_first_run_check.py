#!/usr/bin/env python3
"""実 Claude の監督付き初回起動の前に、人が実行する確認（TASK 17）。**実 Claude は実行しない**。

- Issue #323 を認証なしの REST で1回だけ読み（token を使わない・公開リポジトリ）、state・作成者・本文の SHA-256 と、
  自動実行してよい Phase 2 TASK の形か（meta.validate_task）を表示する。
- Claude CLI の場所・実体・版を、ファイルを見るだけで調べる（CLI を実行しない）。
- 起動するなら使う argv を、伏せ字で表示する（値はこの確認用の仮の値）。
- 費用・環境の注意（追加使用量の有無、渡さない環境変数の名前、専用ユーザーの有無）を表示する。秘密の値は表示しない。
使い方: /usr/bin/python3 -I bin/g10_first_run_check.py [--no-network]
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from g10runner import claude_cli_plan as ccp, github_source as gh, meta, policy as policy_mod  # noqa: E402
from g10runner import rate_budget as rb, real_claude  # noqa: E402
from g10runner.fsutil import sha256_hex  # noqa: E402


def issue_section():
    src = gh.GitHubIssueSource(enabled=True, budget=rb.RateBudget(rb.LIMITS["anonymous"]))
    try:
        snap = src.fetch(timeout=10)
    except Exception as exc:
        return {"fetched": False, "error": type(exc).__name__}
    pol = policy_mod.with_digest(dict(policy_mod.DEFAULT_POLICY))
    result = meta.validate_task(snap["body"], pol)
    return {"fetched": True, "auth": src.last_meta.get("auth"), "state": snap["state"], "author": snap["author"],
            "editor_basis": "unknown (REST) -> needs a human REAL_CLAUDE_GO for this exact body",
            "body_sha256": sha256_hex(snap["body"].encode("utf-8")), "updated_at": snap["updated_at"],
            "runnable_phase2_task": result.ok, "first_problems": result.problems[:3],
            "rate_remaining": src.last_meta.get("rate_remaining")}


def cli_section():
    path = os.path.expanduser("~/.local/bin/claude")  # 見るだけ（このファイルは subprocess を使わない）
    p = real_claude.probe_file(path)
    req = {"model_id": "claude-sonnet-5-5", "session_id": "00000000-0000-4000-8000-000000000000",
           "run_id": "run-dryrun", "max_budget_usd": "0.50"}
    plan = ccp.build_plan(p["realpath"], req, "/RUN_DIR/prompt.md", "/RUN_DIR/settings.json", os.path.expanduser("~"),
                          10)
    return {"probe": p, "planned_argv": ccp.describe(plan)["argv"], "stdin": "prompt file (not argv)",
            "env_passed": sorted(plan["env"])}


def account_section():
    out = {"anthropic_env_names_not_passed": sorted(k for k in os.environ if k.startswith("ANTHROPIC"))}
    try:
        with open(os.path.expanduser("~/.claude.json"), encoding="utf-8") as f:
            acct = json.load(f).get("oauthAccount") or {}
        out.update(logged_in=bool(acct), organization_type=acct.get("organizationType"),
                   extra_usage_enabled=acct.get("hasExtraUsageEnabled"))
    except Exception as exc:
        out["account"] = "unreadable: %s" % type(exc).__name__
    return out


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--no-network", action="store_true")
    a = p.parse_args()
    report = {"real_claude_executed": False,
              "issue_323": None if a.no_network else issue_section(),
              "claude_cli": cli_section(), "account_and_env": account_section()}
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
