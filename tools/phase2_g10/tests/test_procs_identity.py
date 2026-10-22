"""H3 R2/R3 の単体試験: 観測の失敗（unknown）・正確な識別・pid の再利用・パスの包含。"""
import os
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

from g10runner import layout as layout_mod, procs

SESSION = "11111111-2222-3333-4444-555555555555"


def _sleeper(*extra):
    p = subprocess.Popen([sys.executable, "-I", "-c", "import time; time.sleep(30)"] + list(extra),
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.time() + 5
    while time.time() < deadline and procs.start_time(p.pid) is None:
        time.sleep(0.02)
    return p


class _Completed:
    def __init__(self, returncode, stdout):
        self.returncode = returncode
        self.stdout = stdout


class TestObservationFailures(unittest.TestCase):
    """ps の失敗・異常は「プロセスなし」ではなく ObservationError（unknown）。"""

    def test_ps_oserror_and_timeout(self):
        for exc in (OSError("no ps"), subprocess.TimeoutExpired("ps", 10)):
            with self.subTest(exc=type(exc).__name__):
                with mock.patch.object(procs.subprocess, "run", side_effect=exc):
                    with self.assertRaises(procs.ObservationError):
                        procs.snapshot()

    def test_ps_nonzero_exit(self):
        with mock.patch.object(procs.subprocess, "run", return_value=_Completed(1, "")):
            with self.assertRaises(procs.ObservationError):
                procs.snapshot()

    def test_unparseable_line(self):
        text = "%d 1 1 501 S python\nnot a ps line\n" % os.getpid()
        with mock.patch.object(procs.subprocess, "run", return_value=_Completed(0, text)):
            with self.assertRaises(procs.ObservationError):
                procs.snapshot()

    def test_partial_list_without_own_process(self):
        text = "1 0 1 0 Ss /sbin/launchd\n"
        with mock.patch.object(procs.subprocess, "run", return_value=_Completed(0, text)):
            with self.assertRaises(procs.ObservationError):
                procs.snapshot()

    def test_empty_list_is_not_absence(self):
        with mock.patch.object(procs.subprocess, "run", return_value=_Completed(0, "")):
            with self.assertRaises(procs.ObservationError):
                procs.find_run_processes(procs.RunIdentity(SESSION, "/tmp/x", os.getuid()))

    def test_terminate_reports_unknown_not_absent(self):
        def collect():
            raise procs.ObservationError("ps failed")
        details = procs.terminate(collect, 0.1, 0.1)
        self.assertTrue(details["unknown"])
        self.assertFalse(details["absent"])


class TestIdentity(unittest.TestCase):
    def test_argv_exact_tokens(self):
        settings = tempfile.NamedTemporaryFile(prefix="g10id-", suffix=".json", dir="/tmp", delete=False)
        settings.close()
        other = settings.name + ".other"
        try:
            ident = procs.RunIdentity(SESSION, settings.name, os.getuid())
            ok = ["claude", "--session-id", SESSION, "--settings", settings.name]
            self.assertTrue(procs.argv_matches(ok, ident))
            self.assertTrue(procs.argv_matches(["claude", "--session-id=" + SESSION,
                                                "--settings=" + settings.name], ident))
            cases = {
                "prefix session": ["claude", "--session-id", SESSION + "-DIFFERENT", "--settings", settings.name],
                "session only in another flag": ["claude", "--name", SESSION, "--settings", settings.name],
                "other settings": ["claude", "--session-id", SESSION, "--settings", other],
                "no settings": ["claude", "--session-id", SESSION],
                "two settings": ["claude", "--session-id", SESSION, "--settings", settings.name,
                                 "--settings", other],
                "two sessions": ["claude", "--session-id", SESSION, "--session-id", SESSION + "x",
                                 "--settings", settings.name],
            }
            for name, av in cases.items():
                with self.subTest(case=name):
                    self.assertFalse(procs.argv_matches(av, ident))
        finally:
            os.remove(settings.name)

    def test_live_exact_argv_and_uid(self):
        settings = "/tmp/g10id-settings-%d.json" % os.getpid()
        p = _sleeper("--session-id", SESSION, "--settings", settings)
        decoy = _sleeper("--session-id", SESSION + "-DIFFERENT", "--settings", settings)
        try:
            self.assertEqual(procs.argv(p.pid)[-4:], ["--session-id", SESSION, "--settings", settings])
            found = [pid for pid, _ in procs.find_run_processes(procs.RunIdentity(SESSION, settings, os.getuid()))]
            self.assertEqual(found, [p.pid])
            # どのプロセスも持たない uid の識別子: 一致なし（自分の uid のプロセスは uid の照合で除外される）
            self.assertEqual(procs.find_run_processes(procs.RunIdentity(SESSION, settings, 2 ** 31 - 7)), [])
            self.assertFalse(procs.run_process_matches(p.pid, procs.RunIdentity(SESSION, settings, 2 ** 31 - 7)))
        finally:
            for q in (p, decoy):
                q.kill()
                q.wait()

    def test_foreign_uid_argv_unreadable_is_unknown(self):
        """別uidのプロセスの argv は読めない: 読めないものを「一致しない」とせず ObservationError（unknown）。"""
        foreign = [pid for pid in procs.all_pids() if (procs.kinfo(pid) or {}).get("uid") not in (None, os.getuid())]
        self.assertTrue(foreign, "no foreign-uid process to probe")
        ident_uid = procs.kinfo(foreign[0])["uid"]
        results = []
        for pid in [q for q in foreign if (procs.kinfo(q) or {}).get("uid") == ident_uid][:3]:
            if procs.kinfo(pid):
                try:
                    results.append(procs.run_process_matches(pid, procs.RunIdentity(SESSION, "/tmp/x", ident_uid)))
                except procs.ObservationError:
                    results.append("unknown")
        self.assertIn("unknown", results)
        self.assertNotIn(True, results)

    def test_missing_start_time_is_not_identity(self):
        p = _sleeper()
        try:
            self.assertFalse(procs.identity_ok(p.pid, None))
            self.assertFalse(procs.identity_ok(p.pid, ""))
            self.assertTrue(procs.identity_ok(p.pid, procs.start_time(p.pid)))
        finally:
            p.kill()
            p.wait()

    def test_pid_reuse_start_mismatch_is_not_signalled(self):
        p = _sleeper()
        try:
            stale = "978307200.000000"  # 別のプロセスの開始時刻（pid 再利用を模擬）
            details = {"unknown": False}
            procs._signal_verified({p.pid: stale}, 9, lambda pid, st: procs.start_time(pid) == st, details)
            time.sleep(0.2)
            self.assertIsNone(p.poll(), "signal was sent to a process whose start time did not match")
            self.assertEqual(details.get("skipped"), [p.pid])
        finally:
            p.kill()
            p.wait()

    def test_verify_error_is_unknown_and_not_signalled(self):
        p = _sleeper()
        try:
            def broken(pid, st):
                raise procs.ObservationError("cannot verify")
            details = {"unknown": False}
            procs._signal_verified({p.pid: procs.start_time(p.pid)}, 9, broken, details)
            time.sleep(0.2)
            self.assertIsNone(p.poll())
            self.assertTrue(details["unknown"])
        finally:
            p.kill()
            p.wait()

    def test_terminate_without_verifier_sends_nothing(self):
        p = _sleeper()
        try:
            details = procs.terminate(lambda: {p.pid: procs.start_time(p.pid)}, 0.2, 0.2)
            self.assertTrue(details["unknown"])
            self.assertFalse(details["absent"])
            self.assertIsNone(p.poll())
        finally:
            p.kill()
            p.wait()

    def test_terminate_stops_only_verified_targets(self):
        p = _sleeper()
        try:
            st = procs.start_time(p.pid)
            collect = (lambda: {p.pid: st} if p.poll() is None else {})
            collect.verify = lambda pid, start: procs.start_time(pid) == start
            details = procs.terminate(collect, 2.0, 2.0)
            self.assertTrue(details["absent"])
            self.assertFalse(details["unknown"])
        finally:
            if p.poll() is None:
                p.kill()
            p.wait()


class TestLayoutContainment(unittest.TestCase):
    def test_run_paths_stay_under_their_base(self):
        root = tempfile.mkdtemp(prefix="g10lay-", dir="/tmp")
        outside = tempfile.mkdtemp(prefix="g10out-", dir="/tmp")
        try:
            lay = layout_mod.Layout(root).ensure()
            good = "run-0123456789abcdef"
            self.assertEqual(os.path.dirname(lay.run_dir(good)), lay.runs)
            for bad in ("../x", "/etc", "run-0123456789abcdef/../../x", "run-0123456789ABCDEF", "", None):
                with self.subTest(bad=bad):
                    for fn in (lay.run_dir, lay.work_dir, lay.proc_file, lay.request_file):
                        with self.assertRaises(layout_mod.LayoutError):
                            fn(bad)
            link = "run-00000000000000ee"
            os.symlink(outside, os.path.join(lay.runs, link))  # シンボリックリンクでの逸脱
            with self.assertRaises(layout_mod.LayoutError):
                lay.run_dir(link)
        finally:
            import shutil
            shutil.rmtree(root, ignore_errors=True)
            shutil.rmtree(outside, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
