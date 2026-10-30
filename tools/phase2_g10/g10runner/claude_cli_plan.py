"""監督付き自動起動の準備（TASK 13）: 実 Claude CLI の起動計画（dry-run のみ。このモジュールは何も実行しない）。

- probe(): Claude CLI の場所・実体・版を、ファイルを見るだけで調べる（CLI を実行しない）。
- build_plan(): 承認済みの起動要求から、起動するなら使う argv・環境変数・標準入力を組み立てて返すだけ。
  実際の起動は adapter.get_adapter が偽Claude以外を拒否しているので、どこからも行われない。
- 環境変数は許可リスト（PATH・LANG・HOME・USER。USER は TASK 19）だけ。ANTHROPIC_API_KEY 等の API 課金・別の認証に切り替わる変数は
  渡さない（Max の範囲で動かすため。課金が Max に収まることは実機で未検証）。
- プロンプト（TASK 本文）は argv に入れず、標準入力から渡す（ps で他のユーザーから見えないように）。
- フラグ名（-p・--output-format・--model・--session-id・--settings・--max-turns 等）は公開の資料に基づく想定で、
  この版（2.1.305 とみられる）での実際の受け付け・modelUsage の形・予算の上限の効き方は実機で未検証（NOT_VERIFIED）。
- TASK 15（何も実行しない）:
  - consistent_with_fake(): 実 CLI の計画と偽Claude のコマンドが、同じ要求の値（model・session・settings・出力形式・
    プロンプトの出どころ）を使うことを確かめる。偽Claude で試した経路と、実 CLI の計画がずれないようにする。
  - describe(): 記録・REPORT 用の表示。HOME を <HOME> に伏せ、token に見える値があれば表示を作らない（ValueError）。
  - prelaunch_check(): 起動するなら直前に行う再検証。起動待ちがちょうど1件（ACCEPTED→SPAWNING。二重起動の防止）・
    CLI の実体と版が固定したものと同じ・計画が承認済みの要求から作り直したものと完全に同じ・環境変数が許可リストだけ。
    確認と実行の間に CLI がすり替わる可能性（実行は記述子経由にする等）・実 CLI の停止（子プロセス・シグナル）・
    timeout の効き方は未検証（NOT_VERIFIED）。偽Claude の停止・timeout・HALT はスタブと S1/S2 が試験済み。
"""
import os
import pwd
import re
import shutil

ENV_ALLOWLIST = ("PATH", "LANG", "HOME", "USER", "TMPDIR")  # TMPDIR は限定コード編集のときだけ（TASK 26）
FORBIDDEN_ENV = re.compile(r"ANTHROPIC|CLAUDE_CODE_USE_|AWS_|GOOGLE_|VERTEX|TOKEN|SECRET|PASSWORD|API_KEY", re.I)
VERSION_RE = re.compile(r"\d+\.\d+\.\d+")
SECRET_LIKE = re.compile(r"(ghp_|gho_|ghs_|ghu_|github_pat_|sk-ant-)[A-Za-z0-9_-]{8,}")
SHARED_OPTIONS = ("--model", "--session-id", "--settings", "--output-format", "--max-budget-usd")


def probe(path_env=None):
    """CLI を実行せずに、場所・実体・版（パスから読める場合）を返す。"""
    found = shutil.which("claude", path=path_env)
    if not found:
        return {"found": False}
    real = os.path.realpath(found)
    base = os.path.basename(real)
    return {"found": True, "path": found, "realpath": real, "executable": os.access(real, os.X_OK),
            "version_from_path": base if VERSION_RE.fullmatch(base) else None, "executed": False}


def build_plan(binary, request, prompt_path, settings_path, home, max_turns=30, edit=None):
    """起動するなら使う計画を返す（実行しない）。値が足りない・危険なら ValueError。"""
    if not (isinstance(binary, str) and os.path.isabs(binary)):
        raise ValueError("binary must be an absolute path")
    for key in ("model_id", "session_id", "run_id", "max_budget_usd"):
        if not isinstance(request.get(key), str) or not request[key]:
            raise ValueError("request field missing: " + key)
    for p in (prompt_path, settings_path, home):
        if not (isinstance(p, str) and os.path.isabs(p)):
            raise ValueError("paths must be absolute")
    if not (isinstance(max_turns, int) and not isinstance(max_turns, bool) and 0 < max_turns <= 200):
        raise ValueError("max_turns out of range")
    # TASK 17: 道具は読み取りだけ。利用者の設定（hooks・plugins）と MCP を読み込まない（フラグの文字列は版 2.1.305 の
    # 実行ファイルの中で存在を確認。実際の受け付けは実機で未確認）
    argv = [binary, "-p", "--output-format", "json", "--model", request["model_id"],
            "--session-id", request["session_id"], "--settings", settings_path, "--setting-sources", "local",
            "--strict-mcp-config", "--allowedTools", allowed_tools(edit), "--disallowedTools", disallowed_tools(edit),
            "--max-turns", str(max_turns), "--max-budget-usd", str(request["max_budget_usd"])]
    env = child_env(edit["home"] if edit and edit.get("home") else home)  # TASK 33: 限定コード編集は使い捨ての HOME
    if edit:  # TASK 26: CLI の一時ファイルはランの一時フォルダへ（サンドボックスで /tmp は書けない）
        env["TMPDIR"] = edit["tmp_dir"]
    return {"argv": argv, "env": env, "stdin_path": prompt_path, "dry_run": True}


def edit_rules(edit):
    """限定コード編集で許す Edit の規則（許可ファイルの絶対パスだけ。`//` は絶対パスの書き方）。"""
    return ["Edit(/%s)" % p for p in edit["abs_paths"]]


def allowed_tools(edit=None):
    return ",".join(["Read", "Glob", "Grep"] + (edit_rules(edit) if edit else []))


def disallowed_tools(edit=None):
    tools = ["Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Task"]
    if edit:  # 許可ファイルへの Edit だけを許す（"Edit" 全体の拒否は許可より優先されるので外す。Write は拒否のまま）
        tools.remove("Edit")
    return ",".join(tools)


def child_env(home):
    """実 CLI の子に渡す環境（許可リストだけ。API キー・BASE_URL 等は渡さない）。

    USER は、CLI が Keychain のログイン情報を探す名前に使う。TASK 19 の実測（auth status・モデルなし）で、USER が無いと
    「Not logged in」、加えるとログイン済みになった。値はこのプロセスの uid の名前（秘密ではない）。"""
    return {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": home, "USER": pwd.getpwuid(os.getuid()).pw_name}


def check_env(env):
    """環境変数が許可リストだけか。違反があれば ValueError。"""
    extra = set(env) - set(ENV_ALLOWLIST)
    bad = [k for k in env if FORBIDDEN_ENV.search(k)]
    if extra or bad:
        raise ValueError("environment not allowed: %s" % sorted(extra | set(bad)))
    return True


def _option(argv, name):
    """name がちょうど1回あり、値が続くならその値。そうでなければ None。"""
    if argv.count(name) != 1:
        return None
    i = argv.index(name)
    return argv[i + 1] if i + 1 < len(argv) else None


def consistent_with_fake(plan, fake_argv):
    """実 CLI の計画と偽Claude のコマンドの違いの一覧（空＝一致）。"""
    problems = []
    for name in SHARED_OPTIONS:
        a, b = _option(plan["argv"], name), _option(fake_argv, name)
        if a is None or b is None:
            problems.append("%s must appear exactly once in both" % name)
        elif a != b:
            problems.append("%s differs" % name)
    if "--prompt-file" in plan["argv"]:
        problems.append("the real CLI plan must read the prompt from stdin, not argv")
    if _option(fake_argv, "--prompt-file") != plan.get("stdin_path"):
        problems.append("prompt source differs")
    return problems


def describe(plan):
    """記録・REPORT 用の表示（伏せ字）。token に見える値があれば ValueError（表示を作らない）。"""
    home = plan["env"].get("HOME")

    def red(value):
        if SECRET_LIKE.search(value):
            raise ValueError("plan contains a secret-like value")
        return value.replace(home, "<HOME>") if home else value
    return {"argv": [red(a) for a in plan["argv"]],
            "env": {k: "<USER>" if k == "USER" else red(v) for k, v in sorted(plan["env"].items())},
            "stdin_path": red(plan["stdin_path"]), "dry_run": True}


def prelaunch_check(plan, request, prompt_path, settings_path, home, pinned, used_states, probe_fn=probe,
                    max_turns=30, edit=None):
    """起動するなら直前に行う再検証（実行しない）。問題があれば理由（文字列）、なければ None。

    pinned: {"realpath": CLI の実体の絶対パス, "version": 版}（人が確認して固定したもの）。
    used_states: このランの used_requests の状態の列（ちょうど ACCEPTED→SPAWNING のときだけ起動してよい）。
    max_turns: 承認済みの上限（計画に書かれた値は信用しない）。"""
    if used_states != ["ACCEPTED", "SPAWNING"]:
        return "not exactly one pending launch (at-most-once)"
    found = probe_fn()
    if not found.get("found") or not found.get("executable"):
        return "claude CLI not found or not executable"
    if found.get("realpath") != pinned.get("realpath") or found.get("version_from_path") != pinned.get("version"):
        return "claude CLI changed since it was pinned"
    try:  # 固定した CLI の実体と承認済みの値（計画の中の値ではない）から作り直し、計画と完全に同じであること
        fresh = build_plan(pinned["realpath"], request, prompt_path, settings_path, home, max_turns, edit)
    except ValueError as exc:
        return "plan cannot be rebuilt from the approved request: %s" % exc
    if fresh != plan:
        return "plan differs from the approved request"
    try:
        check_env(plan["env"])
        describe(plan)
    except ValueError as exc:
        return str(exc)
    return None
