"""NORM-1 のテストベクトル（仕様 v5 §4-3、v5.1 §3-2、v5.2 §2-4）。期待値は仕様に記載の値。"""
import os
import unicodedata
import unittest

from g10runner import norm

FIX = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")
V1 = ("# G10-02 phase2 trial\n- slot: G10\n- task_id: g10-phase2-readonly-trial-20261021\n- status: ready\n"
      "- phase2_run: approved\n- phase2_task_sha256: " + "0" * 64 + "\n- base_ref: main\n")
V1_HASH = "66fd5841016d9668bd27caa9d1b569f8b6863a697f317e56dd02c320ee9dddba"
V4_HASH = "ea2706d9c7de3af7426f39ddfb0b4efe3e04f788ba6a8d7322a73b4f867e15d1"
V7A = "# G10-02 unicode check\n- slot: G10\n- note: café\n- phase2_task_sha256: " + "0" * 64 + "\n"
V7A_HASH = "1b2b162cd6fbfa16ea4db978b20d234bb049459d17f18c44ab033139395d91c5"
V7B_HASH = "5596b638768801ec67d379457fd446797ccd37acbf81f28a6cbc9e9e6d1ed3a5"
L7A = "- note: café\n- phase2_task_sha256: x\n"
L7A_HASH = "1b0aa388d3633978c6195382ca43730ad0edf3102a4cd378d3c1591c7544241d"
L7B_HASH = "41fc4321fe18829c7bcf273a3647ed880192a4ef2578bb9931db51da288a3b01"
V10_HASH = "e9250e2f8c36c5969ce2a0e5ae1db0e9b44f8195b14b40926b8097b15e11c157"


class TestVectors(unittest.TestCase):
    def test_v1(self):
        self.assertEqual(norm.compute_hash(V1), V1_HASH)

    def test_v2_crlf_and_trailing_spaces(self):
        v2 = V1.replace("\n", "  \r\n")
        self.assertEqual(norm.compute_hash(v2), V1_HASH)

    def test_v3_hash_value_is_ignored(self):
        self.assertEqual(norm.compute_hash(V1.replace("0" * 64, "f" * 64)), V1_HASH)

    def test_v4_content_change(self):
        self.assertEqual(norm.compute_hash(V1.replace("status: ready", "status: idle")), V4_HASH)

    def test_v5_no_hash_line(self):
        with self.assertRaises(norm.NormError):
            norm.compute_hash(V1.replace("- phase2_task_sha256: " + "0" * 64 + "\n", ""))

    def test_v6_two_hash_lines(self):
        with self.assertRaises(norm.NormError):
            norm.compute_hash(V1 + "- phase2_task_sha256: " + "1" * 64 + "\n")

    def test_v7a_v7b_no_unicode_normalization(self):
        self.assertEqual(norm.compute_hash(V7A), V7A_HASH)
        self.assertEqual(norm.compute_hash(unicodedata.normalize("NFD", V7A)), V7B_HASH)

    def test_l7_low_level_and_l7c(self):
        self.assertEqual(norm.norm1_digest(L7A), L7A_HASH)
        self.assertEqual(norm.norm1_digest(unicodedata.normalize("NFD", L7A)), L7B_HASH)
        with self.assertRaises(norm.NormError):
            norm.compute_hash(L7A)  # L7c: 領域がない

    def test_v8_trailing_blank_lines(self):
        self.assertEqual(norm.compute_hash(V1 + "\n\n\n"), V1_HASH)

    def test_v9_bom(self):
        with self.assertRaises(norm.NormError):
            norm.compute_hash("﻿" + V1)

    def test_v10_full_example(self):
        with open(os.path.join(FIX, "v52_example_placeholder.md"), encoding="utf-8") as f:
            body = f.read()
        self.assertEqual(norm.compute_hash(body), V10_HASH)
        self.assertEqual(norm.compute_hash(body.replace("0" * 64, V10_HASH, 1)), V10_HASH)

    def test_hash_line_outside_region_rejected(self):
        for wrapper in ("\n```\n- phase2_task_sha256: %s\n```\n", "\n> - phase2_task_sha256: %s\n",
                        "\n<!--\n- phase2_task_sha256: %s\n-->\n", "\n    - phase2_task_sha256: %s\n"):
            with self.subTest(wrapper=wrapper):
                with self.assertRaises(norm.NormError):
                    norm.compute_hash(V1 + wrapper % ("1" * 64))

    def test_lone_surrogate_rejected(self):
        with self.assertRaises(norm.NormError):
            norm.compute_hash(V1 + "\ud800\n")

    def test_placeholder_detection(self):
        self.assertTrue(norm.is_placeholder("0" * 64))
        self.assertFalse(norm.is_placeholder(V1_HASH))


if __name__ == "__main__":
    unittest.main()
