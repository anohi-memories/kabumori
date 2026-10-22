"""H3 第10TASK（C3）の反例の固定。修正前HEAD（75a4bf92）では失敗し、修正後に通ることを確認する。

- R1 [P1]: 登録済みの子が同じ pid・開始時刻のまま生存しているのに、argv が変わる（exec 等）と
  「対象なし＝不在」とされ、停止完了・END の不在確認・HALT 解決・UNHALT が通る。
- R2 [P2]: 正規の witness の時計が NaN を返した署名済み Issue 証拠が、鮮度検証（120秒以内）を通る。

修正前のコードでも動くように、振る舞いだけを使う。
"""
import math
import os
import time
from unittest import mock

from g10runner import issue as issue_mod, procs, registry, supervise
from helpers import EnvTestCase, TRUSTED_ISSUE, make_body

OTHER_SESSION = "99999999-8888-7777-6666-555555555555"


def _alive(pid):
    try:
        return procs.pid_status(pid) == "alive"
    except procs.ObservationError:
        return True


class R1IdentityDrift(EnvTestCase):
    def setUp(self):
        super().setUp()
        self.env.envelope()
        self.env.s2_heartbeat()

    def start_running(self):
        body = make_body(self.env.policy, max_minutes="60")
        run_id, stub, body = self.claim_and_run(body=body, scenario={"sleep": 30}, wait=False)
        deadline = time.time() + 20
        e = None
        while time.time() < deadline:
            e = registry.load(self.env.layout, run_id)
            if e and e["state"] == "running" and e.get("reaper_pid"):
                break
            time.sleep(0.05)
        # クラッシュ後の形: S1（reaper）とスタブが居ない。子だけが生存している
        for key in ("reaper_pid", "stub_pid"):
            try:
                os.kill(e[key], 9)
            except OSError:
                pass
        stub.wait(timeout=10)
        time.sleep(0.2)
        child = e["child_pid"]
        self.addCleanup(self._kill, child)
        self.assertTrue(_alive(child))
        return run_id, registry.load(self.env.layout, run_id), body, child

    @staticmethod
    def _kill(pid):
        try:
            os.kill(pid, 9)
        except OSError:
            pass

    def drift_argv(self, child):
        """その子だけの argv 観測を、別の識別子に変える（exec による識別の変化を模擬）。"""
        real = procs.argv

        def fake(pid):
            if pid == child:
                av = real(pid)
                out = []
                for i, tok in enumerate(av):
                    out.append(OTHER_SESSION if i > 0 and av[i - 1] == "--session-id" else tok)
                return out
            return real(pid)
        return mock.patch.object(procs, "argv", side_effect=fake)

    def test_known_child_with_drifted_argv_is_not_absent(self):
        run_id, e, body, child = self.start_running()
        with self.drift_argv(child):
            absent = supervise.stop_run(self.env.layout, self.env.policy, self.env.agent, e, "emergency_stop",
                                        "test")
            self.assertTrue(_alive(child))
            self.assertFalse(absent, "a live known child was reported absent")
            self.assertEqual(registry.load(self.env.layout, run_id)["state"], "stop_unconfirmed")
            status, end = self.env.control.finalize(run_id, current_body=body)
            self.assertFalse(end["payload"]["absence_confirmed"], "END confirmed absence of a live child")
            result = self.env.control.halt("hard", "drift", wait_sync=0.5)
            self.assertFalse(result.get("resolved"), "hard HALT resolved while the known child was alive")
            rec, problems = self.env.control.unhalt("try")
            self.assertIsNone(rec, "UNHALT allowed while the known child was alive")
        self.assertTrue(_alive(child), "the drifted child must not be signalled by PID alone")

    def test_supervisors_and_recovery_keep_it_unconfirmed(self):
        run_id, e, body, child = self.start_running()
        with self.drift_argv(child):
            supervise.watchdog_cycle(self.env.layout, self.env.policy, self.env.agent, now=e["hard_deadline"] + 999)
            self.assertNotIn(registry.load(self.env.layout, run_id)["state"], registry.TERMINAL)
            self.assertIs(supervise.run_processes_present(self.env.layout, registry.load(self.env.layout, run_id))
                          is False, False)
            supervise.watchdog_cycle(self.env.layout, self.env.policy, self.env.agent)  # stop_unconfirmed の再試行
            self.assertEqual(registry.load(self.env.layout, run_id)["state"], "stop_unconfirmed")
        self.assertTrue(_alive(child))


class R2NonFiniteEvidence(EnvTestCase):
    def setUp(self):
        super().setUp()
        self.body = make_body(self.env.policy)

    def witness_doc(self, clock):
        src = issue_mod.MockIssueSource()
        src.publish(self.body, updated_at=1.0)
        w = issue_mod.IssueWitness(src, self.env.witness_signer, lambda: clock)
        try:
            return w.observe()
        except Exception:
            return None  # 取得係が非有限の時刻を拒否した（修正後の期待どおり）

    def test_nan_clock_evidence_is_not_fresh(self):
        for clock in (math.nan, math.inf, -math.inf):
            with self.subTest(clock=clock):
                doc = self.witness_doc(clock)
                if doc is None:
                    continue
                reason = issue_mod.check_evidence(doc, self.env.verifier, self.body, time.time() + 1e6, 120)
                self.assertIsNotNone(reason, "evidence with a non-finite fetched_at passed the freshness check")

    def test_nan_witness_clock_does_not_claim(self):
        self.env.envelope()
        self.env.issue.publish(self.body, updated_at=1.0)
        self.env.witness.now = lambda: math.nan
        run_id, reason = self.env.control.try_claim(self.body, TRUSTED_ISSUE, time.time())
        self.assertIsNone(run_id, "a CLAIM was made with NaN-timed Issue evidence")
        self.assertEqual(self.env.agent.used.read_all(), [])
