"""MacNotifier（macOS 通知）の単体試験。osascript と窓バイナリの起動は mock する（実際に画面へ出さない）。

確認:
  (1) バナー（通知センターに残る）は固定の osascript に display notification を渡す。
  (2) バナーの文字列は AppleScript リテラルにエスケープされる（" / \\ / 改行でスクリプトが壊れない／注入されない）。
  (3) テキストボックス窓は、**実在する実行可能ファイル**のときだけ、argv で title/message を渡して起動する
      （シェルも AppleScript も介さない＝注入の余地がない）。未ビルド/非実行なら起動しない（バナーは残る）。
  (4) window=False で窓を出さない。osascript 失敗/例外でも False を返すだけで落ちない。"""
import os
import stat
import tempfile
import unittest
from unittest import mock

from g10runner import notify


class MacNotifierTest(unittest.TestCase):
    def _capture(self, returncode=0, run_raises=None):
        calls = {"run": [], "popen": []}

        def fake_run(cmd, **kw):
            calls["run"].append(cmd)
            if run_raises:
                raise run_raises
            m = mock.Mock()
            m.returncode = returncode
            return m

        class FakePopen:
            def __init__(self, cmd, **kw):
                calls["popen"].append(cmd)

        return calls, fake_run, FakePopen

    def _executable(self):
        fd, path = tempfile.mkstemp(prefix="g10win-")
        os.close(fd)
        os.chmod(path, 0o755)
        self.addCleanup(os.remove, path)
        return path

    def _run(self, notifier, returncode=0, run_raises=None):
        calls, fake_run, FakePopen = self._capture(returncode, run_raises)
        with mock.patch.object(notify.subprocess, "run", side_effect=fake_run), \
             mock.patch.object(notify.subprocess, "Popen", FakePopen):
            ok = notifier("✅ 完了", "task passed")
        return ok, calls

    def test_banner_uses_fixed_osascript_notification(self):
        win = self._executable()
        ok, calls = self._run(notify.MacNotifier(window_bin=win))
        self.assertTrue(ok)
        self.assertEqual(len(calls["run"]), 1)
        self.assertEqual(calls["run"][0][0], notify.OSASCRIPT)   # 固定の /usr/bin/osascript
        self.assertEqual(calls["run"][0][1], "-e")
        self.assertIn("display notification", calls["run"][0][2])

    def test_banner_strings_are_escaped_for_applescript(self):
        calls, fake_run, FakePopen = self._capture()
        with mock.patch.object(notify.subprocess, "run", side_effect=fake_run), \
             mock.patch.object(notify.subprocess, "Popen", FakePopen):
            notify.MacNotifier(window=False)('ti"tle', 'a"b\\c\nd')
        script = calls["run"][0][2]
        self.assertIn('\\"', script)                            # " はエスケープ
        self.assertIn('\\\\', script)                           # \\ は二重化
        self.assertNotIn("\n", script)                          # 改行は除去（1行スクリプト）

    def test_window_launched_with_argv_when_executable(self):
        win = self._executable()
        ok, calls = self._run(notify.MacNotifier(window_bin=win))
        self.assertEqual(len(calls["popen"]), 1)
        self.assertEqual(calls["popen"][0], [win, "✅ 完了", "task passed"])  # argv 渡し（注入の余地なし）

    def test_window_not_launched_when_binary_missing(self):
        missing = os.path.join(tempfile.gettempdir(), "g10-no-such-window-bin")
        ok, calls = self._run(notify.MacNotifier(window_bin=missing))
        self.assertEqual(calls["popen"], [])                    # 未ビルドなら窓は出さない
        self.assertTrue(ok)                                     # バナーは出る

    def test_window_not_launched_when_not_executable(self):
        fd, path = tempfile.mkstemp(prefix="g10noexec-")
        os.close(fd)
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)             # 実行ビット無し
        self.addCleanup(os.remove, path)
        ok, calls = self._run(notify.MacNotifier(window_bin=path))
        self.assertEqual(calls["popen"], [])                    # 非実行ファイルは起動しない

    def test_window_not_launched_when_group_or_world_writable(self):
        fd, path = tempfile.mkstemp(prefix="g10ww-")
        os.close(fd)
        os.chmod(path, 0o757)                                   # other に書き込み権（差し替え余地）
        self.addCleanup(os.remove, path)
        ok, calls = self._run(notify.MacNotifier(window_bin=path))
        self.assertEqual(calls["popen"], [])                    # 書き込み可なら起動しない

    def test_window_can_be_disabled(self):
        win = self._executable()
        ok, calls = self._run(notify.MacNotifier(window=False, window_bin=win))
        self.assertEqual(calls["popen"], [])                    # window=False なら窓を出さない
        self.assertTrue(ok)

    def test_banner_failure_returns_false(self):
        win = self._executable()
        ok, calls = self._run(notify.MacNotifier(window_bin=win), returncode=1)
        self.assertFalse(ok)

    def test_banner_exception_returns_false(self):
        win = self._executable()
        ok, calls = self._run(notify.MacNotifier(window_bin=win), run_raises=OSError("boom"))
        self.assertFalse(ok)


if __name__ == "__main__":
    unittest.main()
