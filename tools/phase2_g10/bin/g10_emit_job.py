#!/usr/bin/env python3
"""署名ジョブの発行（producer, B0-4）。yuya（制御プレーン）側で実行する。**実 Claude は呼ばない**（起動は _kaburun の常駐）。

  /usr/bin/python3 -I bin/g10_emit_job.py --root ROOT --in HANDOFF_IN --bundles-dir DIR \
      --source-repo REPO --cli /Users/_kaburun/clirun/<ver> --home /Users/_kaburun [--max-turns N] \
      [--expires-in SECONDS] [--job-ttl SECONDS] [--body-file FILE] --go

- 既定（--go 無し）は dry-run: 取得・検証・bundle 生成まで行い、承認/発行する内容の要約を出すだけで、
  GO の承認も try_claim も handoff/in への書き込みもしない。実際に発行するには **--go** を付ける（＝人の明示の承認）。
- 本文は --body-file があればそれ、無ければ Issue #323 をログインなしの REST で1回取得する（try_claim は別途 witness で
  起動時の証拠を取り直す）。
- source bundle は `git bundle create ... --all <base_sha>` で作る（自己完結。実行側は yuya の repo を読まない）。
- 秘密の値・本文・メールアドレスは出力しない（本文は SHA-256 で示す）。
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from g10runner import autorun, emit, meta, source_bundle  # noqa: E402
from g10runner.control import GoReuseError  # noqa: E402
from g10runner.fsutil import sha256_hex  # noqa: E402

TRUSTED_LOGIN = "anohi-memories"
ISSUE_NUMBER = 323
PRODUCER_ERRORS = (emit.EmitError, source_bundle.SourceBundleError, GoReuseError, ValueError)


def load_body(control, policy, body_file):
    if body_file:
        with open(body_file, "r", encoding="utf-8") as f:
            body = f.read()
        return body, {"state": "OPEN", "number": ISSUE_NUMBER, "author": TRUSTED_LOGIN, "editor": None}
    snap = autorun.fetch(control, policy)
    return snap["body"], {"state": snap.get("state"), "number": snap.get("number"),
                          "author": snap.get("author"), "editor": None}


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--root", required=True, help="yuya 制御プレーンのルート（keys/・wiring.json・control_events）")
    p.add_argument("--in", dest="in_dir", required=True, help="handoff/in（yuya 所有・署名付きジョブを置く）")
    p.add_argument("--bundles-dir", required=True, help="source bundle の置き場（yuya 所有・_kaburun から読める）")
    p.add_argument("--source-repo", required=True, help="bundle を作る元の repo（実行側は読まない。bundle だけ運ぶ）")
    p.add_argument("--cli", required=True, help="_kaburun の固定版 CLI の実体（版の名前のファイル）")
    p.add_argument("--home", required=True, help="_kaburun の HOME")
    p.add_argument("--max-turns", type=int, default=30, help="GO の max_turns（0 < n <= 50）")
    p.add_argument("--expires-in", type=float, default=3600.0, help="GO の有効期限（秒・既定1時間）")
    p.add_argument("--job-ttl", type=float, default=1800.0, help="ジョブ封筒の有効期限（秒・既定30分）")
    p.add_argument("--body-file", help="本文をファイルから読む（省略時は Issue #323 を取得）")
    p.add_argument("--go", action="store_true", help="これを付けたときだけ実際に承認・try_claim・発行する（人の明示の承認）")
    a = p.parse_args(argv)

    root = os.path.realpath(a.root)
    control, policy = autorun.open_control(root)
    body, issue_meta = load_body(control, policy, a.body_file)

    result = meta.validate_task(body, policy)
    if not result.ok:
        print(json.dumps({"ok": False, "reason": "not a runnable phase2 task",
                          "problems": result.problems[:5]}, ensure_ascii=False, indent=2))
        return 2
    f = result.fields
    try:
        bundle = source_bundle.make_source_bundle(os.path.realpath(a.source_repo), f["base_sha"],
                                                  os.path.realpath(a.bundles_dir), f["phase2_approval_id"])
        go = emit.build_go(f, body, os.path.realpath(a.cli), os.path.realpath(a.home),
                           os.path.realpath(a.source_repo), bundle, time.time() + a.expires_in, a.max_turns)
    except PRODUCER_ERRORS as exc:
        print(json.dumps({"ok": False, "stage": "prepare", "reason": str(exc)}, ensure_ascii=False, indent=2))
        return 3

    summary = {"approval_id": f["phase2_approval_id"], "task_id": f.get("task_id"),
               "body_sha256": sha256_hex(body.encode("utf-8")), "task_sha256": f["phase2_task_sha256"],
               "base_ref": f["base_ref"], "base_sha": f["base_sha"], "model_id": f["phase2_model_id"],
               "max_budget_usd": f["max_budget_usd"], "max_minutes": f.get("max_minutes"),
               "production_permission": f["production_permission"], "max_turns": a.max_turns,
               "cli_version": os.path.basename(os.path.realpath(a.cli)), "source_bundle": bundle,
               "go_expires_at": go["expires_at"]}
    if not a.go:
        print(json.dumps(dict(summary, decision="dry_run",
                              note="pass --go to approve the REAL_CLAUDE_GO, try_claim and write the job"),
                         ensure_ascii=False, indent=2))
        return 0

    try:
        out = emit.emit_job(control, body, issue_meta, time.time(), go, os.path.realpath(a.in_dir),
                            job_ttl=a.job_ttl)
    except PRODUCER_ERRORS as exc:
        print(json.dumps({"ok": False, "stage": "emit", "reason": str(exc)}, ensure_ascii=False, indent=2))
        return 3
    print(json.dumps(dict(summary, decision="emitted", run_id=out["run_id"], job_id=out["job_id"],
                          job_path=out["job_path"], go_id=out["go_id"]), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
