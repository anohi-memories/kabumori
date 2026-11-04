"""textutil の伏せ字（TASK 26: 次の実機の限定コード編集の試験の題材。ここに試験を加えてもらう）。"""
import unittest

from g10runner.textutil import redact, safe


class Redact(unittest.TestCase):

    def test_known_token_shapes_are_redacted(self):
        for text in ("ghp_" + "a" * 20, "github_pat_" + "b" * 20, "sk-ant-" + "c" * 20, "f" * 40):
            with self.subTest(text=text[:12]):
                self.assertEqual(redact("x %s y" % text), "x [REDACTED] y")

    def test_labelled_secrets_keep_the_label(self):
        self.assertEqual(redact("password=hunter2"), "password [REDACTED]")
        self.assertEqual(redact("Authorization: Bearer abc.def"), "Authorization [REDACTED]")

    def test_plain_text_is_unchanged(self):
        self.assertEqual(redact("読み取り専用の調査 run-1234"), "読み取り専用の調査 run-1234")

    def test_safe_redacts_before_truncating(self):
        self.assertEqual(safe("ghp_" + "a" * 30, limit=8), "[REDACTE")


if __name__ == "__main__":
    unittest.main()
