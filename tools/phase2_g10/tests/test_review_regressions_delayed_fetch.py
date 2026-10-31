"""H4 C4（TASK 6）の反例の固定: 起動直前の Issue 再取得が遅れている間の HALT・STOP・期限切れ。
修正前HEAD（e0d13475）では失敗し、修正後に通ることを確認する。

最終判定は再取得の前にだけ HALT/STOP・期限・認可を見ていたため、再取得（最大5秒）の間に
HALT のフラグが立つ、または要求の期限が過ぎても、古い判定のまま SPAWNING／起動へ進んでいた。

S1（reaper）が HALT を見てスタブごと止めると、スタブ自身の判定の誤りが隠れる。そのため HALT の試験では
S1 の確認間隔を長くし、スタブの最終判定だけで起動が止まることを確かめる。
修正前のコードでも動くように、振る舞いだけを使う（再取得の開始は before_T6a のフックで知る）。
"""
import json
import os
import time

from g10runner import registry
from helpers import EnvTestCase, FAST_TIMING, TRUSTED_ISSUE, make_body

SLOW_S1 = dict(FAST_TIMING, reaper_interval=30.0)


def wait_for(path, timeout=15):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if os.path.exists(path):
            return True
        time.sleep(0.01)
    return False


class DelayedFetchBase(EnvTestCase):
    fetch_delay = 3.5

    def setUp(self):
        super().setUp()
        self.env.envelope()
        self.env.s2_heartbeat()
        self.body = make_body(self.env.policy)
        self.env.issue.publish(self.body)
        self.marker = os.path.join(self.env.tmp, "started")

    def start(self):
        run_id, reason = self.env.control.try_claim(self.body, TRUSTED_ISSUE, time.time())
        self.assertIsNotNone(run_id, reason)
        self.env.issue.delay = self.fetch_delay  # 起動直前の再取得だけが遅れる（CLAIM は済んでいる）
        run_dir = self.env.layout.run_dir(run_id)
        os.makedirs(run_dir, exist_ok=True)
        json.dump({"before_T6a": {"mark": True}}, open(os.path.join(run_dir, "test_hooks.json"), "w"))
        stub, reason = self.env.agent.handle_request_file(self.env.layout.request_file(run_id),
                                                          scenario={"started_marker": self.marker, "sleep": 5})
        self.assertIsNotNone(stub, reason)
        self.addCleanup(lambda: (stub.poll() is None and stub.kill(), stub.wait(timeout=30)))
        self.assertTrue(wait_for(os.path.join(run_dir, "hook_before_T6a.reached")))
        return run_id, stub

    def assert_not_spawned(self, run_id, stub, expect_reason):
        stub.wait(timeout=30)
        self.assertNotIn("SPAWNED", self.env.agent.used_state(run_id), "spawned after the stop/expiry")
        self.assertFalse(os.path.exists(self.marker), "fake Claude started after the stop/expiry")
        e = registry.load(self.env.layout, run_id)
        self.assertIn(e["state"], ("aborted_by_halt", "aborted_before_spawn"))
        self.assertEqual(e.get("abort_reason"), expect_reason)


class HaltDuringFetch(DelayedFetchBase):
    policy_overrides = {"timing": SLOW_S1}

    def test_hard_halt_during_delayed_fetch(self):
        run_id, stub = self.start()
        time.sleep(self.fetch_delay - 0.8)  # 再取得の終わり近くで HALT（フラグが先に立つ）
        t = self.start_control_thread(lambda: self.env.control.halt("hard", "during fetch", wait_sync=0.5))
        self.assert_not_spawned(run_id, stub, "halted")
        self.join_control_thread(t)

    def test_soft_halt_during_delayed_fetch(self):
        run_id, stub = self.start()
        time.sleep(self.fetch_delay - 0.8)
        t = self.start_control_thread(lambda: self.env.control.halt("soft", "during fetch", wait_sync=0))
        self.assert_not_spawned(run_id, stub, "halted")
        self.join_control_thread(t)

    def test_stop_during_delayed_fetch(self):
        run_id, stub = self.start()
        time.sleep(self.fetch_delay - 0.8)
        t = self.start_control_thread(self.env.control.stop_on)
        self.assert_not_spawned(run_id, stub, "stopped")
        self.join_control_thread(t)


class ExpiryDuringFetch(DelayedFetchBase):
    policy_overrides = {"timing": dict(SLOW_S1, request_ttl=3.0)}
    fetch_delay = 4.0  # 要求の有効時間（3秒）より長い再取得

    def test_request_expires_during_delayed_fetch(self):
        run_id, stub = self.start()
        self.assert_not_spawned(run_id, stub, "request expired")


class DelayedFetchAllowed(DelayedFetchBase):
    """停止・期限切れの無い遅延取得は、これまでどおり起動する（過剰に拒否しない）。"""
    policy_overrides = {"timing": dict(FAST_TIMING, request_ttl=3.0)}
    fetch_delay = 1.0  # 有効時間（3秒）内に終わる再取得

    def test_delayed_fetch_within_ttl_spawns(self):
        run_id, stub = self.start()
        stub.wait(timeout=30)
        self.assertIn("SPAWNED", self.env.agent.used_state(run_id))
        self.wait_terminal(run_id)
        self.assertTrue(os.path.exists(self.marker))


class StoppedThenRecovery(DelayedFetchBase):
    policy_overrides = {"timing": SLOW_S1}

    def test_no_spawn_after_recovery_or_second_stub(self):
        run_id, stub = self.start()
        time.sleep(self.fetch_delay - 0.8)
        t = self.start_control_thread(lambda: self.env.control.halt("soft", "during fetch", wait_sync=0))
        self.assert_not_spawned(run_id, stub, "halted")
        self.join_control_thread(t)
        self.assertEqual(self.env.agent.recover(), [])  # ABORTED 済み: 復旧で何もしない（再実行しない）
        stub2 = self.env.agent.spawn_stub(run_id)  # 二度目のスタブ起動
        self.assertEqual(stub2.wait(timeout=30), 3)
        self.assertNotIn("SPAWNED", self.env.agent.used_state(run_id))
        self.assertFalse(os.path.exists(self.marker))
