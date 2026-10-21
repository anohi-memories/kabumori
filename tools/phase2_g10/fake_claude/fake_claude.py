#!/usr/bin/env python3
"""偽Claude（試験専用）。実Claude CLI の結果JSONの形をまねて、決まった振る舞いを再現する。

振る舞いは、環境変数 FAKE_CLAUDE_SCENARIO が指すJSONファイルで決める:
  sleep            起動後に待つ秒数
  ignore_sigterm   SIGTERM を無視する
  spawn_child      同じプロセスグループに子プロセスを作る（子も識別子を引数に持つ）
  child_escape     子プロセスを別のセッションへ逃がす（setsid）
  exit_code        終了コード
  result           最終回答の文章
  model_usage      modelUsage（既定: 指定モデル1件）
  is_error         結果JSONの is_error
  no_output        結果JSONを出さない
  started_marker   起動したことを示すファイルのパス（試験用）
  write_path       （試験用）このパスへ書き込もうとする（tripwire の試験）
ネットワーク・認証・GitHub・外部コマンドには一切アクセスしない。
"""
import argparse
import json
import os
import signal
import subprocess
import sys
import time


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--session-id", required=True)
    p.add_argument("--settings", required=True)
    p.add_argument("--model", required=True)
    p.add_argument("--effort", required=True)
    p.add_argument("--output-format", required=True)
    p.add_argument("--max-budget-usd", required=True)
    p.add_argument("--prompt-file")
    p.add_argument("--child", action="store_true")
    a = p.parse_args(argv)

    scenario = {}
    path = os.environ.get("FAKE_CLAUDE_SCENARIO")
    if path:
        with open(path, "r", encoding="utf-8") as f:
            scenario = json.load(f)

    if scenario.get("ignore_sigterm"):
        signal.signal(signal.SIGTERM, signal.SIG_IGN)

    if a.child:
        while True:
            time.sleep(0.2)

    if scenario.get("started_marker"):
        with open(scenario["started_marker"], "w") as f:
            f.write(str(os.getpid()))

    child = None
    if scenario.get("spawn_child"):
        child = subprocess.Popen(
            [sys.executable, "-I", os.path.abspath(__file__), "--child",
             "--session-id", a.session_id, "--settings", a.settings, "--model", a.model,
             "--effort", a.effort, "--output-format", a.output_format,
             "--max-budget-usd", a.max_budget_usd],
            env=dict(os.environ), start_new_session=bool(scenario.get("child_escape")))

    if scenario.get("write_path"):
        try:
            with open(scenario["write_path"], "a") as f:
                f.write("fake write\n")
        except OSError:
            pass

    end = time.monotonic() + float(scenario.get("sleep", 0))
    while time.monotonic() < end:
        time.sleep(0.05)

    if not scenario.get("no_output"):
        usage = scenario.get("model_usage")
        if usage is None:
            usage = {a.model: {"inputTokens": 10, "outputTokens": 5, "costUSD": 0.001}}
        out = {
            "type": "result",
            "subtype": "success",
            "is_error": bool(scenario.get("is_error", False)),
            "result": scenario.get("result", "調査結果（偽Claude）"),
            "session_id": a.session_id,
            "modelUsage": usage,
            "total_cost_usd": 0.001,
            "terminal_reason": "completed",
        }
        sys.stdout.write(json.dumps(out, ensure_ascii=False))
        sys.stdout.flush()
    if child is not None and not scenario.get("leave_child"):
        child.terminate()
        child.wait()
    return int(scenario.get("exit_code", 0))


if __name__ == "__main__":
    sys.exit(main())
