"""TASK本文の検証（仕様 v5 §3、v5.1 §4、v5.2 §2・§3）。"""
import os
import unittest

from g10runner import meta, norm
from helpers import make_body, test_policy
from g10runner import policy as policy_mod

FIX = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures")


def pol():
    return policy_mod.with_digest(test_policy())


class TestValidTask(unittest.TestCase):
    def test_valid_body_passes(self):
        p = pol()
        r = meta.validate_task(make_body(p), p)
        self.assertTrue(r.ok, r.problems)

    def test_current_issue323_impl_task_is_not_auto_runnable(self):
        """現在の #323（実装TASK・自動実行用ではない）は、Phase 2 の自動実行の検証に通らない。"""
        with open(os.path.join(FIX, "issue323_impl_task_20261021.md"), encoding="utf-8") as f:
            body = f.read()
        r = meta.validate_task(body, pol())
        self.assertFalse(r.ok)
        self.assertTrue(any("missing key: phase2_run" in x for x in r.problems))


class TestRejections(unittest.TestCase):
    def check_rejected(self, mutate, expect=None, fix_hash=True):
        p = pol()
        body = make_body(p, mutate=mutate, fix_hash=fix_hash)
        r = meta.validate_task(body, p)
        self.assertFalse(r.ok, "should be rejected")
        if expect:
            self.assertTrue(any(expect in x for x in r.problems), r.problems)
        return r

    def test_each_required_value_breakage(self):
        cases = [
            ("- slot: G10", "- slot: G9"), ("- status: ready", "- status: idle"),
            ("- owner: claude", "- owner: chatgpt"), ("- next_owner: claude", "- next_owner: none"),
            ("- completion_code: K10", "- completion_code: K9"),
            ("- production_permission: NO_GO", "- production_permission: GO"),
            ("- generation_limit: 50", "- generation_limit: 49"),
            ("- automation_enabled: true", "- automation_enabled: false"),
            ("- automation_mode: local_cli", "- automation_mode: cloud"),
            ("- automation_approval: approved", "- automation_approval: pending"),
            ("- phase2_run: approved", "- phase2_run: yes"),
            ("- phase2_norm: NORM-1", "- phase2_norm: NORM-2"),
            ("- phase2_scope: readonly_trial", "- phase2_scope: code_change"),
            ("- phase2_report_mode: local_only", "- phase2_report_mode: github"),
            ("- base_ref: refs/heads/main", "- base_ref: main"),
            ("- base_ref: refs/heads/main", "- base_ref: refs/heads/../main"),
            ("- base_sha: 0c42933ca5030ab31a56267529430d0473d9b155", "- base_sha: 0c42933c"),
            ("- model: sonnet", "- model: haiku"),
            ("- phase2_model_id: claude-sonnet-5-5", "- phase2_model_id: claude-opus-5-5"),
            ("- effort: medium", "- effort: extreme"),
            ("- max_budget_usd: 0.50", "- max_budget_usd: 0.51"),
            ("- max_budget_usd: 0.50", "- max_budget_usd: 1"),
            ("- phase2_approval_id: g10-p2-test-0001", "- phase2_approval_id: short"),
        ]
        for old, new in cases:
            with self.subTest(change=new):
                self.check_rejected(lambda b, o=old, n=new: b.replace(o, n, 1))

    def test_max_minutes_rules(self):
        for bad in ("121", "0", "010", "1.5", "abc"):
            with self.subTest(value=bad):
                self.check_rejected(None) if False else None
                p = pol()
                body = make_body(p, max_minutes=bad)
                self.assertFalse(meta.validate_task(body, p).ok)

    def test_missing_each_key(self):
        p = pol()
        base = make_body(p, fix_hash=False)
        for key in list(meta.COMMON_REQUIRED) + list(meta.PHASE1_KEYS) + list(meta.PHASE2_KEYS) + ["generation_limit"]:
            with self.subTest(key=key):
                lines = [ln for ln in base.split("\n") if not ln.startswith("- %s: " % key)]
                self.assertFalse(meta.validate_task("\n".join(lines), p).ok)

    def test_placeholder_hash_rejected(self):
        p = pol()
        self.assertFalse(meta.validate_task(make_body(p, fix_hash=False), p).ok)

    def test_policy_digest_and_version_must_match(self):
        p = pol()
        body = make_body(p)
        other = policy_mod.with_digest(test_policy(version="policy-v2"))
        self.assertFalse(meta.validate_task(body, other).ok)

    def test_duplicate_key_in_region(self):
        self.check_rejected(lambda b: b.replace("- slot: G10\n", "- slot: G10\n- slot: G10\n", 1), "duplicate")

    def test_migration_state_blocks(self):
        for value in ("PREPARED_NOT_CUTOVER", "DONE"):
            with self.subTest(value=value):
                self.check_rejected(lambda b, v=value: b.replace("- generation_limit: 50\n",
                                                                 "- generation_limit: 50\n- migration_state: %s\n" % v, 1),
                                    "migration_state")

    def test_known_field_outside_region_rejected(self):
        for snippet in ("\n```\n- phase2_run: approved\n```\n", "\n> - task_id: other-task-id\n",
                        "\n<!--\n- slot: G10\n-->\n", "\n    - base_sha: " + "a" * 40 + "\n",
                        "\n- max_minutes: 120\n"):
            with self.subTest(snippet=snippet):
                self.check_rejected(lambda b, s=snippet: b + s, "outside the formal region")

    def test_prose_mention_of_key_is_allowed(self):
        p = pol()
        body = make_body(p, mutate=lambda b: b + "\n補足: task_id と `phase2_run` は担当ちゃが書く。\n")
        r = meta.validate_task(body, p)
        self.assertTrue(r.ok, r.problems)

    def test_forbidden_characters(self):
        for ch in ("​", "‮", "⁦", "\x07"):
            with self.subTest(ch=repr(ch)):
                self.check_rejected(lambda b, c=ch: b.replace("- return_to: G10担当ちゃ", "- return_to: G10担当" + c + "ちゃ", 1))

    def test_non_ascii_in_strict_key(self):
        self.check_rejected(lambda b: b.replace("- task_id: g10-phase2-test-20261022", "- task_id: g10-テスト-20261022", 1))

    def test_unknown_phase2_key(self):
        self.check_rejected(lambda b: b.replace("- phase2_run: approved\n", "- phase2_run: approved\n- phase2_runn: approved\n", 1),
                            "unknown phase2 key")

    def test_optional_generation_counters(self):
        p = pol()
        ok = make_body(p, mutate=lambda b: b.replace("- generation_limit: 50\n",
                                                     "- generation_task_no: 3\n- completed_tasks_in_generation: 2\n- generation_limit: 50\n- review_required: true（説明）\n", 1))
        self.assertTrue(meta.validate_task(ok, p).ok, meta.validate_task(ok, p).problems)
        for bad in ("- generation_task_no: x\n", "- generation_task_no: 3\n- completed_tasks_in_generation: 4\n",
                    "- review_required: maybe\n", "- generation_task_no: 51\n- completed_tasks_in_generation: 0\n"):
            with self.subTest(bad=bad):
                self.check_rejected(lambda b, s=bad: b.replace("- generation_limit: 50\n", s + "- generation_limit: 50\n", 1))

    def test_additional_required_keys_policy(self):
        p = policy_mod.with_digest(test_policy(phase2_additional_required_keys=["generation_task_no"]))
        self.assertFalse(meta.validate_task(make_body(p), p).ok)

    def test_sections_required(self):
        for name in ("## 目的", "## preflight", "## 実行", "## 安全", "## tests・完了条件"):
            with self.subTest(section=name):
                self.check_rejected(lambda b, n=name: b.replace(n + "\n", "## 別名\n", 1))

    def test_related_pr_rules(self):
        self.check_rejected(lambda b: b.replace("- 関連PR: なし（", "- 関連PRメモ: なし（", 1), "関連PR")
        self.check_rejected(lambda b: b.replace("- 関連PR: なし（読み取り専用の初回調査。基点HEADのみ: 上の base_ref と base_sha）\n",
                                                "- 関連PR: なし\n- 関連PR: なし\n", 1), "関連PR")
        self.check_rejected(lambda b: b.replace("- generation_limit: 50\n",
                                                "- generation_limit: 50\n- target_pr: https://github.com/anohi-memories/kabumori/pull/999\n- pinned_head: " + "a" * 40 + "\n", 1))
        self.check_rejected(lambda b: b.replace("- generation_limit: 50\n", "- generation_limit: 50\n- pinned_head: none\n", 1))

    def test_related_pr_present_consistent(self):
        p = pol()
        sha = "0c42933ca5030ab31a56267529430d0473d9b155"

        def mut(b):
            b = b.replace("- base_ref: refs/heads/main", "- base_ref: refs/pull/999/head")
            b = b.replace("- generation_limit: 50\n", "- generation_limit: 50\n- target_pr: https://github.com/anohi-memories/kabumori/pull/999\n- pinned_head: %s\n" % sha, 1)
            return b.replace("- 関連PR: なし（読み取り専用の初回調査。基点HEADのみ: 上の base_ref と base_sha）",
                             "- 関連PR: https://github.com/anohi-memories/kabumori/pull/999", 1)
        body = make_body(p, mutate=mut)
        r = meta.validate_task(body, p)
        self.assertTrue(r.ok, r.problems)
        bad = make_body(p, mutate=lambda b: mut(b).replace("pull/999/head", "pull/998/head"))
        self.assertFalse(meta.validate_task(bad, p).ok)

    def test_report_terms_required(self):
        self.check_rejected(lambda b: b.replace("next_task_allowed:false", "next_task:false", 1), "next_task_allowed")
        self.check_rejected(lambda b: b.replace("本文の編集は禁止", "本文は自由", 1), "本文編集禁止")

    def test_title_and_region_required(self):
        p = pol()
        body = make_body(p)
        self.assertFalse(meta.validate_task(body.split("\n", 1)[1], p).ok)
        self.assertFalse(meta.validate_task(body.replace("\n- task_id", "\n\n- task_id", 1), p).ok)

    def test_bom_rejected(self):
        p = pol()
        self.assertFalse(meta.validate_task("﻿" + make_body(p), p).ok)


if __name__ == "__main__":
    unittest.main()
