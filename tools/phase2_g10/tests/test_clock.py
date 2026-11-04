"""日次 04:00 JST の失効と時計の検査（仕様 v5 §5-2・§5-3、v5.1 §6-2）。"""
import datetime
import unittest

from g10runner import jstclock

JST = jstclock.JST


def at(y, mo, d, h, mi, s):
    return datetime.datetime(y, mo, d, h, mi, s, tzinfo=JST).timestamp()


class TestRollover(unittest.TestCase):
    def test_boundaries(self):
        cases = [
            (at(2026, 10, 21, 3, 59, 59), at(2026, 10, 21, 4, 0, 0)),
            (at(2026, 10, 21, 4, 0, 0), at(2026, 10, 22, 4, 0, 0)),
            (at(2026, 10, 21, 4, 0, 1), at(2026, 10, 22, 4, 0, 0)),
            (at(2026, 10, 21, 23, 59, 59), at(2026, 10, 22, 4, 0, 0)),
            (at(2026, 12, 31, 22, 0, 0), at(2027, 1, 1, 4, 0, 0)),
        ]
        for approved, expected in cases:
            with self.subTest(approved=jstclock.jst_text(approved)):
                self.assertEqual(jstclock.next_rollover(approved), expected)

    def test_expiry_is_inclusive(self):
        exp = at(2026, 10, 22, 4, 0, 0)
        self.assertFalse(jstclock.is_expired(exp, exp - 1))
        self.assertTrue(jstclock.is_expired(exp, exp))

    def test_independent_of_local_timezone(self):
        import os
        import time
        old = os.environ.get("TZ")
        try:
            os.environ["TZ"] = "America/Los_Angeles"
            time.tzset()
            self.assertEqual(jstclock.next_rollover(at(2026, 10, 21, 10, 0, 0)), at(2026, 10, 22, 4, 0, 0))
        finally:
            if old is None:
                os.environ.pop("TZ", None)
            else:
                os.environ["TZ"] = old
            time.tzset()


class TestClockChecks(unittest.TestCase):
    def test_reference_missing_blocks(self):
        self.assertEqual(jstclock.clock_problem(1000.0, None), "reference_clock_unavailable")

    def test_skew(self):
        self.assertEqual(jstclock.clock_problem(1000.0, 1000.0 + 301), "clock_skew")
        self.assertIsNone(jstclock.clock_problem(1000.0, 1000.0 + 299))

    def test_backward_anomaly(self):
        self.assertEqual(jstclock.clock_problem(1000.0, 1000.0, last_record_ts=1000.0 + 301), "CLOCK_ANOMALY")
        self.assertIsNone(jstclock.clock_problem(1000.0, 1000.0, last_record_ts=1000.0 + 299))

    def test_envelope_usable_needs_both_clocks_before_expiry(self):
        exp = 5000.0
        self.assertTrue(jstclock.envelope_usable(exp, 4000.0, 4000.0))
        self.assertFalse(jstclock.envelope_usable(exp, 5000.0, 4000.0))
        self.assertFalse(jstclock.envelope_usable(exp, 4000.0, 5000.0))
        self.assertFalse(jstclock.envelope_usable(exp, 4000.0, None))


if __name__ == "__main__":
    unittest.main()
