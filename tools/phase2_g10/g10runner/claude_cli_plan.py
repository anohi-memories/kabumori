"""監督付き自動起動の準備（TASK 13）: 実 Claude CLI の起動計画（dry-run のみ。このモジュールは何も実行しない）。

- probe(): Claude CLI の場所・実体・版を、ファイルを見るだけで調べる（CLI を実行しない）。
- build_plan(): 承認済みの起動要求から、起動するなら使う argv・環境変数・標準入力を組み立てて返すだけ。
  実際の起動は adapter.get_adapter が偽Claude以外を拒否しているので、どこからも行われない。
- 環境変数は許可リスト（PATH・LANG・HOME）だけ。ANTHROPIC_API_KEY 等の API 課金・別の認証に切り替わる変数は
  渡さない（Max の範囲で動かすため。課金が Max に収まることは実機で未検証）。
- プロンプト（TASK 本文）は argv に入れず、標準入力から渡す（ps で他のユーザーから見えないように）。
- フラグ名（-p・--output-format・--model・--session-id・--settings・--max-turns 等）は公開の資料に基づく想定で、
  この版（2.1.305 とみられる）での実際の受け付け・modelUsage の形・予算の上限の効き方は実機で未検証（NOT_VERIFIED）。
"""
import os
import re
import shutil

ENV_ALLOWLIST = ("PATH", "LANG", "HOME")
FORBIDDEN_ENV = re.compile(r"ANTHROPIC|CLAUDE_CODE_USE_|AWS_|GOOGLE_|VERTEX|TOKEN|SECRET|PASSWORD|API_KEY", re.I)
VERSION_RE = re.compile(r"\d+\.\d+\.\d+")


def probe(path_env=None):
    """CLI を実行せずに、場所・実体・版（パスから読める場合）を返す。"""
    found = shutil.which("claude", path=path_env)
    if not found:
        return {"found": False}
    real = os.path.realpath(found)
    base = os.path.basename(real)
    return {"found": True, "path": found, "realpath": real, "executable": os.access(real, os.X_OK),
            "version_from_path": base if VERSION_RE.fullmatch(base) else None, "executed": False}


def build_plan(binary, request, prompt_path, settings_path, home, max_turns=30):
    """起動するなら使う計画を返す（実行しない）。値が足りない・危険なら ValueError。"""
    if not (isinstance(binary, str) and os.path.isabs(binary)):
        raise ValueError("binary must be an absolute path")
    for key in ("model_id", "session_id", "run_id"):
        if not isinstance(request.get(key), str) or not request[key]:
            raise ValueError("request field missing: " + key)
    for p in (prompt_path, settings_path, home):
        if not (isinstance(p, str) and os.path.isabs(p)):
            raise ValueError("paths must be absolute")
    if not (isinstance(max_turns, int) and not isinstance(max_turns, bool) and 0 < max_turns <= 200):
        raise ValueError("max_turns out of range")
    argv = [binary, "-p", "--output-format", "json", "--model", request["model_id"],
            "--session-id", request["session_id"], "--settings", settings_path, "--max-turns", str(max_turns)]
    env = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": home}
    return {"argv": argv, "env": env, "stdin_path": prompt_path, "dry_run": True}


def check_env(env):
    """環境変数が許可リストだけか。違反があれば ValueError。"""
    extra = set(env) - set(ENV_ALLOWLIST)
    bad = [k for k in env if FORBIDDEN_ENV.search(k)]
    if extra or bad:
        raise ValueError("environment not allowed: %s" % sorted(extra | set(bad)))
    return True
