"""停止・取消イベントと起動の最終判定の競合、緊急HALT・UNHALT（仕様 v5.2 §1、v5.4 §1・§2・§4）。

「HALT（または STOP・取消）の確定後に、偽Claudeが起動して生き続ける」ことが一度もないことを確認する。
"""
import json
import os
import random
import signal
import threading
import time

from g10runner import procs, registry, state, supervise
from g10runner.fsutil import FileLock
from helpers import EnvTestCase, TRUSTED_ISSUE, make_body


def wait_file(path, timeout=20):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if os.path.exists(path):
            return True
        time.sleep(0.02)
    return False


class TestRace(EnvTestCase):
    def setUp(self):
        super().setUp()
        self.env.envelope()
        self.env.s2_heartbeat()

    def started_marker(self):
        return os.path.join(self.env.tmp, "started-%f" % time.time())

    def assert_no_live_claude(self, run_id):
        e = registry.load(self.env.layout, run_id)
        self.assertIs(supervise.run_processes_present(self.env.layout, e), False, "fake Claude still alive after stop")
        return e

    def test_halt_while_stub_inside_critical_section(self):
        """スタブが共有ロック内（最終判定の後・起動の前）で停滞中にHALT → HALTは待ち、起動後に停止される。"""
        marker = self.started_marker()
        run_id, stub, body = self.claim_and_run(scenario={"sleep": 30, "started_marker": marker},
                                                hooks={"before_spawn": {"sleep": 1.0, "mark": True}}, wait=False)
        self.assertTrue(wait_file(os.path.join(self.env.layout.run_dir(run_id), "hook_before_spawn.reached")))
        result = self.env.control.halt("hard", "race test")
        # HALTは、(a) スタブの臨界区間の終了を待つか、(b) S1 がHALTのフラグを見てスタブを止めて
        # ロックを解放させる。どちらでも、完了時に偽Claudeが生きていてはならない。
        self.assertTrue(result["resolved"], result["problems"])
        stub.wait(timeout=30)
        e = self.assert_no_live_claude(run_id)
        self.assertEqual(e["state"], "interrupted")
        self.assertEqual(e["stop_reason"], "emergency_stop")

    def test_halt_before_stub_enters_critical_section(self):
        """スタブがロック取得の前で停滞中にHALTが完了 → スタブは中止し、偽Claudeは起動しない。"""
        marker = self.started_marker()
        run_id, stub, body = self.claim_and_run(scenario={"started_marker": marker},
                                                hooks={"before_T6a": {"sleep": 1.0, "mark": True}}, wait=False)
        self.assertTrue(wait_file(os.path.join(self.env.layout.run_dir(run_id), "hook_before_T6a.reached")))
        result = self.env.control.halt("hard", "race test 2")
        stub.wait(timeout=30)
        self.assertFalse(os.path.exists(marker), "fake Claude was started after HALT")
        e = registry.load(self.env.layout, run_id)
        # スタブ自身が中止する（ABORTED）か、S1 がHALTのフラグを見て起動前のスタブを止める（interrupted）
        self.assertIn(e["state"], ("aborted_before_spawn", "aborted_by_halt", "interrupted"))
        if e["state"] == "interrupted":
            self.assertEqual(self.env.agent.used_state(run_id), ["ACCEPTED"])
            self.env.agent.recover()  # 復旧で ABORTED を記録し、再実行はしない
        self.assertEqual(self.env.agent.used_state(run_id), ["ACCEPTED", "ABORTED"])
        self.assertTrue(result["resolved"], result["problems"])

    def test_revoke_and_stop_events_wait_for_critical_section(self):
        for action in ("revoke", "stop"):
            with self.subTest(action=action):
                self.setUp()
                marker = self.started_marker()
                run_id, stub, body = self.claim_and_run(scenario={"sleep": 0.2, "started_marker": marker},
                                                        hooks={"before_spawn": {"sleep": 1.0, "mark": True}}, wait=False)
                self.assertTrue(wait_file(os.path.join(self.env.layout.run_dir(run_id), "hook_before_spawn.reached")))
                t0 = time.time()
                if action == "revoke":
                    self.env.control.revoke_envelope(self.env.control.read_state().envelope["envelope_id"])
                else:
                    self.env.control.stop_on()
                waited = time.time() - t0
                self.assertGreaterEqual(waited, 0.5)  # 臨界区間の終了を待ってから確定した
                stub.wait(timeout=30)
                # 取消・STOPの確定より前に起動が確定したランは、通常どおり終わる（効力は確定以降の起動に及ぶ）
                self.assertTrue(os.path.exists(marker))

    def test_soft_halt_before_final_check_blocks_spawn(self):
        """ソフトHALT（S1は止めない）でも、最終判定で必ず中止し、偽Claudeは起動しない。"""
        marker = self.started_marker()
        run_id, stub, body = self.claim_and_run(scenario={"started_marker": marker},
                                                hooks={"before_T6a": {"sleep": 1.0, "mark": True}}, wait=False)
        self.assertTrue(wait_file(os.path.join(self.env.layout.run_dir(run_id), "hook_before_T6a.reached")))
        self.env.control.append_control("HALT", {"kind": "soft", "reason": "log only"}, "runner")
        stub.wait(timeout=30)
        self.assertFalse(os.path.exists(marker))
        e = registry.load(self.env.layout, run_id)
        self.assertEqual(e["state"], "aborted_by_halt")

    def test_revoke_before_final_check_blocks_spawn(self):
        marker = self.started_marker()
        run_id, stub, body = self.claim_and_run(scenario={"started_marker": marker},
                                                hooks={"before_T6a": {"sleep": 1.0, "mark": True}}, wait=False)
        self.assertTrue(wait_file(os.path.join(self.env.layout.run_dir(run_id), "hook_before_T6a.reached")))
        self.env.control.revoke_envelope(self.env.control.read_state().envelope["envelope_id"])
        stub.wait(timeout=30)
        self.assertFalse(os.path.exists(marker))
        e = registry.load(self.env.layout, run_id)
        self.assertEqual(e["abort_reason"], "not authorized at final check")

    def test_randomized_halt_timing(self):
        """HALTの時刻をランダムにずらして繰り返す。HALT完了後に偽Claudeが生きていた例は0。"""
        for i in range(6):
            with self.subTest(i=i):
                self.setUp()
                hooks = {"before_spawn": {"sleep": random.choice([0, 0.2, 0.5])},
                         "before_T6a": {"sleep": random.choice([0, 0.2, 0.5])}}
                run_id, stub, body = self.claim_and_run(scenario={"sleep": 30}, hooks=hooks, wait=False)
                time.sleep(random.uniform(0.0, 1.0))
                result = self.env.control.halt("hard", "random %d" % i)
                self.assertTrue(result["resolved"], result["problems"])
                stub.wait(timeout=30)
                self.assert_no_live_claude(run_id)

    def test_stub_hung_holding_shared_lock(self):
        """スタブが共有ロックを保持したまま停止（SIGSTOP）→ S1がHALTのフラグを見て停止させ、HALTは続行できる。"""
        run_id, stub, body = self.claim_and_run(scenario={"sleep": 30},
                                                hooks={"before_spawn": {"sleep": 5.0, "mark": True}}, wait=False)
        self.assertTrue(wait_file(os.path.join(self.env.layout.run_dir(run_id), "hook_before_spawn.reached")))
        os.kill(stub.pid, signal.SIGSTOP)
        result = self.env.control.halt("hard", "hung stub")
        self.assertTrue(result["resolved"], result["problems"])
        e = self.assert_no_live_claude(run_id)
        self.assertFalse(procs.alive(stub.pid) and procs.identity_ok(stub.pid, e["stub_start"]))

    def test_lock_fd_not_inherited_by_fake_claude(self):
        """スタブが共有ロック内で（起動直後に）異常終了しても、偽Claudeがロックを持ち続けない。"""
        run_id, stub, body = self.claim_and_run(scenario={"sleep": 4}, hooks={"after_spawn": {"exit": True}},
                                                wait=False)
        stub.wait(timeout=30)
        e = registry.load(self.env.layout, run_id)
        self.assertIs(supervise.run_processes_present(self.env.layout, e), True, "fake Claude should still be running")
        with FileLock(self.env.layout.halt_lock, "ex", timeout=2.0) as lock:
            self.assertTrue(lock.acquired, "exclusive lock blocked by the fake Claude (lock fd inherited)")
        self.wait_terminal(run_id)


class TestHaltUnhalt(EnvTestCase):
    def setUp(self):
        super().setUp()
        self.env.envelope()
        self.env.s2_heartbeat()

    def test_halt_stops_running_run_and_blocks_new(self):
        run_id, stub, body = self.claim_and_run(scenario={"sleep": 30}, wait=False)
        time.sleep(1.0)
        result = self.env.control.halt("hard", "stop all")
        self.assertTrue(result["resolved"], result["problems"])
        e = registry.load(self.env.layout, run_id)
        self.assertEqual(e["state"], "interrupted")
        self.assertEqual(e["stop_reason"], "emergency_stop")
        body2 = make_body(self.env.policy, approval_id="g10-p2-test-0002")
        self.env.issue.publish(body2)
        self.assertIn("halted", self.env.control.try_claim(body2, TRUSTED_ISSUE, time.time())[1])

    def test_unhalt_refused_while_process_present(self):
        self.env.control.halt("soft", "soft halt", wait_sync=0)  # ソフトHALTでは実行中のランは止まらない
        # 実行中のランを模擬（登録簿にrunningがある）
        run_id, stub, body = self.claim_and_run(scenario={"sleep": 30}, wait=False) if False else (None, None, None)
        from g10runner import registry as reg
        reg.create(self.env.layout, {"run_id": "run-00000000000000fa", "session_id": "s-fake", "settings_path": "x",
                                     "hard_deadline": time.time() + 100, "policy_sha256": "p", "request_id": "r",
                                     "approval_id": "a", "task_id": "t", "stub_pid": 0, "stub_start": None,
                                     "uid": os.getuid(), "root": os.path.realpath(self.env.tmp),
                                     "created_at": time.time()})
        rec, problems = self.env.control.unhalt("try")
        self.assertIsNone(rec)
        self.assertTrue(any("non-terminal run" in p for p in problems))

    def test_unhalt_refused_on_stop_unconfirmed_and_registry_tamper(self):
        from g10runner import registry as reg
        self.env.control.halt("soft", "x", wait_sync=0)
        reg.create(self.env.layout, {"run_id": "run-0000000000000a0b", "session_id": "s-u", "settings_path": "x",
                                     "hard_deadline": time.time() + 100, "policy_sha256": "p", "request_id": "r",
                                     "approval_id": "a", "task_id": "t", "stub_pid": 0, "stub_start": None,
                                     "uid": os.getuid(), "root": os.path.realpath(self.env.tmp),
                                     "created_at": time.time()})
        reg.update(self.env.layout, "run-0000000000000a0b", "stop_unconfirmed")
        self.assertIsNone(self.env.control.unhalt("try")[0])
        # 不変項目の改ざん
        path = self.env.layout.proc_file("run-0000000000000a0b")
        d = json.load(open(path))
        d["hard_deadline"] = 1
        json.dump(d, open(path, "w"))
        rec, problems = self.env.control.unhalt("try")
        self.assertIsNone(rec)
        self.assertTrue(any("immutable" in p for p in problems))

    def test_unhalt_then_new_run_allowed(self):
        self.env.control.halt("hard", "h", wait_sync=1)
        rec, problems = self.env.control.unhalt("checked")
        self.assertEqual(problems, [])
        self.assertFalse(state.flags_say_halt(self.env.layout))
        self.assertFalse(self.env.control.read_state().halted)
        body = make_body(self.env.policy, approval_id="g10-p2-test-0003")
        self.env.issue.publish(body)
        self.assertIsNotNone(self.env.control.try_claim(body, TRUSTED_ISSUE, time.time())[0])

    def test_unhalt_blocks_stubs_while_holding_lock(self):
        """UNHALTの手続き中（排他ロック保持）は、スタブが臨界区間に入れない。"""
        self.env.control.halt("soft", "h", wait_sync=0)
        entered = []

        def try_shared():
            with FileLock(self.env.layout.halt_lock, "sh", timeout=0.3) as lk:
                entered.append(lk.acquired)
        with FileLock(self.env.layout.halt_lock, "ex"):
            t = threading.Thread(target=try_shared)
            t.start()
            t.join()
        self.assertEqual(entered, [False])

    def test_agent_halt_requires_signed_unhalt_covering_it(self):
        self.env.agent.halt_agent("violation")
        self.assertTrue(self.env.control.read_state().hard_halted)
        body = make_body(self.env.policy)
        self.env.issue.publish(body)
        self.assertIn("halted", self.env.control.try_claim(body, TRUSTED_ISSUE, time.time())[1])
        self.env.control.unhalt("checked")
        self.env.agent.sync_flags()
        self.assertFalse(self.env.control.read_state().halted)
        self.assertFalse(os.path.exists(self.env.layout.agent_halt_flag))


class TestSupervisors(EnvTestCase):
    def setUp(self):
        super().setUp()
        self.env.envelope()
        self.env.s2_heartbeat()

    def wait_running(self, run_id, timeout=20):
        deadline = time.time() + timeout
        while time.time() < deadline:
            e = registry.load(self.env.layout, run_id)
            if e and e["state"] == "running" and e.get("reaper_pid"):
                return e
            time.sleep(0.05)
        self.fail("not running")

    def test_s1_killed_s2_enforces_deadline(self):
        run_id, stub, body = self.claim_and_run(scenario={"sleep": 30}, max_minutes="2", wait=False)
        e = self.wait_running(run_id)
        os.kill(e["reaper_pid"], signal.SIGKILL)
        deadline = e["hard_deadline"] + 0.6
        while time.time() < deadline:
            time.sleep(0.05)
        actions = supervise.watchdog_cycle(self.env.layout, self.env.policy, self.env.agent)
        self.assertIn((run_id, "timed_out"), actions)
        e = registry.load(self.env.layout, run_id)
        self.assertEqual(e["stop_by"], "S2")
        self.assertIs(supervise.run_processes_present(self.env.layout, e), False)

    def test_both_supervisors_down_control_halts_and_alerts(self):
        run_id, stub, body = self.claim_and_run(scenario={"sleep": 30}, max_minutes="60", wait=False)
        e = self.wait_running(run_id)
        os.kill(e["reaper_pid"], signal.SIGKILL)
        self.env.s2_heartbeat(fresh=False)
        time.sleep(1.6)  # S1のハートビートが古くなるまで（0.1秒×3＋1秒）
        result = self.env.control.supervision_check()
        self.assertTrue(result["halted"])
        self.assertTrue(any("監督機構が停止しています" in t for t, _ in self.env.notifier.sent))
        self.assertTrue(self.env.control.read_state().hard_halted)
        # 人の最終手段の代わりに、ここでは S2 を再開（launchd の KeepAlive の代わり）して回収する
        self.env.s2_heartbeat()
        supervise.watchdog_cycle(self.env.layout, self.env.policy, self.env.agent)
        self.assertIs(supervise.run_processes_present(self.env.layout, e), False)

    def test_s2_only_lost_is_soft_halt(self):
        run_id, stub, body = self.claim_and_run(scenario={"sleep": 5}, max_minutes="60", wait=False)
        self.wait_running(run_id)
        self.env.s2_heartbeat(fresh=False)
        result = self.env.control.supervision_check()
        self.assertEqual(result.get("kind"), "soft")
        st = self.env.control.read_state()
        self.assertTrue(st.halted)
        self.assertFalse(st.hard_halted)
        e = registry.load(self.env.layout, run_id)
        self.assertEqual(e["state"], "running")  # S1の監督で継続
        stub.wait(timeout=30)
