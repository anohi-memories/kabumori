"""H4 P1（部分観測）・P2（signal直前の再照合）の個別試験（新しいAPI: カーネルと ps の和集合・collector.verify）。"""
import os
import subprocess
import sys
import time
import unittest
from unittest import mock

from g10runner import procs, registry, supervise
from helpers import EnvTestCase, make_body

SESSION = "11111111-2222-3333-4444-555555555555"


def _sleeper(*extra):
    p = subprocess.Popen([sys.executable, "-I", "-c", "import time; time.sleep(30)"] + list(extra),
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.time() + 5
    while time.time() < deadline and procs.start_time(p.pid) is None:
        time.sleep(0.02)
    return p


def _without(pid, real):
    def fn(*a, **kw):
        out = real(*a, **kw)
        if isinstance(out, set):
            return out - {pid}
        return [row for row in out if row["pid"] != pid]
    return fn


class UnionObservation(unittest.TestCase):
    def setUp(self):
        self.settings = "/tmp/g10obs-settings-%d.json" % os.getpid()
        self.ident = procs.RunIdentity(SESSION, self.settings, os.getuid())
        self.p = _sleeper("--session-id", SESSION, "--settings", self.settings)
        self.addCleanup(lambda: (self.p.kill(), self.p.wait()))

    def found(self):
        return [pid for pid, _ in procs.find_run_processes(self.ident)]

    def test_ps_list_missing_target_still_found_via_kernel(self):
        with mock.patch.object(procs, "snapshot", side_effect=_without(self.p.pid, procs.snapshot)):
            self.assertEqual(self.found(), [self.p.pid])

    def test_kernel_list_missing_target_still_found_via_ps(self):
        with mock.patch.object(procs, "kernel_pids", side_effect=_without(self.p.pid, procs.kernel_pids)):
            self.assertEqual(self.found(), [self.p.pid])

    def test_kernel_enumeration_failure_is_unknown(self):
        def broken():
            raise procs.ObservationError("libproc failed")
        with mock.patch.object(procs, "kernel_pids", side_effect=broken):
            with self.assertRaises(procs.ObservationError):
                self.found()

    def test_kernel_enumeration_returning_nothing_is_unknown(self):
        lib = procs._libproc()
        with mock.patch.object(lib, "proc_listallpids", return_value=0):
            with self.assertRaises(procs.ObservationError):
                procs.kernel_pids()


class CollectorVerify(unittest.TestCase):
    """collector の .verify（signal 直前の照合）: 開始時刻・uid・完全な argv。"""

    def setUp(self):
        self.settings = "/tmp/g10obs-settings-%d.json" % os.getpid()
        self.entry = {"run_id": "run-0123456789abcdef", "session_id": SESSION, "settings_path": self.settings,
                      "uid": os.getuid(), "root": "/tmp/g10obs-root", "stub_pid": None, "stub_start": None,
                      "child_pid": None, "child_start": None}
        self.collect = supervise.collector(None, self.entry)

    def test_verify_requires_start_uid_and_argv(self):
        p = _sleeper("--session-id", SESSION, "--settings", self.settings)
        decoy = _sleeper("--session-id", SESSION + "-x", "--settings", self.settings)
        try:
            st = procs.start_time(p.pid)
            self.assertTrue(self.collect.verify(p.pid, st))
            self.assertFalse(self.collect.verify(p.pid, "978307200.000000"))  # pid 再利用（開始時刻が違う）
            self.assertFalse(self.collect.verify(p.pid, None))
            self.assertFalse(self.collect.verify(decoy.pid, procs.start_time(decoy.pid)))  # argv が違う
            other = dict(self.entry, uid=2 ** 31 - 7)
            self.assertFalse(supervise.collector(None, other).verify(p.pid, st))  # uid が違う
        finally:
            for q in (p, decoy):
                q.kill()
                q.wait()


class RegisteredChildDirect(EnvTestCase):
    """両方の一覧が子を欠いても、登録簿の子（pid・開始時刻）を直接確認して止める。"""

    def setUp(self):
        super().setUp()
        self.env.envelope()
        self.env.s2_heartbeat()

    def test_both_lists_missing_child(self):
        run_id, stub, body = self.claim_and_run(body=make_body(self.env.policy, max_minutes="60"),
                                                scenario={"sleep": 30}, wait=False)
        deadline = time.time() + 20
        e = None
        while time.time() < deadline:
            e = registry.load(self.env.layout, run_id)
            if e and e["state"] == "running":
                break
            time.sleep(0.05)
        child = e["child_pid"]
        try:
            with mock.patch.object(procs, "snapshot", side_effect=_without(child, procs.snapshot)), \
                    mock.patch.object(procs, "kernel_pids", side_effect=_without(child, procs.kernel_pids)):
                self.assertIn(child, supervise.collector(self.env.layout, e)())
                absent = supervise.stop_run(self.env.layout, self.env.policy, self.env.agent, e,
                                            "emergency_stop", "test")
            self.assertTrue(absent)
            self.assertNotEqual(procs.pid_status(child), "alive")
        finally:
            try:
                os.kill(child, 9)
            except OSError:
                pass
            stub.wait(timeout=30)


class KernelDisagreement(unittest.TestCase):
    def test_kill_says_alive_but_kernel_has_no_info(self):
        """kill(0) では生存、カーネル情報は無し、ゾンビでもない状態が続くなら unknown（不在としない）。"""
        p = _sleeper()
        try:
            lib = procs._libproc()
            with mock.patch.object(lib, "proc_pidinfo", return_value=0), \
                    mock.patch.object(procs, "_kern_proc_stat", return_value=2):
                with self.assertRaises(procs.ObservationError):
                    procs.kinfo(p.pid)
        finally:
            p.kill()
            p.wait()

    def test_zombie_is_reported_as_zombie(self):
        p = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        try:
            time.sleep(0.2)
            os.kill(p.pid, 9)
            time.sleep(0.3)  # 回収前（ゾンビ）
            self.assertEqual(procs.pid_status(p.pid), "zombie")
        finally:
            p.wait()
        self.assertEqual(procs.pid_status(p.pid), "absent")
