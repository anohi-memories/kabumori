#!/usr/bin/env python3
"""専用ユーザー方式の常駐ジョブ実行の入口（B0-1）。_kaburun の GUI セッションで launchd から回す本体。

  /usr/bin/python3 -I bin/g10_jobrunner.py --root ROOT --in DIR --claims DIR --out DIR --flags DIR \
      --cli CLI --home HOME [--interval 300] [--once] [--wait 600] [--release-digest DIGEST]

- 周期ごとに g10runner.jobrunner で1件だけ処理する（flags/HALT・STOP の確認 → 固定版の検証 → ログイン前チェック →
  handoff/in の署名付きジョブを accept＝human 署名の検証＋at-most-once CLAIM → 実行プレーンで1回起動・終端 →
  結果の束を handoff/out へ agent 署名つきで書き出す）。どこで欠けても起動しない（fail-closed）。
- 固定版（bin/g10_first_run.py install で作る）から動くときは --release-digest が必須で、開始時と各周期の頭で
  固定版を検証する（合わなければ開始しない／その周期は起動しない）。開発 worktree から動かすのは --dev のときだけ（試験用）。
- 同じ out では2つ同時に動かない（排他ロック）。恒久停止は launchctl bootout、緊急停止は yuya が flags/HALT を置く。
- 記録・out には本文・秘密・メールアドレスを書かない。launchd への登録はこの入口では行わない（人の GO の後に人が行う）。
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from g10runner import jobrunner, release, resident  # noqa: E402
from g10runner.fsutil import FileLock, touch  # noqa: E402

PACKAGE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--root", required=True, help="exec プレーンの初期化済みルート（鍵・wiring・ポリシー）")
    p.add_argument("--in", dest="in_dir", required=True, help="handoff/in（yuya 所有・署名付きジョブが届く）")
    p.add_argument("--claims", required=True, help="handoff/claims（_kaburun 所有・CLAIM 跡）")
    p.add_argument("--out", required=True, help="handoff/out（_kaburun 所有・disposition と結果の束）")
    p.add_argument("--flags", required=True, help="handoff/flags（yuya 所有・HALT/STOP）")
    p.add_argument("--cli", required=True, help="_kaburun の固定版 CLI の実体（版の名前のファイル）")
    p.add_argument("--home", required=True, help="_kaburun の HOME")
    p.add_argument("--interval", type=float, default=resident.DEFAULT_INTERVAL)
    p.add_argument("--once", action="store_true", help="1周期だけ回して戻る")
    p.add_argument("--wait", type=float, default=600.0, help="1ランの終端を待つ上限（秒）")
    p.add_argument("--release-digest", help="固定版のマニフェストのハッシュ（固定版から動くときは必須）")
    p.add_argument("--dev", action="store_true", help="開発 worktree からの実行を許す（試験用。plist には使えない）")
    a = p.parse_args(argv)

    manifest = release.package_manifest(PACKAGE)
    if manifest is not None:
        if not a.release_digest:
            raise SystemExit("running from a release needs --release-digest")
        problems = release.verify(PACKAGE, a.release_digest)
        if problems:
            raise SystemExit("release verification failed: %s" % "; ".join(problems[:3]))
        release_check = lambda: release.verify(PACKAGE, a.release_digest)  # noqa: E731
    else:
        if a.release_digest:
            raise SystemExit("--release-digest is only for an installed release")
        if not a.dev:
            raise SystemExit("running the jobrunner from a development tree needs --dev (use an installed release)")
        release_check = None

    if not a.once and a.interval < resident.DEFAULT_INTERVAL:
        raise SystemExit("the resident loop needs --interval >= %d" % int(resident.DEFAULT_INTERVAL))

    out = os.path.realpath(a.out)
    lock_path = os.path.join(out, ".jobrunner.lock")
    touch(lock_path)
    with FileLock(lock_path, "ex", timeout=0) as lock:
        if not lock.acquired:
            raise SystemExit("another jobrunner is already running for this out directory")
        loop = jobrunner.build_loop(a.root, os.path.realpath(a.in_dir), os.path.realpath(a.claims), out,
                                    os.path.realpath(a.flags), os.path.realpath(a.cli), os.path.realpath(a.home),
                                    wait_seconds=a.wait, log_path=os.path.join(out, ".jobrunner.log"),
                                    release_check=release_check)
        max_cycles = 1 if a.once else None
        count = 0
        while max_cycles is None or count < max_cycles:
            record = loop.step()
            print(json.dumps(record, ensure_ascii=False), flush=True)
            count += 1
            if max_cycles is not None and count >= max_cycles:
                break
            time.sleep(a.interval)
    return 0


if __name__ == "__main__":
    sys.exit(main())
