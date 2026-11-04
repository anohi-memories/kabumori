"""通知。仕様 v5 §10-5。通知が失敗しても NEEDS_ATTENTION に必ず残す。"""
import json
import os
import subprocess

from .textutil import redact

OSASCRIPT = "/usr/bin/osascript"  # Mac 通知で起動する唯一のシステムツール（固定・絶対パス）
SHARED_WINDOW_BIN = "/Users/Shared/g10-bin/g10_notify_window"  # リリース運用時の窓バイナリ既定置き場（yuya 所有・0755）

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
    """macOS 通知。(1) 通知センターに残るバナー（display notification。スリープしても残る）、(2) 任意で
    ネイティブのテキストボックス窓（swiftc 製バイナリ g10_notify_window）を**切り離して**開く（collector を止めない）。
    窓は普通のウインドウ（最前面固定でない＝裏に回せる）で、OK/Enter を押すまで残る（スリープ後も出たまま）。
    窓バイナリは argv で title/message を受け取る（シェルも AppleScript も介さないので注入の余地がない）。
    窓バイナリが未ビルド/非実行なら窓は出さない（バナーは通知センターに残る）。GUI(aqua) セッションの
    プロセスからのみ画面に出る（LaunchAgent gui/501）。失敗しても False を返すだけ（notify() が NEEDS_ATTENTION に残す）。"""

    def __init__(self, window=True, window_bin=None):
        self.window = window
        self.window_bin = window_bin or os.environ.get("G10_NOTIFY_WINDOW")  # 明示指定（None なら既定探索）

    def _candidates(self):
        """窓バイナリの候補（明示指定があればそれだけ。無ければ パッケージ同梱 → 共有場所）。"""
        if self.window_bin:
            return [self.window_bin]
        return [os.path.join(os.path.dirname(os.path.abspath(__file__)), "g10_notify_window"),
                SHARED_WINDOW_BIN]

    @staticmethod
    def _usable(win):
        """起動してよい窓バイナリか: 実在する通常ファイルで、所有者が自分、group/other 書き込み不可、実行可能。
        （窓はリリース検証外の装飾 UI なので、差し替え防止の軽い整合性チェックを課す。）"""
        import stat as _stat
        try:
            info = os.stat(win)
        except OSError:
            return False
        if not _stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
            return False
        if info.st_mode & (_stat.S_IWGRP | _stat.S_IWOTH):
            return False
        return os.access(win, os.X_OK)

    def __call__(self, title, message):
        ok = self._run_notification(title, message)   # バナー（通知センターに残る）
        if self.window:
            self._open_window(title, message)          # ネイティブ窓（押すまで残る・裏に回せる）
        return ok

    def _run_notification(self, title, message):
        script = "display notification %s with title %s" % (_applescript_str(message), _applescript_str(title))
        try:
            r = subprocess.run([OSASCRIPT, "-e", script], capture_output=True, timeout=10)
            return r.returncode == 0
        except Exception:
            return False

    def _open_window(self, title, message):
        for win in self._candidates():
            if self._usable(win):
                try:  # 引数渡し（シェルも AppleScript も介さない）。押すまで残るので待たない（fire-and-forget）
                    subprocess.Popen([win, title, message],
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                except Exception:
                    pass
                return
        # どの候補も使えない（未ビルド/非実行/所有者不一致）なら窓は出さない（バナーは通知センターに残る）

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
