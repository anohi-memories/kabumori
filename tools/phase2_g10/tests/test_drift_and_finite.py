"""H3 C3 の個別試験: 既知のプロセスの識別の変化（identity_drift）と、時刻・数値の有限性。"""
import hashlib
import hmac
import json
import math
import os
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

from g10runner import chainlog, issue as issue_mod, jstclock, logs, procs, registry, signing, supervise
from g10runner import binding, policy as policy_mod
from g10runner.control import Control
from g10runner.fsutil import canonical, read_json
from g10runner.layout import Layout
from helpers import EnvTestCase, FAST_TIMING, TRUSTED_ISSUE, make_body, test_policy

NON_FINITE = (math.nan, math.inf, -math.inf)
BAD_TIMES = NON_FINITE + (True, False, "123", None, 0, -5)


def _sleeper(*extra):
    p = subprocess.Popen([sys.executable, "-I", "-c", "import time; time.sleep(30)"] + list(extra),
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.time() + 5
    while time.time() < deadline and procs.start_time(p.pid) is None:
        time.sleep(0.02)
    return p


class DriftCases(EnvTestCase):
    """登録済みの子（pid・開始時刻が一致して生存）の識別が変わる・読めない → signal を送らず、不在ともしない。"""

    def setUp(self):
        super().setUp()
        self.env.envelope()
        self.env.s2_heartbeat()

    def running_child(self):
        run_id, stub, body = self.claim_and_run(body=make_body(self.env.policy, max_minutes="60"),
                                                scenario={"sleep": 30}, wait=False)
        deadline = time.time() + 20
        while time.time() < deadline:
            e = registry.load(self.env.layout, run_id)
            if e and e["state"] == "running" and e.get("reaper_pid"):
                break
            time.sleep(0.05)
        for key in ("reaper_pid", "stub_pid"):
            try:
                os.kill(e[key], 9)
            except OSError:
                pass
        stub.wait(timeout=10)
        child = e["child_pid"]
        self.addCleanup(lambda: self._kill(child))
        return run_id, registry.load(self.env.layout, run_id), child

    @staticmethod
    def _kill(pid):
        try:
            os.kill(pid, 9)
        except OSError:
            pass

    def assert_unconfirmed(self, run_id, e, child, patcher, reason_prefix):
        with patcher:
            collect = supervise.collector(self.env.layout, e)
            self.assertEqual(collect(), {}, "a drifted child must not be a signal target")
            drift = collect.drift()
            self.assertEqual([d["pid"] for d in drift], [child])
            self.assertTrue(drift[0]["reason"].startswith(reason_prefix), drift)
            absent = supervise.stop_run(self.env.layout, self.env.policy, self.env.agent, e, "emergency_stop", "t")
            self.assertFalse(absent)
            self.assertEqual(registry.load(self.env.layout, run_id)["state"], "stop_unconfirmed")
            self.assertTrue(any("identity drift" in p for p in self.env.control.completion_problems()))
        self.assertEqual(procs.pid_status(child), "alive")

    def test_uid_change(self):
        run_id, e, child = self.running_child()
        real = procs.kinfo

        def fake(pid):
            info = real(pid)
            if pid == child and info:
                info = dict(info, uid=info["uid"] + 1)
            return info
        self.assert_unconfirmed(run_id, e, child, mock.patch.object(procs, "kinfo", side_effect=fake),
                                "identity_drift")

    def test_argv_unreadable(self):
        run_id, e, child = self.running_child()
        real = procs.argv

        def fake(pid):
            if pid == child:
                raise procs.ObservationError("argv unreadable")
            return real(pid)
        with mock.patch.object(procs, "argv", side_effect=fake):
            # 同じuidのプロセスの argv が読めない: 一覧全体が観測不能（unknown）。drift でも unknown でも不在にしない
            collect = supervise.collector(self.env.layout, e)
            with self.assertRaises(procs.ObservationError):
                collect()
            self.assertEqual([(d["pid"], d["reason"].split(":")[0]) for d in collect.drift()],
                             [(child, "identity_unverifiable")])
            absent = supervise.stop_run(self.env.layout, self.env.policy, self.env.agent, e, "emergency_stop", "t")
            self.assertFalse(absent)
            self.assertEqual(registry.load(self.env.layout, run_id)["state"], "stop_unconfirmed")
            self.assertTrue(any("observation unavailable" in p for p in self.env.control.completion_problems()))
        self.assertEqual(procs.pid_status(child), "alive")

    def test_argv_lost(self):
        run_id, e, child = self.running_child()
        real = procs.argv
        self.assert_unconfirmed(run_id, e, child,
                                mock.patch.object(procs, "argv", side_effect=lambda pid: [] if pid == child
                                                  else real(pid)), "identity_drift")

    def test_recovery_with_drift_is_unconfirmed(self):
        """クラッシュ復旧（SPAWNING で止まったラン）でも、識別の変わった既知の子を不在としない。"""
        p = _sleeper()  # 識別子を持たない（argv が一致しない）生存プロセスを「登録済みの子」とする
        self.addCleanup(lambda: (p.kill(), p.wait()))
        run_id = "run-00000000000000c7"
        req = {"request_id": "req-00000000000000c7", "approval_id": "g10-p2-test-0071", "run_id": run_id}
        self.env.agent.used.append("ACCEPTED", dict(req), self.env.agent_signer, "agent", time.time())
        self.env.agent.used.append("SPAWNING", dict(req), self.env.agent_signer, "agent", time.time())
        registry.create(self.env.layout, {
            "run_id": run_id, "session_id": "12345678-1234-1234-1234-123456789abc",
            "settings_path": os.path.join(self.env.tmp, "settings.json"), "hard_deadline": time.time() + 100,
            "policy_sha256": "p", "request_id": req["request_id"], "approval_id": req["approval_id"],
            "task_id": "t", "uid": os.getuid(), "root": os.path.realpath(self.env.tmp), "stub_pid": 0,
            "stub_start": None, "created_at": time.time()})
        registry.update(self.env.layout, run_id, child_pid=p.pid, child_start=procs.start_time(p.pid))
        actions = self.env.agent.recover()
        self.assertIn((run_id, "spawning", False), actions)
        self.assertEqual(registry.load(self.env.layout, run_id)["state"], "stop_unconfirmed")
        self.assertIsNone(p.poll(), "the drifted process was signalled")


class PidReuseAndDecoy(unittest.TestCase):
    """本当に pid が再利用された別プロセス・無関係のプロセスは、drift にもせず、signal も送らない。"""

    def entry(self, child_pid, child_start):
        return {"run_id": "run-0123456789abcdef", "session_id": "11111111-2222-3333-4444-555555555555",
                "settings_path": "/tmp/g10drift-settings.json", "uid": os.getuid(), "root": "/tmp/g10drift-root",
                "stub_pid": None, "stub_start": None, "child_pid": child_pid, "child_start": child_start}

    def test_pid_reuse_is_absent_and_not_signalled(self):
        p = _sleeper()
        try:
            collect = supervise.collector(None, self.entry(p.pid, "978307200.000000"))  # 記録と開始時刻が違う
            self.assertEqual(collect(), {})
            self.assertEqual(collect.drift(), [])
            details = procs.terminate(collect, 0.2, 0.2)
            self.assertTrue(details["absent"])
            self.assertIsNone(p.poll())
        finally:
            p.kill()
            p.wait()

    def test_start_time_readable_for_foreign_uid(self):
        foreign = [pid for pid in procs.all_pids() if (procs.kinfo(pid) or {}).get("uid") not in (None, os.getuid())]
        self.assertTrue(foreign)
        self.assertRegex(procs.start_time(foreign[0]), r"^\d+\.\d{6}$")


def _hmac_sign_allow_nan(key, obj):
    data = json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return "hmac-sha256:" + hmac.new(key, data, hashlib.sha256).hexdigest()


class FiniteEvidence(unittest.TestCase):
    def setUp(self):
        self.keys = signing.test_keys()
        self.verifier = signing.HmacTestVerifier(self.keys)
        self.body = make_body(policy_mod.with_digest(test_policy()))
        self.now = time.time()

    def evidence(self, **over):
        src = issue_mod.MockIssueSource()
        src.publish(self.body, updated_at=self.now - 10)
        w = issue_mod.IssueWitness(src, signing.HmacTestSigner({"witness": self.keys["witness"]}), lambda: self.now)
        doc = w.observe()
        ev = dict(doc["evidence"], **over)
        return {"evidence": ev, "sig": _hmac_sign_allow_nan(self.keys["witness"], ev)}  # 正規の鍵で署名

    def test_signed_bad_times_rejected(self):
        for field in ("fetched_at", "updated_at"):
            for bad in BAD_TIMES:
                with self.subTest(field=field, value=bad):
                    reason = issue_mod.check_evidence(self.evidence(**{field: bad}), self.verifier, self.body,
                                                      self.now, 120)
                    self.assertIsNotNone(reason)

    def test_bad_now_and_max_age_rejected(self):
        doc = self.evidence()
        self.assertIsNone(issue_mod.check_evidence(doc, self.verifier, self.body, self.now, 120))
        for bad in BAD_TIMES:
            with self.subTest(now=bad):
                self.assertIsNotNone(issue_mod.check_evidence(doc, self.verifier, self.body, bad, 120))
            with self.subTest(max_age=bad):
                self.assertIsNotNone(issue_mod.check_evidence(doc, self.verifier, self.body, self.now, bad))

    def test_age_boundaries(self):
        doc = self.evidence()
        tol = jstclock.CLOCK_TOLERANCE_SECONDS
        self.assertIsNone(issue_mod.check_evidence(doc, self.verifier, self.body, self.now + 120, 120))
        self.assertIsNotNone(issue_mod.check_evidence(doc, self.verifier, self.body, self.now + 120.001, 120))
        self.assertIsNone(issue_mod.check_evidence(doc, self.verifier, self.body, self.now - tol, 120))
        self.assertIsNotNone(issue_mod.check_evidence(doc, self.verifier, self.body, self.now - tol - 0.001, 120))

    def test_witness_refuses_non_finite_clock(self):
        src = issue_mod.MockIssueSource()
        src.publish(self.body)
        for bad in NON_FINITE + (0, -1):
            with self.subTest(clock=bad):
                w = issue_mod.IssueWitness(src, signing.HmacTestSigner({"witness": self.keys["witness"]}),
                                           lambda b=bad: b)
                with self.assertRaises(issue_mod.IssueSourceError):
                    w.observe()

    def test_canonical_rejects_non_finite(self):
        for bad in NON_FINITE:
            with self.subTest(value=bad):
                with self.assertRaises(ValueError):
                    canonical({"t": bad})


class FiniteInputs(EnvTestCase):
    def test_policy_rejects_bad_numbers(self):
        for bad in BAD_TIMES:
            with self.subTest(value=bad):
                with self.assertRaises((policy_mod.PolicyError, TypeError)):
                    policy_mod.with_digest(test_policy(timing=dict(FAST_TIMING, issue_evidence_max_age=bad)))
        with self.assertRaises(policy_mod.PolicyError):
            policy_mod.with_digest(test_policy(max_concurrent=math.inf))

    def test_request_with_nan_literal_is_malformed(self):
        self.env.envelope()
        body = make_body(self.env.policy)
        self.env.issue.publish(body)
        run_id, reason = self.env.control.try_claim(body, TRUSTED_ISSUE, time.time())
        path = self.env.layout.request_file(run_id)
        text = open(path, encoding="utf-8").read()
        doc = json.loads(text)
        text = text.replace('"issued_at": %s' % json.dumps(doc["request"]["issued_at"]), '"issued_at": NaN', 1)
        self.assertIn("NaN", text)
        open(path, "w", encoding="utf-8").write(text)
        stub, reason = self.env.agent.handle_request_file(path)
        self.assertIsNone(stub)
        self.assertEqual(reason, "malformed request")
        self.assertEqual(self.env.agent.used.read_all(), [])

    def test_binding_rejects_bad_request_times(self):
        self.env.envelope()
        body = make_body(self.env.policy)
        self.env.issue.publish(body)
        run_id, reason = self.env.control.try_claim(body, TRUSTED_ISSUE, time.time())
        req = json.load(open(self.env.layout.request_file(run_id)))["request"]
        self.assertIsNone(binding.check_request(req, self.env.policy)[0])
        for field in ("issued_at", "reference_time", "expires_at"):
            for bad in BAD_TIMES:
                with self.subTest(field=field, value=bad):
                    self.assertIsNotNone(binding.check_request(dict(req, **{field: bad}), self.env.policy)[0])

    def test_read_json_and_chainlog_reject_nan(self):
        path = os.path.join(self.env.tmp, "x.json")
        open(path, "w").write('{"t": NaN}')
        with self.assertRaises(ValueError):
            read_json(path)
        log = self.env.agent.used
        log.append("ACCEPTED", {"request_id": "r", "approval_id": "a", "run_id": "x"}, self.env.agent_signer,
                   "agent", time.time())
        raw = open(log.path, encoding="utf-8").read()
        rec = json.loads(raw)
        open(log.path, "w", encoding="utf-8").write(raw.replace(json.dumps(rec["ts"]), "NaN", 1))
        with self.assertRaises(chainlog.ChainError):
            log.read_all()
        with self.assertRaises(ValueError):
            log.append("ACCEPTED", {"request_id": "r2", "approval_id": "a2", "run_id": "y", "t": math.nan},
                       self.env.agent_signer, "agent", time.time())

    def test_clock_checks_reject_non_finite(self):
        now = time.time()
        for bad in NON_FINITE + (None, "1", True):
            with self.subTest(value=bad):
                self.assertEqual(jstclock.clock_problem(now, bad), "reference_clock_unavailable")
                self.assertEqual(jstclock.clock_problem(bad, now), "CLOCK_ANOMALY")
                self.assertFalse(jstclock.envelope_usable(bad, now, now))
                self.assertFalse(jstclock.envelope_usable(now + 100, bad, now))
