"""B6: procs._ps のタイムアウト堅牢化。ps(-axww) の一時タイムアウトは負荷スパイクのことがあるので1回再試行してから
ObservationError にする（毎周期 observation_unavailable→3連続→exec 自己HALT、を誘発しないため）。timeout も延長。"""
import subprocess
import unittest
from unittest import mock

from g10runner import procs


class PsRobustness(unittest.TestCase):
    def test_retries_once_on_timeout_then_succeeds(self):
        calls = []

        def fake_run(cmd, **kw):
            calls.append(kw.get("timeout"))
            if len(calls) == 1:
                raise subprocess.TimeoutExpired(cmd, kw.get("timeout"))
            m = mock.Mock(); m.returncode = 0; m.stdout = "ok"
            return m
        with mock.patch.object(procs.subprocess, "run", side_effect=fake_run):
            rc, out = procs._ps(["-axww"])
        self.assertEqual((rc, out), (0, "ok"))
        self.assertEqual(len(calls), 2)                  # 1回だけ再試行して成功
        self.assertGreaterEqual(calls[0], 20)            # timeout は 10 から延長済み

    def test_persistent_timeout_retries_then_raises_observation_error(self):
        calls = []

        def always_timeout(cmd, **kw):
            calls.append(1)
            raise subprocess.TimeoutExpired(cmd, kw.get("timeout"))
        with mock.patch.object(procs.subprocess, "run", side_effect=always_timeout):
            with self.assertRaises(procs.ObservationError):
                procs._ps(["-axww"])
        self.assertEqual(len(calls), 2)                  # 1回再試行してから ObservationError（計2回試す）

    def test_oserror_is_not_retried(self):
        calls = []

        def oserr(cmd, **kw):
            calls.append(1)
            raise OSError("boom")
        with mock.patch.object(procs.subprocess, "run", side_effect=oserr):
            with self.assertRaises(procs.ObservationError):
                procs._ps(["-axww"])
        self.assertEqual(len(calls), 1)                  # OSError は再試行しない（即 ObservationError）


if __name__ == "__main__":
    unittest.main()
