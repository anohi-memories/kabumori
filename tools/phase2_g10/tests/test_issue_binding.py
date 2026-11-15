"""H4 P1 の個別試験: Issue #323 の取得証拠との結合（制御側・実行側・スタブの最終判定・finalize）。"""
import json
import os
import time

from g10runner import issue as issue_mod, norm, registry, signing
from g10runner.control import Control
from g10runner.fsutil import canonical
from helpers import Env, EnvTestCase, TRUSTED_ISSUE, make_body, test_policy, FAST_TIMING


def resign(env, path, mutate):
    doc = json.load(open(path))
    mutate(doc["request"])
    doc["sig"] = env.control_signer.sign("runner", canonical(doc["request"]))
    json.dump(doc, open(path, "w"))
    return doc


class ControlSide(EnvTestCase):
    """制御側: Issue を新しく取得し、現役TASKの本文と完全に同じでなければ CLAIM しない。"""

    def setUp(self):
        super().setUp()
        self.env.envelope()
        self.body = make_body(self.env.policy)

    def claim(self, body=None):
        return self.env.control.try_claim(body or self.body, TRUSTED_ISSUE, time.time())

    def assert_refused(self, expect):
        run_id, reason = self.claim()
        self.assertIsNone(run_id)
        self.assertIn(expect, reason)
        self.assertEqual([r for r in self.env.control.ledger.read_all() if r["type"] == "CLAIM"], [])

    def test_published_task_is_claimed(self):
        self.env.issue.publish(self.body)
        run_id, reason = self.claim()
        self.assertIsNotNone(run_id, reason)
        claim = [r for r in self.env.control.ledger.read_all() if r["type"] == "CLAIM"][0]["payload"]
        req = json.load(open(self.env.layout.request_file(run_id)))["request"]
        self.assertEqual(claim["issue_evidence_sha256"], issue_mod.evidence_digest(req["issue_evidence"]))

    def test_unpublished_task_refused(self):
        self.env.issue.publish(make_body(self.env.policy, task_id="g10-phase2-other-20261022"))
        self.assert_refused("task body differs from the current Issue #323 body")

    def test_issue_not_available_or_fetch_error(self):
        self.assert_refused("issue fetch failed")  # 何も載っていない
        self.env.issue.publish(self.body)
        self.env.issue.fail = "network down"
        self.assert_refused("issue fetch failed")

    def test_issue_conditions(self):
        cases = {"closed": ({"state": "CLOSED"}, "issue is not open"),
                 "other author": ({"author": "someone-else"}, "author/editor not trusted"),
                 "other editor": ({"editor": "someone-else"}, "author/editor not trusted"),
                 "other issue": ({"number": 324}, "not for Issue #323"),
                 "other repo": ({"repo": "someone/else"}, "not for Issue #323"),
                 "updated after fetch": ({"updated_at": time.time() + 3600}, "times inconsistent")}
        for name, (kw, expect) in cases.items():
            with self.subTest(case=name):
                self.env.issue.publish(self.body, **kw)
                self.assert_refused(expect)

    def test_body_whitespace_change_is_not_the_same_body(self):
        self.env.issue.publish(self.body + "\n")  # NORM-1 では同じでも、生の本文が違えば別物
        self.assert_refused("task body differs")

    def test_no_witness_configured(self):
        env = self.env
        control = Control(env.layout, env.control_signer, env.verifier, env.policy, env.notifier)
        env.issue.publish(self.body)
        run_id, reason = control.try_claim(self.body, TRUSTED_ISSUE, time.time())
        self.assertIsNone(run_id)
        self.assertIn("no issue witness", reason)

    def test_witness_must_not_hold_runner_key(self):
        keys = signing.test_keys()
        with self.assertRaises(ValueError):
            issue_mod.IssueWitness(self.env.issue, signing.HmacTestSigner({"runner": keys["runner"],
                                                                          "witness": keys["witness"]}))


class AgentSide(EnvTestCase):
    """実行側: runner 鍵で作り直した要求の証拠を信用しない。"""

    def setUp(self):
        super().setUp()
        self.env.envelope()
        self.env.s2_heartbeat()
        self.body = make_body(self.env.policy)
        self.env.issue.publish(self.body)
        self.run_id, reason = self.env.control.try_claim(self.body, TRUSTED_ISSUE, time.time())
        self.assertIsNotNone(self.run_id, reason)
        self.path = self.env.layout.request_file(self.run_id)

    def assert_rejected(self, expect=None):
        stub, reason = self.env.agent.handle_request_file(self.path)
        if stub is not None:
            stub.kill()
            stub.wait(timeout=10)
        self.assertIsNone(stub, "request was accepted")
        if expect:
            self.assertIn(expect, reason)
        self.assertEqual(self.env.agent.used.read_all(), [])

    def witness_doc(self, body, now=None, **issue_kw):
        src = issue_mod.MockIssueSource()
        src.publish(body, **issue_kw)
        w = issue_mod.IssueWitness(src, self.env.witness_signer, (lambda: now) if now else time.time)
        return w.observe()

    def test_evidence_missing(self):
        resign(self.env, self.path, lambda r: r.pop("issue_evidence"))
        self.assert_rejected("issue_evidence")

    def test_evidence_field_tampered(self):
        def mutate(r):
            r["issue_evidence"]["evidence"]["state"] = "OPEN"
            r["issue_evidence"]["evidence"]["fetched_at"] += 1
        resign(self.env, self.path, mutate)
        self.assert_rejected("issue evidence signature invalid")

    def test_evidence_signed_with_runner_key(self):
        def mutate(r):
            ev = r["issue_evidence"]["evidence"]
            r["issue_evidence"]["sig"] = self.env.control_signer.sign("runner", canonical(ev))
        resign(self.env, self.path, mutate)
        self.assert_rejected("issue evidence signature invalid")

    def test_stale_evidence(self):
        t = time.time() - 1000
        old = self.witness_doc(self.body, now=t, updated_at=t - 10)
        resign(self.env, self.path, lambda r: r.__setitem__("issue_evidence", old))
        self.assert_rejected("stale")

    def test_evidence_for_another_body(self):
        other = make_body(self.env.policy, task_id="g10-phase2-other-20261022")
        doc = self.witness_doc(other)
        resign(self.env, self.path, lambda r: r.__setitem__("issue_evidence", doc))
        self.assert_rejected("task body differs")

    def test_evidence_for_closed_issue(self):
        doc = self.witness_doc(self.body, state="CLOSED")
        resign(self.env, self.path, lambda r: r.__setitem__("issue_evidence", doc))
        self.assert_rejected("issue is not open")

    def test_unpublished_task_with_own_evidence_of_old_issue(self):
        """架空のTASKに差し替え、取得済みの（正規TASKの）証拠を付けたままにしても拒否。"""
        fict = make_body(self.env.policy, task_id="g10-phase2-fict-20261022", approval_id="g10-p2-test-0077")
        resign(self.env, self.path, lambda r: r.update(prompt=fict, task_id="g10-phase2-fict-20261022",
                                                       approval_id="g10-p2-test-0077",
                                                       task_sha256=norm.compute_hash(fict)))
        self.assert_rejected("task body differs")

    def test_task_hash_field_must_match_the_body(self):
        """ENVELOPE では CONFIRM の照合が無いので、要求の task_sha256 と本文の再ハッシュの照合だけが守る。"""
        resign(self.env, self.path, lambda r: r.__setitem__("task_sha256", "e" * 64))
        self.assert_rejected("prompt hash does not match")

    def test_duplicate_request_with_same_evidence(self):
        stub, reason = self.env.agent.handle_request_file(self.path)
        self.assertIsNotNone(stub, reason)
        stub.wait(timeout=30)
        self.wait_terminal(self.run_id)
        dup = dict(json.load(open(self.path)))
        dup["request"] = dict(dup["request"], run_id="run-00000000000000d1", request_id="req-00000000000000d1")
        dup["sig"] = self.env.control_signer.sign("runner", canonical(dup["request"]))
        path2 = self.env.layout.request_file("run-00000000000000d1")
        json.dump(dup, open(path2, "w"))
        stub2, reason2 = self.env.agent.handle_request_file(path2)
        self.assertIsNone(stub2)
        self.assertIn("already used", reason2)

    def test_finalize_detects_evidence_swapped_after_run(self):
        stub, reason = self.env.agent.handle_request_file(self.path)
        stub.wait(timeout=30)
        self.wait_terminal(self.run_id)
        doc = self.witness_doc(self.body)
        resign(self.env, self.path, lambda r: r.__setitem__("issue_evidence", doc))
        status, end = self.env.control.finalize(self.run_id, current_body=self.body)
        self.assertNotEqual(status, "ended_checks_passed")
        self.assertFalse(end["payload"]["checks"]["request_matches_claim"])


class StubFinalCheck(EnvTestCase):
    """臨界区間の最終判定でも証拠の鮮度を確かめる（受理後に古くなった証拠では起動しない）。"""
    policy_overrides = {"timing": dict(FAST_TIMING, issue_evidence_max_age=1.5)}

    def test_evidence_stale_by_final_check_aborts(self):
        self.env.envelope()
        self.env.s2_heartbeat()
        marker = os.path.join(self.env.tmp, "started")
        run_id, stub, body = self.claim_and_run(scenario={"started_marker": marker},
                                                hooks={"before_T6a": {"sleep": 2.0}})
        e = registry.load(self.env.layout, run_id)
        self.assertEqual(e["state"], "aborted_before_spawn")
        self.assertIn("issue binding", e["abort_reason"])
        self.assertFalse(os.path.exists(marker))
