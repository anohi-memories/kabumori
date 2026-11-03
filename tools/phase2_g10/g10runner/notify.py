"""通知。仕様 v5 §10-5。通知が失敗しても NEEDS_ATTENTION に必ず残す。"""
import json
import os
import subprocess

from .textutil import redact

OSASCRIPT = "/usr/bin/osascript"  # Mac 通知で起動する唯一のシステムツール（固定・絶対パス）

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


def _applescript_str(s):
    """AppleScript の文字列リテラルに安全に埋める（", \\, 改行をエスケープ/除去）。osascript は -e で1引数に渡す。"""
    return '"' + str(s).replace("\\", "\\\\").replace('"', '\\"').replace("\n", " ").replace("\r", " ") + '"'


class MacNotifier:
    """macOS 通知。(1) 通知センターに残るバナー（display notification。スリープしても残る）、(2) 任意でテキストダイアログ
    （display dialog）を**切り離して**出す（collector を止めない）。ダイアログは既定で **押すまで消えない**
    （dialog_timeout=0。スリープに入っても、起きたとき出たまま待つ）。dialog_timeout>0 を渡したときだけ
    `giving up after` で自動クローズする。GUI(aqua) セッションのプロセスからのみ画面に出る（LaunchAgent gui/501）。
    osascript をリスト形式で呼ぶのでシェルは介さない。失敗しても False を返すだけ（notify() が NEEDS_ATTENTION に残す）。"""

    def __init__(self, dialog=True, dialog_timeout=0):
        self.dialog = dialog
        self.dialog_timeout = int(dialog_timeout)

    def __call__(self, title, message):
        ok = self._run_notification(title, message)
        if self.dialog:
            self._open_dialog(title, message)
        return ok

    def _run_notification(self, title, message):
        script = "display notification %s with title %s" % (_applescript_str(message), _applescript_str(title))
        try:
            r = subprocess.run([OSASCRIPT, "-e", script], capture_output=True, timeout=10)
            return r.returncode == 0
        except Exception:
            return False

    def _open_dialog(self, title, message):
        giveup = (" giving up after %d" % self.dialog_timeout) if self.dialog_timeout > 0 else ""
        script = ('display dialog %s with title %s buttons {"OK"} default button "OK" with icon note%s'
                  % (_applescript_str(message), _applescript_str(title), giveup))
        try:  # fire-and-forget: timeout=0 なら押すまで残る（スリープ後も出たまま）。collector は待たない
            subprocess.Popen([OSASCRIPT, "-e", script],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            pass


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
