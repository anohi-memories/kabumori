"""Issue の鮮度・取消（TASK 5）の反例の固定。修正前HEAD（f6ebcbce）では失敗し、修正後に通ることを確認する。

CLAIM 時に取得した（有効時間内の）署名つき証拠だけで、その後の Issue の変化を見ずに起動できてしまう:
CLOSED（本文は不変）・idle・review_required・本文の変更・同じ本文での世代（updated_at）の変更・取得の失敗。
終了後に CLOSED だけの変更があっても、finalize が成功にしてしまう。取得できなくても成功にしてしまう。

修正前のコードでも動くように、振る舞いだけを使う。
"""
import os
import time

from g10runner import registry
from helpers import EnvTestCase, TRUSTED_ISSUE, make_body


class SpawnAfterIssueChange(EnvTestCase):
    def setUp(self):
        super().setUp()
        self.env.envelope()
        self.env.s2_heartbeat()
        self.body = make_body(self.env.policy)
        self.env.issue.publish(self.body)
        self.run_id, reason = self.env.control.try_claim(self.body, TRUSTED_ISSUE, time.time())
        self.assertIsNotNone(self.run_id, reason)
        self.marker = os.path.join(self.env.tmp, "started")

    def run_after(self, change):
        change()
        stub, reason = self.env.agent.handle_request_file(self.env.layout.request_file(self.run_id),
                                                          scenario={"started_marker": self.marker})
        if stub is not None:
            stub.wait(timeout=30)
            e = registry.load(self.env.layout, self.run_id)
            if e is not None:
                self.wait_terminal(self.run_id)
        self.assertFalse(os.path.exists(self.marker), "fake Claude was started after the Issue changed")
        self.assertNotIn("SPAWNED", self.env.agent.used_state(self.run_id))

    def changed_body(self, old, new):
        return make_body(self.env.policy, mutate=lambda b: b.replace(old, new, 1))

    def test_closed_after_claim(self):
        self.run_after(lambda: self.env.issue.publish(self.body, state="CLOSED"))

    def test_idle_after_claim(self):
        self.run_after(lambda: self.env.issue.publish(self.changed_body("- status: ready", "- status: idle")))

    def test_review_required_after_claim(self):
        self.run_after(lambda: self.env.issue.publish(
            self.changed_body("- status: ready", "- status: review_required")))

    def test_body_changed_after_claim(self):
        self.run_after(lambda: self.env.issue.publish(self.changed_body("食い違い", "差異")))

    def test_same_body_new_generation_after_claim(self):
        self.run_after(lambda: self.env.issue.publish(self.body, updated_at=time.time() + 1))

    def test_issue_fetch_fails_after_claim(self):
        def fail():
            self.env.issue.fail = "network down"
        self.run_after(fail)


class FinalizeIssueState(EnvTestCase):
    def setUp(self):
        super().setUp()
        self.env.envelope()
        self.env.s2_heartbeat()

    def test_close_only_after_run_is_not_success(self):
        run_id, stub, body = self.claim_and_run()
        self.env.issue.publish(body, state="CLOSED")  # 本文は不変
        status, end = self.env.control.finalize(run_id, current_body=body)
        self.assertNotEqual(status, "ended_checks_passed", "a close-only Issue change went unnoticed")
        self.assertTrue(self.env.control.read_state().hard_halted)

    def test_issue_unfetchable_at_finalize_is_not_success(self):
        run_id, stub, body = self.claim_and_run()
        self.env.issue.fail = "network down"
        status, end = self.env.control.finalize(run_id, current_body=body)
        self.assertNotEqual(status, "ended_checks_passed", "finalize succeeded without the current Issue state")
