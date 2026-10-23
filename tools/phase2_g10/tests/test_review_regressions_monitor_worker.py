"""H2 C2（TASK 8）の反例の固定。修正前HEAD（def6e283）では失敗し、修正後に通ることを確認する。

- R1: 監督の取得スレッドが例外で終わる・結果が無いと、「成功（None）」と取り違えて issue_ok_at を更新し、S2 の予備照合も抑止する。
- R2: 古い正常応答を、親の poll が受け取った時刻で issue_ok_at に付け替え、S2 の鮮度判定（stale）をすり抜ける。

修正前のコードでも動くように、振る舞いだけを使う。
"""
import json
import os
import tempfile
import threading
import time
import unittest
from unittest import mock

from g10runner import issue as issue_mod, policy as policy_mod, procs, registry, signing, supervise
from g10runner.layout import Layout
from helpers import EnvTestCase, FAST_TIMING, make_body, test_policy

RUN_ID = "run-0123456789abcdef"


class R1RunningWorkerError(EnvTestCase):
    policy_overrides = {"timing": dict(FAST_TIMING, issue_monitor_interval=0.15, issue_fetch_timeout=0.3)}

    def test_broken_witness_key_is_not_a_healthy_monitor(self):
        self.env.envelope()
        self.env.s2_heartbeat()
        body = make_body(self.env.policy, max_minutes="60")
        run_id, stub, body = self.claim_and_run(body=body, scenario={"sleep": 30}, wait=False)
        self.addCleanup(lambda: (stub.poll() is None and stub.kill(), stub.wait(timeout=30)))
        deadline = time.time() + 20
        e = None
        while time.time() < deadline:
            e = registry.load(self.env.layout, run_id)
            if e and e["state"] == "running":
                break
            time.sleep(0.02)
        child = e["child_pid"]
        self.addCleanup(lambda: _kill(child))
        # 自分の試験用の鍵ファイルだけ、witness の鍵の表現を壊す（他の試験鍵はそのまま。実鍵・秘密ではない）
        path = os.path.join(self.env.tmp, signing.TEST_KEYS_FILE)
        keys = json.load(open(path))
        keys["witness"] = "not-hex"
        json.dump(keys, open(path, "w"))
        time.sleep(1.4)  # S2 の stale の基準（0.15×3＋0.3＝0.75秒）を超える
        supervise.watchdog_cycle(self.env.layout, self.env.policy, self.env.agent)
        time.sleep(0.5)
        e2 = registry.load(self.env.layout, run_id)
        self.assertNotEqual(e2["state"], "running", "monitoring was impossible but the run kept running")
        self.assertTrue(self.env.control.read_state().hard_halted, "no HALT although the monitor could not work")
        self.assertNotEqual(procs.pid_status(child), "alive")


def _kill(pid):
    try:
        os.kill(pid, 9)
    except OSError:
        pass


class R1WorkerException(unittest.TestCase):
    def test_worker_exception_is_a_failure_and_not_ok(self):
        policy = test_policy(timing=dict(FAST_TIMING, issue_monitor_interval=0.1, issue_fetch_timeout=0.3))

        def boom(*a, **kw):
            raise RuntimeError("secret-looking detail that must not be logged")
        with mock.patch.object(supervise, "issue_monitor_check", side_effect=boom):
            m = supervise.IssueMonitor(Layout("/tmp/g10-unused"), policy, None, RUN_ID)
            problem = m.poll(time.time())
            deadline = time.time() + 2
            while time.time() < deadline and problem is None:
                time.sleep(0.05)
                problem = m.poll(time.time())
        self.assertIsNotNone(problem, "a crashed monitor worker was treated as a successful check")
        self.assertNotIn("secret-looking", problem)
        self.assertIsNone(m.ok_at, "issue_ok_at was refreshed by a crashed worker")


class R2StaleSuccess(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="g10mw-", dir="/tmp")
        self.addCleanup(lambda: __import__("shutil").rmtree(self.tmp, ignore_errors=True))
        self.layout = Layout(self.tmp).ensure()
        os.makedirs(self.layout.run_dir(RUN_ID), exist_ok=True)
        self.policy = policy_mod.with_digest(
            test_policy(timing=dict(FAST_TIMING, issue_monitor_interval=5.0, issue_fetch_timeout=5.0)))
        self.keys = signing.test_keys()

    def test_late_consumed_success_is_not_republished_as_fresh(self):
        t0 = time.time()
        body = make_body(self.policy)
        src = issue_mod.MockIssueSource()
        src.publish(body, updated_at=t0 - 5)
        witness = issue_mod.IssueWitness(src, signing.HmacTestSigner({"witness": self.keys["witness"]}), lambda: t0)
        first_done = threading.Event()
        release = threading.Event()
        calls = []

        def fake_check(layout, policy, agent, run_id):
            calls.append(1)
            if len(calls) == 1:
                ev = witness.observe("monitor", issue_mod.monitor_nonce(run_id))
                first_done.set()
                return None, ev  # t0 に取得・検証した正常応答
            release.wait(10)  # 次の取得は未完了のまま
            return "released", None
        self.addCleanup(release.set)
        with mock.patch.object(supervise, "_issue_monitor_check", side_effect=fake_check):
            m = supervise.IssueMonitor(self.layout, self.policy, None, RUN_ID)
            self.assertIsNone(m.poll(t0))
            self.assertTrue(first_done.wait(5))
            time.sleep(0.1)  # スレッドの終了
            late = t0 + 60  # S1 が60秒遅れて結果を受け取る
            with mock.patch.object(supervise.time, "time", return_value=late):
                problem = m.poll(late)
            self.assertIsNone(problem)
            self.assertFalse(m.ok_at is not None and m.ok_at > t0 + 1,
                             "a 60 s old success was re-timestamped at consumption time")
            hb = os.path.join(self.layout.run_dir(RUN_ID), "reaper_heartbeat.json")
            json.dump({"issue_ok_at": m.ok_at}, open(hb, "w"))
            self.assertTrue(supervise._s1_issue_monitor_stale(self.layout, self.policy,
                                                              {"run_id": RUN_ID, "spawned_at": t0 - 1}, late),
                            "S2 fallback was suppressed by a stale success")
