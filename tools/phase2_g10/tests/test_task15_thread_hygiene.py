"""TASK 15 項目4: 遅延 HALT などの制御スレッドが、後片付け（一時フォルダの削除）の後に動き続けてフォルダを作り直す問題の是正。

- 正例: 制御スレッドの終了待ちは、一時フォルダの削除より前に必ず動く（後片付けの順序）。
- 負例: 終わらないスレッドは失敗になり、一時フォルダは消さずに残す（消すと同じパスに作り直されるため）。
- 負例: スレッドの中の例外は失敗になる（握りつぶさない）。
"""
import os
import shutil
import threading
import time
import unittest

from helpers import EnvTestCase


class _Probe(EnvTestCase):
    """内側で走らせる試験（メソッド名が test_ でないので直接は集められない）。遅れて一時フォルダに書き込むスレッドを始める。"""
    delay = 0.3
    seen = {}

    def probe(self):
        tmp = self.env.tmp
        _Probe.seen["tmp"] = tmp

        def late_write():
            time.sleep(self.delay)
            os.makedirs(os.path.join(tmp, "control", "priv"), exist_ok=True)
            with open(os.path.join(tmp, "control", "priv", "NEEDS_ATTENTION.jsonl"), "a") as f:
                f.write("{}\n")
        self.start_control_thread(late_write)


def _run(case_cls, name):
    result = unittest.TestResult()
    case_cls(name).run(result)
    return result


class ThreadHygiene(unittest.TestCase):
    def test_cleanup_waits_for_the_thread_before_removing_the_temp_dir(self):
        result = _run(_Probe, "probe")
        self.addCleanup(shutil.rmtree, _Probe.seen["tmp"], True)  # 壊れたときに作り直されたフォルダも残さない
        self.assertTrue(result.wasSuccessful(), result.errors + result.failures)
        time.sleep(_Probe.delay * 2)
        self.assertFalse(os.path.exists(_Probe.seen["tmp"]), "a control thread re-created the temp dir after cleanup")

    def test_thread_that_does_not_finish_fails_and_keeps_the_temp_dir(self):
        release = threading.Event()

        class Stuck(_Probe):
            control_thread_join_timeout = 0.2

            def probe(self):
                _Probe.seen["tmp"] = self.env.tmp
                self.start_control_thread(lambda: release.wait(10))
        try:
            result = _run(Stuck, "probe")
            problems = result.failures + result.errors
            self.assertEqual(len(problems), 1, "a stuck control thread was hidden")
            self.assertIn("did not finish", problems[0][1])
            self.assertTrue(os.path.isdir(_Probe.seen["tmp"]), "the temp dir was removed while a thread was running")
        finally:
            release.set()
            time.sleep(0.1)
            shutil.rmtree(_Probe.seen["tmp"], ignore_errors=True)

    def test_exception_in_the_thread_is_a_failure(self):
        class Raising(_Probe):
            def probe(self):
                def boom():
                    raise RuntimeError("halt failed in the thread")
                self.start_control_thread(boom)
        result = _run(Raising, "probe")
        problems = result.failures + result.errors
        self.assertEqual(len(problems), 1)
        self.assertIn("halt failed in the thread", problems[0][1])


if __name__ == "__main__":
    unittest.main()
