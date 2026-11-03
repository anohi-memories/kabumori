"""B6 無人 producer の判定: 有効な ENVELOPE（人の日次同意）の下で #323 の ready・未claim・窓内 TASK を emit 判定する。
ENVELOPE 無し・claim 済み・窓外では emit しない。実 Claude は呼ばない（起動は exec の resident）。"""
import time
import unittest

from g10runner import producer
from helpers import EnvTestCase, TRUSTED_ISSUE, make_body


class ProducerEvaluate(EnvTestCase):
    def _publish(self, **kw):
        body = make_body(self.env.policy, **kw)
        self.env.issue.publish(body)
        return body

    def test_emit_when_envelope_covers_ready_unclaimed_task(self):
        self._publish()
        self.env.envelope()
        d = producer.evaluate(self.env.control, self.env.policy)
        self.assertEqual(d["decision"], "emit", d)
        self.assertEqual(d["approval_id"], "g10-p2-test-0001")

    def test_idle_without_an_envelope(self):
        self._publish()  # ready な TASK はあるが、人の日次同意（ENVELOPE）が無い
        d = producer.evaluate(self.env.control, self.env.policy)
        self.assertEqual(d["decision"], "idle")
        self.assertIn("no active envelope", d["reason"])

    def test_idle_when_approval_already_claimed(self):
        body = self._publish()
        self.env.envelope()
        self.assertIsNotNone(self.env.control.try_claim(body, TRUSTED_ISSUE, time.time())[0])
        d = producer.evaluate(self.env.control, self.env.policy)
        self.assertEqual(d["decision"], "idle")
        self.assertIn("already used", d["reason"])

    def test_idle_when_task_outside_envelope(self):
        self._publish()
        self.env.envelope(scopes=["limited_code_edit"])  # readonly_trial を覆わない窓
        d = producer.evaluate(self.env.control, self.env.policy)
        self.assertEqual(d["decision"], "idle")
        self.assertIn("outside the active envelope", d["reason"])


if __name__ == "__main__":
    unittest.main()
