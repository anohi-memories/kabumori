#!/usr/bin/env python3
"""notice-dispatch 無人ディスパッチャ（yuya 側・gui/501）。

共通「お知らせイシュー」#639 のコメントを周期ごとに読み、差分のあった枠だけオンデマンドで
その枠の producer.emit_ready を呼ぶ（お知らせは『どの枠を見るか』の合図。実行可否は emit_ready が
envelope/未消費承認/task_sha/envelope_covers で自己判定＝お知らせ改ざんは fail-closed）。
低頻度の全枠スイープ（--sweep-every ティックに1回）で、お知らせ記入漏れを保険。cursor はファイル保存。

  /usr/bin/python3 -I bin/g10_dispatcher.py --registry R.json --cursor-file C.json \
      [--interval 120] [--sweep-every 30] [--once] [--live] [--release-digest D] [--max-turns 30]

実 Claude は呼ばない（emit は handoff 経由で各枠の常駐が実行）。同じ cursor-file で2つ同時は不可（排他ロック）。
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from g10runner import autorun, dispatch, notice_source, notify, producer, release  # noqa: E402
from g10runner.fsutil import FileLock, touch  # noqa: E402

MIN_INTERVAL = 120.0          # 2 分。#639 を 1 req/tick ＝ 30 req/時（匿名 60/時の内側）
_REQUIRED_KEYS = ("root", "in", "bundles", "source_repo", "cli", "home")


def load_registry(path):
    with open(path, encoding="utf-8") as f:
        reg = json.load(f)
    if not isinstance(reg, dict) or not reg:
        raise SystemExit("registry must be a non-empty object {slot: {...}}")
    for slot, cfg in reg.items():
        if not dispatch.SLOT_RE.match(slot):
            raise SystemExit("registry has a non-slot key: %r" % slot)
        missing = [k for k in _REQUIRED_KEYS if k not in cfg]
        if missing:
            raise SystemExit("registry[%s] missing %s" % (slot, missing))
        for k in _REQUIRED_KEYS:
            if not os.path.isabs(cfg[k]):
                raise SystemExit("registry[%s][%s] must be an absolute path" % (slot, k))
    return reg


def load_cursor(path):
    try:
        with open(path, encoding="utf-8") as f:
            c = json.load(f)
        return {"id": int(c.get("id") or 0), "ts": c.get("ts")}
    except (OSError, ValueError):
        return {"id": 0, "ts": None}


def save_cursor(path, cursor):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"id": int(cursor.get("id") or 0), "ts": cursor.get("ts")}, f)
        f.flush()
        os.fsync(f.fileno())
    os.rename(tmp, path)


def make_emit_slot(registry, live, max_turns, ask_envelope=True):
    """slot -> producer.emit_ready（--live）/ evaluate（dry）。お知らせは合図だけ。実行可否は各枠が自己判定。
    ask_envelope のとき、notice で新タスクが来たのに envelope が無ければ、確認ダイアログで本日分の許可を聞く
    （「許可」クリックで readonly_trial 日次窓を発行→再 emit）。sweep では聞かない。"""
    def _slim(rec):
        return {k: rec.get(k) for k in ("decision", "reason", "approval_id", "run_id") if k in rec}

    def _emit(cfg, control, policy):
        return producer.emit_ready(control, policy, cfg["in"], cfg["bundles"], cfg["source_repo"],
                                   cfg["cli"], cfg["home"], max_turns=max_turns)

    def emit(slot, reason):
        cfg = registry[slot]
        control, policy = autorun.open_control(cfg["root"])
        if not live:
            return _slim(producer.evaluate(control, policy))
        rec = _emit(cfg, control, policy)
        if ask_envelope and dispatch.wants_envelope_prompt(_slim(rec), reason):
            msg = ("%s に新しいタスクがあります。本日の自動実行を許可しますか？\n"
                   "読み取り専用・MAX 利用枠を使用・本日 04:00(JST) まで有効。" % slot)
            choice = notify.ask("%s 自動実行の許可" % slot, msg, ["却下", "許可"], timeout=300.0)
            if choice == 1:                       # 許可（右端）＝人の明示的な同意
                producer.approve_trial_envelope(control, policy)
                rec = _emit(cfg, control, policy)
        producer.record(control.layout, rec)
        return _slim(rec)
    return emit


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--registry", required=True)
    p.add_argument("--cursor-file", required=True)
    p.add_argument("--interval", type=float, default=MIN_INTERVAL)
    p.add_argument("--sweep-every", type=int, default=30, help="このティック数に1回だけ全枠を直接スイープ（記入漏れの保険）")
    p.add_argument("--once", action="store_true")
    p.add_argument("--live", action="store_true", help="条件がそろえば実際に emit（既定は dry-run）")
    p.add_argument("--release-digest")
    p.add_argument("--max-turns", type=int, default=30)
    p.add_argument("--no-ask-envelope", dest="ask_envelope", action="store_false",
                   help="新タスク時に envelope 許可ダイアログを出さない（既定は出す）")
    a = p.parse_args(argv)

    package = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if release.package_manifest(package) is not None:
        if not a.release_digest:
            raise SystemExit("running from a release needs --release-digest")
        problems = release.verify(package, a.release_digest)
        if problems:
            raise SystemExit("release verification failed: %s" % "; ".join(problems[:3]))
    elif a.release_digest:
        raise SystemExit("--release-digest is only for an installed release")
    if a.live and not a.once and a.interval < MIN_INTERVAL:
        raise SystemExit("--live needs --interval >= %d" % MIN_INTERVAL)

    registry = load_registry(os.path.realpath(a.registry))
    allowlist = frozenset(registry)
    cursor_path = os.path.realpath(a.cursor_file)
    emit_slot = make_emit_slot(registry, bool(a.live), a.max_turns, ask_envelope=a.ask_envelope)

    touch(cursor_path + ".lock")
    with FileLock(cursor_path + ".lock", "ex", timeout=0) as lock:
        if not lock.acquired:
            raise SystemExit("another dispatcher is already running for this cursor file")
        tick = 0
        while True:
            tick += 1
            sweep = a.sweep_every > 0 and tick % a.sweep_every == 0
            sweep_slots = sorted(allowlist) if sweep else ()
            cursor = load_cursor(cursor_path)
            try:
                result = dispatch.run_cycle(
                    lambda since: notice_source.fetch_comments(since=since),
                    cursor, allowlist, emit_slot, sweep_slots=sweep_slots)
            except Exception as exc:  # 取得・emit の失敗で止めない（次周期で再試行）
                print(json.dumps({"error": "%s: %s" % (type(exc).__name__, exc)}, ensure_ascii=False))
            else:
                save_cursor(cursor_path, result["cursor"])
                print(json.dumps({"live": bool(a.live), "sweep": sweep, "cursor": result["cursor"],
                                  "checked": result["checked"]}, ensure_ascii=False))
            if a.once:
                return 0
            time.sleep(max(a.interval, MIN_INTERVAL))


if __name__ == "__main__":
    sys.exit(main())
