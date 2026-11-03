"""MacNotifier（macOS 通知）の単体試験。osascript は mock する（実際に画面へ出さない）。

確認: (1) 通知センターのバナー（display notification）を osascript にリスト形式で渡す、(2) テキストダイアログ
（display dialog・giving up）を Popen で**切り離して**出す、(3) 文字列は AppleScript リテラルにエスケープされる
（" や \\ や改行でスクリプトが壊れない／注入されない）、(4) osascript が失敗/例外でも False を返すだけで落ちない。"""
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

    def test_notification_and_dialog_both_use_osascript(self):
        calls, fake_run, FakePopen = self._capture()
        with mock.patch.object(notify.subprocess, "run", side_effect=fake_run), \
             mock.patch.object(notify.subprocess, "Popen", FakePopen):
            ok = notify.MacNotifier()("G10 完了", "task passed")
        self.assertTrue(ok)
        self.assertEqual(len(calls["run"]), 1)                 # バナーはちょうど1回
        self.assertEqual(len(calls["popen"]), 1)               # ダイアログは切り離して1回
        run_cmd = calls["run"][0]
        self.assertEqual(run_cmd[0], "/usr/bin/osascript")     # シェルを介さずリスト形式
        self.assertEqual(run_cmd[1], "-e")
        self.assertIn("display notification", run_cmd[2])
        self.assertIn("display dialog", calls["popen"][0][2])

    def test_strings_are_escaped_for_applescript(self):
        calls, fake_run, FakePopen = self._capture()
        with mock.patch.object(notify.subprocess, "run", side_effect=fake_run), \
             mock.patch.object(notify.subprocess, "Popen", FakePopen):
            notify.MacNotifier()('ti"tle', 'a"b\\c\nd')
        script = calls["run"][0][2]
        self.assertIn('\\"', script)                           # " はエスケープ
        self.assertIn('\\\\', script)                          # \\ は二重化
        self.assertNotIn("\n", script)                         # 改行は除去（1行スクリプト）

    def test_dialog_persists_by_default_no_auto_close(self):
        calls, fake_run, FakePopen = self._capture()
        with mock.patch.object(notify.subprocess, "run", side_effect=fake_run), \
             mock.patch.object(notify.subprocess, "Popen", FakePopen):
            notify.MacNotifier()("t", "m")                     # 既定 dialog_timeout=0
        script = calls["popen"][0][2]
        self.assertIn("display dialog", script)
        self.assertNotIn("giving up after", script)            # 自動で閉じない＝押すまで残る

    def test_dialog_timeout_is_honored_when_set(self):
        calls, fake_run, FakePopen = self._capture()
        with mock.patch.object(notify.subprocess, "run", side_effect=fake_run), \
             mock.patch.object(notify.subprocess, "Popen", FakePopen):
            notify.MacNotifier(dialog_timeout=90)("t", "m")
        self.assertIn("giving up after 90", calls["popen"][0][2])  # >0 のときだけ自動クローズ

    def test_dialog_can_be_disabled(self):
        calls, fake_run, FakePopen = self._capture()
        with mock.patch.object(notify.subprocess, "run", side_effect=fake_run), \
             mock.patch.object(notify.subprocess, "Popen", FakePopen):
            ok = notify.MacNotifier(dialog=False)("t", "m")
        self.assertTrue(ok)
        self.assertEqual(len(calls["popen"]), 0)               # dialog=False ならダイアログは出さない

    def test_osascript_failure_returns_false_without_raising(self):
        calls, fake_run, FakePopen = self._capture(returncode=1)
        with mock.patch.object(notify.subprocess, "run", side_effect=fake_run), \
             mock.patch.object(notify.subprocess, "Popen", FakePopen):
            ok = notify.MacNotifier()("t", "m")
        self.assertFalse(ok)                                   # returncode!=0 → False

    def test_osascript_exception_returns_false(self):
        calls, fake_run, FakePopen = self._capture(run_raises=OSError("boom"))
        with mock.patch.object(notify.subprocess, "run", side_effect=fake_run), \
             mock.patch.object(notify.subprocess, "Popen", FakePopen):
            ok = notify.MacNotifier()("t", "m")
        self.assertFalse(ok)                                   # 例外でも落ちない


if __name__ == "__main__":
    unittest.main()
