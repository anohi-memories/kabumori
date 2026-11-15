#!/usr/bin/env python3
"""無人 producer（専用ユーザー分割・yuya 側・B6）。既定は dry-run（判定と記録だけ・emit しない）。

  /usr/bin/python3 -I bin/g10_producer.py --root ROOT --in IN --bundles-dir BUNDLES --source-repo REPO \
      --cli CLI --home HOME [--interval 300] [--once] [--live] [--release-digest DIGEST] [--max-turns 30]

- 周期ごとに g10runner.producer を1回評価する。有効な ENVELOPE（人の日次同意）の下で、Issue #323 の ready・
  未claim・窓内の phase2 TASK があれば、--live のとき署名ジョブを handoff/in へ emit する（実行は exec の resident）。
- per-run の人 GO は要らない（ENVELOPE が同意境界）。無人で消費するのは MAX 利用枠（トークン）で金銭課金ではない。
- --live で繰り返すときの間隔は 300 秒以上（認証なし GitHub の取得上限に収める）。同じ root で2つ同時は不可（排他ロック）。
- 止めるのは Ctrl-C / launchctl bootout、緊急時は bin/g10_first_run.py halt。cli・home は exec 側のパス（yuya では解決しない）。
- 固定版から動くときは --release-digest 必須（開始時に検証）。
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from g10runner import autorun, producer, release  # noqa: E402
from g10runner.fsutil import FileLock, touch  # noqa: E402


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--root", required=True)
    p.add_argument("--in", dest="in_dir", required=True)
    p.add_argument("--bundles-dir", required=True)
    p.add_argument("--source-repo", required=True)
    p.add_argument("--cli", required=True, help="exec 側の固定版 CLI の絶対パス（yuya では解決しない）")
    p.add_argument("--home", required=True, help="exec 側の HOME（yuya では解決しない）")
    p.add_argument("--interval", type=float, default=producer.MIN_INTERVAL)
    p.add_argument("--once", action="store_true")
    p.add_argument("--live", action="store_true", help="条件がそろえば実際に emit する（既定は dry-run）")
    p.add_argument("--release-digest", help="固定版のマニフェストのハッシュ（固定版から動くときは必須）")
    p.add_argument("--max-turns", type=int, default=30)
    a = p.parse_args(argv)
    root = os.path.realpath(a.root)
    package = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if release.package_manifest(package) is not None:
        if not a.release_digest:
            raise SystemExit("running from a release needs --release-digest")
        problems = release.verify(package, a.release_digest)
        if problems:
            raise SystemExit("release verification failed: %s" % "; ".join(problems[:3]))
    elif a.release_digest:
        raise SystemExit("--release-digest is only for an installed release")
    if a.live and not a.once and a.interval < producer.MIN_INTERVAL:
        raise SystemExit("--live needs --interval >= %d" % producer.MIN_INTERVAL)
    lock_path = os.path.join(root, "control", "priv", "producer.lock")
    touch(lock_path)
    with FileLock(lock_path, "ex", timeout=0) as lock:
        if not lock.acquired:
            raise SystemExit("another producer is already running for this root")
        control, policy = autorun.open_control(root)
        in_dir = os.path.realpath(a.in_dir)
        bundles_dir = os.path.realpath(a.bundles_dir)
        source_repo = os.path.realpath(a.source_repo)
        while True:
            try:
                if a.live:
                    rec = producer.emit_ready(control, policy, in_dir, bundles_dir, source_repo,
                                              a.cli, a.home, max_turns=a.max_turns)
                else:
                    rec = producer.evaluate(control, policy)
            except Exception as exc:  # 取得・bundle・emit の失敗は emit せずに記録（止めない）
                rec = {"decision": "error", "reason": "%s: %s" % (type(exc).__name__, exc)}
            producer.record(control.layout, rec)
            print(json.dumps({k: rec.get(k) for k in ("decision", "reason", "approval_id", "run_id", "job_path")
                              if k in rec}, ensure_ascii=False))
            if a.once:
                return 0
            time.sleep(max(a.interval, producer.MIN_INTERVAL))


if __name__ == "__main__":
    sys.exit(main())
