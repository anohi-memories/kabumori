"""通知。仕様 v5 §10-5。通知が失敗しても NEEDS_ATTENTION に必ず残す。"""
import json
import os

from .textutil import redact

SYMBOLS = {
    "ended_checks_passed": "✅",
    "ended_checks_failed": "❌",
    "runner_error": "❌",
    "runner_crashed": "❌",
    "needs_input": "⚠️",
    "interrupted": "⏸",
    "stop_unconfirmed": "⛔",
    "halt": "⛔",
    "hold": "🚫",
}
FOOTER = "（通知は実行の終了の知らせで、受入ではありません。K10は担当ちゃの判定）"


class RecordingNotifier:
    """試験用。送った通知を記録する。fail=True なら失敗を返す。"""

    def __init__(self, fail=False):
        self.sent = []
        self.fail = fail

    def __call__(self, title, message):
        self.sent.append((title, message))
        return not self.fail


def notify(layout, notifier, kind, title, message):
    symbol = SYMBOLS.get(kind, "")
    full_title = redact("%s %s" % (symbol, title)).strip()
    full_message = redact("%s %s" % (message, FOOTER if kind != "hold" else "")).strip()
    ok = False
    try:
        ok = bool(notifier(full_title, full_message))
    except Exception:  # 通知の失敗で処理を止めない
        ok = False
    if kind != "ended_checks_passed" or not ok:
        with open(layout.needs_attention, "a", encoding="utf-8") as f:
            f.write(json.dumps({"kind": kind, "title": full_title, "message": full_message,
                                "notified": ok}, ensure_ascii=False) + "\n")
            f.flush()
            os.fsync(f.fileno())
    return ok
