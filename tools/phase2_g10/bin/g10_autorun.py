#!/usr/bin/env python3
"""無人の検知と監督付き1回起動の入口（TASK 21）。既定は dry-run（判定と記録だけで、起動しない）。

  /usr/bin/python3 -I bin/g10_autorun.py --root ROOT [--interval 300] [--once] [--live]

- 周期ごとに g10runner.autorun.cycle を1回行う。起動の条件（人の REAL_CLAUDE_GO・S2 の生存・ログイン・未使用の承認・
  HALT なし など）は g10runner/autorun.py の冒頭のとおり。--live のときだけ、条件がそろえば1回起動する。
- --live で繰り返すときの間隔は 300秒以上（認証なしの GitHub の取得の上限に収めるため）。
- 同じルートで2つ同時には動かない（排他ロック）。止めるときは Ctrl-C、緊急時は `bin/g10_first_run.py halt`。
- launchd への登録はしない（登録は人の明示の GO の後に人が行う。README §9-5）。
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from g10runner import autorun  # noqa: E402
from g10runner.fsutil import FileLock, touch  # noqa: E402


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--root", required=True)
    p.add_argument("--interval", type=float, default=autorun.MIN_LIVE_INTERVAL)
    p.add_argument("--once", action="store_true")
    p.add_argument("--live", action="store_true", help="条件がそろえば実際に1回起動する（既定は dry-run）")
    a = p.parse_args(argv)
    root = os.path.realpath(a.root)
    if a.live and not a.once and a.interval < autorun.MIN_LIVE_INTERVAL:
        raise SystemExit("--live needs --interval >= %d" % autorun.MIN_LIVE_INTERVAL)
    lock_path = os.path.join(root, "control", "priv", "autorun.lock")
    touch(lock_path)
    with FileLock(lock_path, "ex", timeout=0) as lock:
        if not lock.acquired:
            raise SystemExit("another autorun is already running for this root")
        control, policy = autorun.open_control(root)
        while True:
            entry = autorun.cycle(control, policy, a.live)
            print(json.dumps(dict(entry, mode="live" if a.live else "dry_run"), ensure_ascii=False), flush=True)
            if a.once:
                return 0 if entry["decision"] != "launched" or entry.get("status") == "ended_checks_passed" else 1
            time.sleep(a.interval)


if __name__ == "__main__":
    sys.exit(main())
