"""TASK 15: 監督付き自動起動の結線（オフライン E2E）。

「GraphQL の取得元（fixture・認証なし・ネットワークなし）→ 編集者／本文の証拠（witness の ECDSA 署名）→ 共有の回数台帳の
予約 → CLAIM → 受理 → 起動直前の再取得（別プロセスのスタブ）→ 署名の検証 → 偽Claude → S1 の監督 → finalize →
REPORT の候補」を一つの fixture で通し、途中の欠け・二重起動・古い本文・回数不足・ID の差し替え・再送・停止が
すべて起動しない／止まる側に倒れることを確かめる。実 GitHub・実 Claude・実鍵・OS の変更は使わない。
"""
import json
import os
import time
import unittest

from g10runner import adapter, claude_cli_plan as ccp, ecdsa_signing as ec, registry, signing, wiring
from g10runner.agent import Agent
from g10runner.chainlog import ChainError
from g10runner.control import Control
from g10runner.fsutil import atomic_write_json, canonical, read_json
from helpers import Env, FAST_TIMING, TRUSTED_ISSUE, kill_leftovers, make_body, make_writable, test_policy

# 監督の間隔 5秒: 同じ認証の主体の予算（Phase 1 の監視を含む）に収まる最小の側（0.5秒では組み立てを拒否する）
WIRED_TIMING = dict(FAST_TIMING, issue_monitor_interval=5.0)


class WiredEnv(Env):
    """wiring.json で結線した試験用ルート。制御側（runner・human の ECDSA 鍵）と実行側（agent の鍵＋公開鍵）を分ける。"""

    def __init__(self, mode="ecdsa", ledger_limit=200, policy=None):
        self.mode, self.ledger_limit = mode, ledger_limit
        super().__init__(policy=policy or test_policy(timing=dict(WIRED_TIMING)))

    def _setup(self, policy, now, notifier):
        super()._setup(policy, now, notifier)
        self.real = os.path.realpath(self.tmp)
        keydir = os.path.join(self.real, "keys")
        os.makedirs(keydir, 0o700)
        self.priv, self.pub = {}, {}
        for role in signing.ROLES:
            self.priv[role], self.pub[role] = ec.generate_keypair(keydir, role)
        os.makedirs(os.path.join(self.real, "ledger"), 0o700)
        self.ledger_path = os.path.join(self.real, "ledger", "github.json")
        self.fixture_path = os.path.join(self.real, "issue_graphql_fixture.json")
        self.apply_mode(self.mode)

    def wiring_doc(self, mode):
        keyed = mode != "hmac"
        return {"version": wiring.VERSION, "mode": mode,
                "public_keys": dict(self.pub) if keyed else {},
                "private_keys": {"agent": self.priv["agent"], "witness": self.priv["witness"]} if keyed else {},
                "issue_source": {"kind": "graphql_fixture", "fixture": self.fixture_path},
                "ledger": {"path": self.ledger_path, "limit_per_hour": self.ledger_limit, "reserve_fraction": 0.0,
                           "watchdog_interval": 30.0}}

    def apply_mode(self, mode, approve=True):
        self.mode = mode
        wiring.write(self.tmp, self.wiring_doc(mode))
        keys_file = os.path.join(self.tmp, signing.TEST_KEYS_FILE)
        if mode == "ecdsa" and os.path.exists(keys_file):
            os.unlink(keys_file)  # ecdsa では HMAC の鍵ファイルを残さない（残っていれば組み立てを拒否する）
        cfg = wiring.load(self.tmp)
        self.verifier = wiring.verifier(self.tmp, cfg)
        if mode == "hmac":
            keys = signing.test_keys()
            self.control_signer = signing.HmacTestSigner({"runner": keys["runner"], "human": keys["human"]})
        else:
            self.control_signer = ec.EcdsaSigner({"runner": self.priv["runner"], "human": self.priv["human"]})
        self.agent_signer, agent_verifier = wiring.agent_side(self.tmp)
        self.issue = wiring.GraphQLFixtureFile(self.fixture_path)
        self.witness = wiring.witness(self.tmp, cfg, self.policy)
        self.control = Control(self.layout, self.control_signer, self.verifier, self.policy, self.notifier,
                               time.time, witness=self.witness)
        self.agent = Agent(self.layout, self.agent_signer, agent_verifier, self.policy)
        if approve:
            self.control.approve_wiring()  # TASK 16: 人の署名で今の設定を承認（世代を1つ進める）

    def ledger_sent(self):
        doc = read_json(self.ledger_path) or {"sent": []}
        return len(doc["sent"])

    def fill_ledger(self):
        """台帳を上限まで使った状態にする（自分の fixture のファイルだけ）。"""
        now = time.time()
        doc = read_json(self.ledger_path) or {"sent": [], "blocked_until": None, "server_remaining": None,
                                              "server_reset": None}
        doc["sent"] = [now - 1.0] * self.ledger_limit
        atomic_write_json(self.ledger_path, doc)
        os.chmod(self.ledger_path, 0o600)


class WiredBase(unittest.TestCase):
    mode = "ecdsa"
    ledger_limit = 200

    def setUp(self):
        self.env = WiredEnv(mode=self.mode, ledger_limit=self.ledger_limit)
        self.addCleanup(self.env.cleanup)
        self.env.envelope()
        self.env.s2_heartbeat()
        self.body = make_body(self.env.policy)
        self.env.issue.publish(self.body)

    def claim(self, body=None):
        run_id, reason = self.env.control.try_claim(body or self.body, TRUSTED_ISSUE, time.time())
        self.assertIsNotNone(run_id, reason)
        return run_id

    def handle(self, run_id, scenario=None):
        stub, reason = self.env.agent.handle_request_file(self.env.layout.request_file(run_id), scenario=scenario)
        self.assertIsNotNone(stub, reason)
        self.addCleanup(lambda: (stub.poll() is None and stub.kill(), stub.wait(timeout=30)))
        return stub

    def wait_terminal(self, run_id, timeout=30):
        deadline = time.time() + timeout
        while time.time() < deadline:
            e = registry.load(self.env.layout, run_id)
            if e and e["state"] not in registry.NON_TERMINAL:
                return e
            time.sleep(0.05)
        self.fail("run did not reach a terminal state: %s" % run_id)

    def wait_used(self, run_id, state, timeout=15):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if state in self.env.agent.used_state(run_id):
                return
            time.sleep(0.05)
        self.fail("used_requests never reached %s" % state)

    def assert_not_started(self, run_id, stub, reason_part):
        stub.wait(timeout=30)
        self.assertNotIn("SPAWNED", self.env.agent.used_state(run_id))
        e = registry.load(self.env.layout, run_id)
        self.assertEqual(e["state"], "aborted_before_spawn")
        self.assertIn(reason_part, e.get("abort_reason", ""))

    def sigs(self, path):
        return [json.loads(line)["sig"] for line in open(path, encoding="utf-8") if line.strip()]


class WiredEndToEnd(WiredBase):
    def test_happy_path_through_every_wired_part(self):
        before = self.env.ledger_sent()
        run_id = self.claim()
        stub = self.handle(run_id, scenario={"sleep": 1.0, "result": "調査しました。\npending_questions: なし"})
        stub.wait(timeout=60)
        self.wait_terminal(run_id, 60)
        status, end = self.env.control.finalize(run_id, current_body=self.body)
        self.assertEqual(status, "ended_checks_passed", end["payload"])
        self.assertEqual(self.env.agent.used_state(run_id), ["ACCEPTED", "SPAWNING", "SPAWNED"])
        run_dir = self.env.layout.run_dir(run_id)
        spawn = read_json(os.path.join(run_dir, "spawn_evidence.json"))
        self.assertTrue(spawn["sig"].startswith(ec.PREFIX))  # 起動直前の再取得（別プロセス）も ECDSA の witness
        self.assertEqual(spawn["evidence"]["purpose"], "spawn")
        monitor = [json.loads(line) for line in open(os.path.join(run_dir, "issue_monitor.jsonl"))]
        self.assertTrue(monitor and all(r["ok"] for r in monitor))
        # CLAIM・起動直前・監督（1回以上）・finalize の取得が、すべて共有の台帳に予約されている（別プロセスを含む）
        self.assertGreaterEqual(self.env.ledger_sent() - before, 4)
        for log in (self.env.layout.control_events, self.env.layout.used_requests):
            sigs = self.sigs(log)
            self.assertTrue(sigs and all(s.startswith(ec.PREFIX) for s in sigs), log)
        report = open(os.path.join(self.env.layout.reports, run_id + ".md"), encoding="utf-8").read()
        for needle in ("type: REPORT", "next_task_allowed: false", "ended_checks_passed", "K10"):
            self.assertIn(needle, report)
        # 実 CLI の計画（実行しない）は、偽Claude が使ったのと同じ要求の値を使う。起動後は二度目の起動を許さない
        req = read_json(self.env.layout.request_file(run_id))["request"]
        prompt, settings = os.path.join(run_dir, "prompt.md"), os.path.join(run_dir, "settings.json")
        plan = ccp.build_plan("/opt/claude-cli/2.1.305", req, prompt, settings, "/Users/_g10runner")
        self.assertEqual(ccp.consistent_with_fake(plan, adapter.FakeClaudeAdapter().command(req, prompt, settings)), [])
        pinned = {"realpath": "/opt/claude-cli/2.1.305", "version": "2.1.305"}
        probe = lambda: {"found": True, "realpath": pinned["realpath"], "executable": True,  # noqa: E731
                         "version_from_path": "2.1.305"}
        self.assertIn("at-most-once", ccp.prelaunch_check(plan, req, prompt, settings, "/Users/_g10runner", pinned,
                                                          self.env.agent.used_state(run_id), probe))
        self.assertIsNone(ccp.prelaunch_check(plan, req, prompt, settings, "/Users/_g10runner", pinned,
                                              ["ACCEPTED", "SPAWNING"], probe))

    def test_spawn_refetch_failure_does_not_start(self):
        run_id = self.claim()
        self.env.issue.fail = "github unavailable"
        # 取得元の token 確認（/rate_limit）の段階で失敗する: 取得係を作れないので起動しない
        self.assert_not_started(run_id, self.handle(run_id, {"sleep": 0.2}),
                                "issue witness unavailable at spawn: IssueSourceError")

    def test_issue_changed_between_claim_and_spawn_does_not_start(self):
        run_id = self.claim()
        self.env.issue.publish(self.body.replace("readonly_trial only.", "readonly_trial only!"),
                               updated_at=time.time() + 2)
        self.assert_not_started(run_id, self.handle(run_id, {"sleep": 0.2}), "issue changed or unverifiable at spawn")

    def test_rate_shortage_before_claim_does_not_claim(self):
        self.env.fill_ledger()
        run_id, reason = self.env.control.try_claim(self.body, TRUSTED_ISSUE, time.time())
        self.assertIsNone(run_id)
        self.assertEqual(os.listdir(self.env.layout.requests), [])

    def test_rate_shortage_at_spawn_does_not_start(self):
        run_id = self.claim()
        self.env.fill_ledger()
        self.assert_not_started(run_id, self.handle(run_id, {"sleep": 0.2}),
                                "issue re-fetch failed at spawn: RateLimited")

    def test_server_rate_limit_at_spawn_does_not_start(self):
        run_id = self.claim()
        self.env.issue.rate_limited = True
        self.assert_not_started(run_id, self.handle(run_id, {"sleep": 0.2}),
                                "issue re-fetch failed at spawn: RateLimited")
        self.assertIsNotNone(read_json(self.env.ledger_path)["blocked_until"])  # 待つ時刻を台帳に残す（共有）

    def test_identity_swaps_are_refused_at_claim(self):
        cases = {"author": dict(author="someone-else"), "editor": dict(editor="someone-else"),
                 "issue number": dict(number=324), "repository": dict(repo="someone/kabumori"),
                 "closed": dict(state="CLOSED")}
        for name, over in cases.items():
            with self.subTest(case=name):
                self.env.issue.publish(self.body, **over)
                run_id, reason = self.env.control.try_claim(self.body, TRUSTED_ISSUE, time.time())
                self.assertIsNone(run_id, name)
        self.assertEqual(os.listdir(self.env.layout.requests), [])

    def test_trusted_editor_is_accepted(self):
        self.env.issue.publish(self.body, editor="anohi-memories")
        self.claim()

    def test_replay_and_double_start_do_nothing(self):
        run_id = self.claim()
        self.handle(run_id, {"sleep": 0.3}).wait(timeout=60)
        self.wait_terminal(run_id, 60)
        self.assertEqual(self.env.agent.spawn_stub(run_id).wait(timeout=60), 3)
        again, reason = self.env.agent.handle_request_file(self.env.layout.request_file(run_id))
        self.assertIsNone(again)
        self.assertIn("already used", reason)
        self.assertEqual(self.env.agent.used_state(run_id).count("SPAWNED"), 1)

    def test_request_signed_with_a_leaked_hmac_key_is_refused(self):
        run_id = self.claim()
        path = self.env.layout.request_file(run_id)
        doc = read_json(path)
        leaked = signing.HmacTestSigner({"runner": signing.test_keys()["runner"]})
        doc["sig"] = leaked.sign("runner", canonical(doc["request"]))  # ecdsa では HMAC を受け付けない
        atomic_write_json(path, doc)
        stub, reason = self.env.agent.handle_request_file(path)
        self.assertIsNone(stub)
        self.assertIn("bad request signature", reason)

    def test_revoke_stops_the_running_fake(self):
        run_id = self.claim()
        self.handle(run_id, {"sleep": 30})
        self.wait_used(run_id, "SPAWNED")
        self.env.control.revoke_issue(task_id="g10-phase2-test-20261022", reason="test")
        e = self.wait_terminal(run_id, 30)
        self.assertEqual(e["stop_reason"], "issue_revoked")


class WiredMonitor(WiredBase):
    """実行中の監督（S1・別プロセス）も、結線した取得元・台帳・ECDSA で動き、変更・回数不足で止める。"""

    def setUp(self):
        super().setUp()
        self.body = make_body(self.env.policy, max_minutes="60")  # 期限（試験では 60×0.5秒）を監督の2回目より後に
        self.env.issue.publish(self.body)

    def start_running(self):
        run_id = self.claim()
        self.handle(run_id, {"sleep": 30})
        self.wait_used(run_id, "SPAWNED")
        return run_id

    def test_body_change_while_running_stops_the_run(self):
        run_id = self.start_running()
        self.env.issue.publish(self.body.replace("readonly_trial only.", "readonly_trial only!"),
                               updated_at=time.time() + 2)
        e = self.wait_terminal(run_id, 30)
        self.assertEqual(e.get("stop_reason"), "issue_changed_while_running")
        lines = [json.loads(x) for x in open(os.path.join(self.env.layout.run_dir(run_id), "issue_monitor.jsonl"))]
        self.assertFalse(lines[-1]["ok"])

    def test_rate_shortage_while_running_stops_the_run(self):
        run_id = self.start_running()
        self.env.fill_ledger()
        e = self.wait_terminal(run_id, 30)
        self.assertEqual(e.get("stop_reason"), "issue_changed_while_running")
        lines = [json.loads(x) for x in open(os.path.join(self.env.layout.run_dir(run_id), "issue_monitor.jsonl"))]
        self.assertIn("RateLimited", lines[-1].get("reason") or "")


class SignatureMigration(WiredBase):
    """HMAC → dual → ECDSA の段階的切替（同じルート）。"""
    mode = "hmac"

    def run_once(self, approval_id, task_id):
        body = make_body(self.env.policy, approval_id=approval_id, task_id=task_id)
        self.env.issue.publish(body)
        run_id = self.claim(body)
        self.handle(run_id, {"sleep": 0.3}).wait(timeout=60)
        self.wait_terminal(run_id, 60)
        status, end = self.env.control.finalize(run_id, current_body=body)
        self.assertEqual(status, "ended_checks_passed", end["payload"])
        return run_id

    def test_hmac_then_dual_then_ecdsa_requires_new_logs(self):
        first = self.run_once("g10-p2-test-0001", "g10-phase2-test-20261022")
        self.assertIn("SPAWNED", self.env.agent.used_state(first))
        logs = (self.env.layout.used_requests, self.env.layout.ledger)  # 実行側・制御側の記録簿
        old = {log: self.sigs(log) for log in logs}
        for log in logs:
            self.assertTrue(old[log] and all(s.startswith("hmac-sha256:") for s in old[log]), log)
        self.env.apply_mode("dual")  # 署名は ECDSA に。古い HMAC の記録はまだ検証できる
        second = self.run_once("g10-p2-test-0002", "g10-phase2-test-20261023")
        self.assertIn("SPAWNED", self.env.agent.used_state(second))
        for log in logs:
            new = self.sigs(log)[len(old[log]):]
            self.assertTrue(new and all(s.startswith(ec.PREFIX) for s in new), log)
        self.env.apply_mode("ecdsa", approve=False)  # HMAC の記録が残る記録簿は検証できない: 止まる（記録簿を新しくする）
        with self.assertRaises(ChainError):
            self.env.agent.current_state()
        with self.assertRaises(ChainError):
            self.env.control.read_state()

    def test_ecdsa_refuses_a_leftover_hmac_key_file(self):
        self.env.apply_mode("dual")
        self.env.apply_mode("ecdsa", approve=False)
        signing.write_test_keys(self.env.tmp)
        with self.assertRaises(wiring.WiringError):
            wiring.agent_side(self.env.tmp)
        with self.assertRaises(wiring.WiringError):
            wiring.spawn_witness(self.env.tmp, self.env.policy)


class Transitions(unittest.TestCase):
    def test_only_one_step_forward(self):
        ok = {("hmac", "hmac"), ("hmac", "dual"), ("dual", "dual"), ("dual", "ecdsa"), ("ecdsa", "ecdsa")}
        for old in wiring.SIG_MODES + ("x",):
            for new in wiring.SIG_MODES + ("x",):
                with self.subTest(old=old, new=new):
                    self.assertEqual(wiring.mode_transition_allowed(old, new), (old, new) in ok)


if __name__ == "__main__":
    unittest.main()
