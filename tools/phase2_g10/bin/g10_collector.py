#!/usr/bin/env python3
"""無人 collector（専用ユーザー分割・yuya 側・B6）。handoff/out を周期ごとに走査し、CLAIM 済み未終了の run を締める。

  /usr/bin/python3 -I bin/g10_collector.py --root ROOT --out OUT [--interval 300] [--once] [--live] [--release-digest DIGEST]

- 結果バンドルがあれば ingest→finalize(ingested)→REPORT、disposition だけ（exec 拒否/不在）なら close_absent で枠を解放。
  --live のときだけ台帳に書く（既定は予定の表示のみ）。実 Claude は呼ばない（締めるだけ）。
- 同じ root で2つ同時は不可（排他ロック）。止めるのは Ctrl-C / launchctl bootout。
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from g10runner import autorun, notify, producer, release  # noqa: E402
from g10runner.fsutil import FileLock, touch  # noqa: E402


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--root", required=True)
    p.add_argument("--out", required=True, help="handoff/out（_kaburun 所有・yuya 読み）")
    p.add_argument("--interval", type=float, default=producer.MIN_INTERVAL)
    p.add_argument("--once", action="store_true")
    p.add_argument("--live", action="store_true", help="台帳に書いて締める（既定は予定の表示のみ）")
    p.add_argument("--release-digest")
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
    lock_path = os.path.join(root, "control", "priv", "collector.lock")
    touch(lock_path)
    with FileLock(lock_path, "ex", timeout=0) as lock:
        if not lock.acquired:
            raise SystemExit("another collector is already running for this root")
        control, _policy = autorun.open_control(root)
        control.notifier = notify.MacNotifier()  # 完了/HALT を Mac の通知センター＋ダイアログに出す
        out_dir = os.path.realpath(a.out)
        while True:
            try:
                results = producer.collect_once(control, out_dir, bool(a.live))
            except Exception as exc:  # 1件の失敗で止めない（次周期で再試行）
                results = [{"action": "error", "reason": "%s: %s" % (type(exc).__name__, exc)}]
            print(json.dumps({"written": bool(a.live), "closed": results}, ensure_ascii=False))
            if a.once:
                return 0
            time.sleep(max(a.interval, producer.MIN_INTERVAL))


if __name__ == "__main__":
    sys.exit(main())
