"""TASK 15: 結線の境界の個別試験（オフライン）。

- 項目2: 実行側は検証鍵（公開鍵）と agent の鍵だけ。runner・human の秘密鍵は設定できない。署名の目的・nonce・
  有効時間・使い回し（リプレイ）を ECDSA でも拒否する。HMAC からの切替の各段階の受け付け。
- 項目1: 設定ファイル・台帳の上限（同じ認証の主体の予算）・fixture の opener（ネットワークに触れない）。
- 項目3: 実 CLI の計画と偽Claude の整合・伏せ字・起動直前の再検証（何も実行しない）。
"""
import os
import shutil
import tempfile
import unittest
import urllib.request
from unittest import mock

from g10runner import claude_cli_plan as ccp, ecdsa_signing as ec, github_graphql as gq, github_source as gh
from g10runner import issue as issue_mod, signing, wiring
from helpers import FAST_TIMING, make_body, test_policy
from g10runner import policy as policy_mod

POLICY = policy_mod.with_digest(test_policy(timing=dict(FAST_TIMING, issue_monitor_interval=5.0)))


class Keys(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix="g10w-", dir="/tmp"))
        os.chmod(self.tmp, 0o700)
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.priv, self.pub = {}, {}
        for role in signing.ROLES:
            self.priv[role], self.pub[role] = ec.generate_keypair(self.tmp, role)
        self.fixture = os.path.join(self.tmp, "fixture.json")

    def doc(self, **over):
        d = {"version": wiring.VERSION, "mode": "ecdsa", "public_keys": dict(self.pub),
             "private_keys": {"agent": self.priv["agent"], "witness": self.priv["witness"]},
             "issue_source": {"kind": "graphql_fixture", "fixture": self.fixture},
             "ledger": {"path": os.path.join(self.tmp, "ledger.json"), "limit_per_hour": 100,
                        "reserve_fraction": 0.0, "watchdog_interval": 30.0}}
        d.update(over)
        return d


class VerifyOnlyBoundary(Keys):
    def test_execution_side_holds_only_the_agent_key_and_public_keys(self):
        wiring.write(self.tmp, self.doc())
        signer, verifier = wiring.agent_side(self.tmp)
        self.assertEqual([r for r in signing.ROLES if signer.can_sign(r)], ["agent"])
        self.assertFalse(hasattr(verifier, "sign"))
        for role in ("runner", "human"):
            with self.assertRaises(wiring.WiringError):
                wiring.signer(self.tmp, wiring.load(self.tmp), role)
        runner_sig = ec.EcdsaSigner({"runner": self.priv["runner"]}).sign("runner", b"x")
        self.assertTrue(verifier.verify("runner", b"x", runner_sig))
        self.assertFalse(verifier.verify("agent", b"x", runner_sig))  # 役割の取り違え

    def test_hmac_mode_execution_side_cannot_sign_as_runner(self):
        signing.write_test_keys(self.tmp)  # hmac では鍵ファイルに全役割の鍵がある: 役割の制限が唯一の歯止め
        wiring.write(self.tmp, self.doc(mode="hmac", public_keys={}, private_keys={}))
        cfg = wiring.load(self.tmp)
        self.assertTrue(wiring.signer(self.tmp, cfg, "agent").can_sign("agent"))
        for role in ("runner", "human"):
            with self.assertRaises(wiring.WiringError):
                wiring.signer(self.tmp, cfg, role)

    def test_runner_or_human_private_keys_cannot_be_configured(self):
        for role in ("runner", "human"):
            with self.subTest(role=role):
                bad = self.doc(private_keys={"agent": self.priv["agent"], role: self.priv[role]})
                with self.assertRaises(wiring.WiringError):
                    wiring.validate(bad)

    def test_a_private_key_offered_as_a_public_key_is_refused(self):
        pub = dict(self.pub, runner=self.priv["runner"])
        wiring.write(self.tmp, self.doc(public_keys=pub))
        with self.assertRaises(ValueError):
            wiring.agent_side(self.tmp)

    def test_invalid_wiring_documents(self):
        cases = {"extra key": self.doc(extra=1), "version": self.doc(version="wiring-v0"),
                 "mode": self.doc(mode="none"), "missing public role": self.doc(public_keys={"agent": self.pub["agent"]}),
                 "no agent key": self.doc(private_keys={"witness": self.priv["witness"]}),
                 "relative key": self.doc(private_keys={"agent": "agent.key"}),
                 "same path": self.doc(private_keys={"agent": self.pub["agent"]}),
                 "hmac with keys": self.doc(mode="hmac"),
                 "source kind": self.doc(issue_source={"kind": "github"}),
                 "fixture relative": self.doc(issue_source={"kind": "graphql_fixture", "fixture": "f.json"}),
                 "file with options": self.doc(issue_source={"kind": "file", "fixture": self.fixture}),
                 "ledger keys": self.doc(ledger={"path": "/tmp/x.json"}),
                 "ledger bool": self.doc(ledger={"path": "/a/b.json", "limit_per_hour": True, "reserve_fraction": 0,
                                                 "watchdog_interval": 30}),
                 "ledger fraction": self.doc(ledger={"path": "/a/b.json", "limit_per_hour": 5, "reserve_fraction": 1,
                                                     "watchdog_interval": 30})}
        for name, d in cases.items():
            with self.subTest(case=name):
                with self.assertRaises(wiring.WiringError):
                    wiring.validate(d)

    def test_wiring_file_must_be_owner_only_and_not_a_link(self):
        wiring.write(self.tmp, self.doc())
        path = os.path.join(self.tmp, wiring.WIRING_FILE)
        os.chmod(path, 0o664)
        with self.assertRaises(wiring.WiringError):
            wiring.load(self.tmp)
        os.chmod(path, 0o600)
        os.link(path, path + ".hard")
        with self.assertRaises(wiring.WiringError):
            wiring.load(self.tmp)
        os.unlink(path + ".hard")
        os.rename(path, path + ".real")
        os.symlink(path + ".real", path)
        with self.assertRaises(wiring.WiringError):
            wiring.load(self.tmp)

    def test_missing_wiring_file_keeps_the_legacy_path(self):
        signing.write_test_keys(self.tmp)
        signer, verifier = wiring.agent_side(self.tmp)
        self.assertIsInstance(verifier, signing.HmacTestVerifier)
        self.assertEqual([r for r in signing.ROLES if signer.can_sign(r)], ["agent"])


class MigrationModes(Keys):
    def verifiers(self):
        keys = signing.test_keys()
        return signing.HmacTestVerifier(keys), ec.EcdsaVerifier(self.pub), signing.HmacTestSigner(keys), \
            ec.EcdsaSigner({"runner": self.priv["runner"]})

    def test_each_mode_accepts_only_its_schemes(self):
        hv, ev, hs, es = self.verifiers()
        h, e = hs.sign("runner", b"d"), es.sign("runner", b"d")
        expect = {"hmac": (True, False), "dual": (True, True), "ecdsa": (False, True)}
        for mode, (hmac_ok, ecdsa_ok) in expect.items():
            with self.subTest(mode=mode):
                v = wiring.MigratingVerifier(mode, hv if mode != "ecdsa" else None, ev if mode != "hmac" else None)
                self.assertEqual(v.verify("runner", b"d", h), hmac_ok)
                self.assertEqual(v.verify("runner", b"d", e), ecdsa_ok)
                self.assertFalse(v.verify("runner", b"other", e))
                self.assertFalse(v.verify("runner", b"d", "plain:" + e))
                self.assertFalse(v.verify("runner", b"d", None))

    def test_verifiers_must_match_the_mode(self):
        hv, ev, _, _ = self.verifiers()
        for mode, h, e in (("hmac", None, None), ("hmac", hv, ev), ("dual", hv, None), ("ecdsa", hv, ev),
                           ("ecdsa", None, None), ("x", hv, ev)):
            with self.subTest(mode=mode, h=h is not None, e=e is not None):
                with self.assertRaises(wiring.WiringError):
                    wiring.MigratingVerifier(mode, h, e)

    def test_cached_success_does_not_widen_acceptance(self):
        _, ev, _, es = self.verifiers()
        v = wiring.MigratingVerifier("ecdsa", None, ev)
        sig = es.sign("runner", b"d")
        self.assertTrue(v.verify("runner", b"d", sig))
        self.assertTrue(v.verify("runner", b"d", sig))
        self.assertFalse(v.verify("agent", b"d", sig))
        self.assertFalse(v.verify("runner", b"e", sig))


class EvidenceWithEcdsa(Keys):
    """項目2: 証拠の目的・nonce・有効時間・使い回しの拒否は、ECDSA の署名でも同じに効く。"""

    def setUp(self):
        super().setUp()
        self.body = make_body(POLICY)
        self.source = issue_mod.MockIssueSource()
        self.source.publish(self.body, updated_at=1792800000.0)
        self.clock = {"t": 1792800010.0}
        self.witness = issue_mod.IssueWitness(self.source, ec.EcdsaSigner({"witness": self.priv["witness"]}),
                                              lambda: self.clock["t"])
        self.verifier = wiring.MigratingVerifier("ecdsa", None, ec.EcdsaVerifier(self.pub))

    def test_purpose_nonce_expiry_and_replay(self):
        now = self.clock["t"]
        claim = self.witness.observe("claim")
        self.assertIsNone(issue_mod.check_evidence(claim, self.verifier, self.body, now, 120))
        spawn_a = self.witness.observe("spawn", "spawn:A:req:evt")
        cases = {
            "claim used as spawn": issue_mod.check_evidence(claim, self.verifier, self.body, now, 10, "spawn",
                                                            "spawn:A:req:evt"),
            "spawn of run A replayed for run B": issue_mod.check_evidence(spawn_a, self.verifier, self.body, now, 10,
                                                                          "spawn", "spawn:B:req:evt"),
            "expired": issue_mod.check_evidence(spawn_a, self.verifier, self.body, now + 11, 10, "spawn",
                                                "spawn:A:req:evt"),
            "other body": issue_mod.check_evidence(claim, self.verifier, self.body + "x", now, 120),
        }
        for name, reason in cases.items():
            with self.subTest(case=name):
                self.assertIsNotNone(reason)
        self.assertIsNone(issue_mod.check_evidence(spawn_a, self.verifier, self.body, now, 10, "spawn",
                                                   "spawn:A:req:evt"))

    def test_tampered_or_wrong_role_evidence_is_refused(self):
        doc = self.witness.observe("claim")
        tampered = {"evidence": dict(doc["evidence"], editor="anohi-memories"), "sig": doc["sig"]}
        self.assertIn("signature", issue_mod.check_evidence(tampered, self.verifier, self.body, self.clock["t"], 120))
        agent_signed = issue_mod.IssueWitness(self.source, ec.EcdsaSigner({"agent": self.priv["agent"]}),
                                              lambda: self.clock["t"])
        with self.assertRaises(signing.SignatureError):  # agent の鍵では witness として署名できない
            agent_signed.observe("claim")
        forged = {"evidence": doc["evidence"],
                  "sig": ec.EcdsaSigner({"agent": self.priv["agent"]}).sign("agent", issue_mod.canonical(doc["evidence"]))}
        self.assertIn("signature", issue_mod.check_evidence(forged, self.verifier, self.body, self.clock["t"], 120))

    def test_witness_cannot_hold_the_runner_key(self):
        with self.assertRaises(ValueError):
            issue_mod.IssueWitness(self.source, ec.EcdsaSigner({"witness": self.priv["witness"],
                                                                "runner": self.priv["runner"]}))


class LedgerAllowance(Keys):
    def test_allowance_respects_the_shared_principal(self):
        allowance = wiring.ledger_allowance(POLICY, 30.0)
        self.assertEqual(allowance, int((5000 * 0.5 - 30) // 2))
        self.assertLess(wiring.ledger_allowance(POLICY, 30.0, phase1_per_hour=300), allowance)
        with self.assertRaises(wiring.WiringError):  # Phase 1 側が増えて合計が収まらなければ組み立てない
            wiring.ledger_allowance(POLICY, 30.0, phase1_per_hour=500)

    def test_infeasible_policy_is_refused(self):
        fast = policy_mod.with_digest(test_policy(timing=dict(FAST_TIMING, issue_monitor_interval=0.5)))
        with self.assertRaises(wiring.WiringError):
            wiring.ledger_allowance(fast, 30.0)

    def test_limit_above_the_allowance_is_refused(self):
        d = self.doc()
        d["ledger"]["limit_per_hour"] = wiring.ledger_allowance(POLICY, 30.0) + 1
        with self.assertRaises(wiring.WiringError):
            wiring.ledger(wiring.validate(d), POLICY)
        d["ledger"]["limit_per_hour"] -= 1
        self.assertIsNotNone(wiring.ledger(wiring.validate(d), POLICY))


class Fixture(Keys):
    def opener(self):
        f = wiring.GraphQLFixtureFile(self.fixture)
        f.publish(make_body(POLICY))
        return f, wiring.FixtureOpener(self.fixture)

    def request(self, token=wiring.FIXTURE_TOKEN, url=gq.GRAPHQL_URL, data=gq.FIXED_PAYLOAD, method="POST"):
        headers = gh._headers(token)
        return urllib.request.Request(url, data=data, headers=headers, method=method)

    def test_never_touches_the_network(self):
        f, op = self.opener()
        with mock.patch("urllib.request.urlopen", side_effect=AssertionError("network")), \
                mock.patch("urllib.request.OpenerDirector.open", side_effect=AssertionError("network")):
            src = gq.GitHubGraphQLIssueSource(wiring.FIXTURE_TOKEN, enabled=True, opener=op)
            src.verify_token(timeout=5)
            snap = src.fetch(timeout=5)
        self.assertEqual(snap["number"], 323)
        self.assertIsNone(snap["editor"])

    def test_only_the_fixture_token_and_fixed_requests(self):
        _, op = self.opener()
        cases = {"other token": self.request(token="ghp_" + "A" * 36),
                 "other url": self.request(url="https://api.github.com/repos/anohi-memories/kabumori/issues/323",
                                           data=None, method="GET"),
                 "other query": self.request(data=b'{"query":"mutation{}"}')}
        for name, req in cases.items():
            with self.subTest(case=name):
                with self.assertRaises(issue_mod.IssueSourceError):
                    op(req, 5)

    def test_edited_by_trusted_account_establishes_the_editor(self):
        f, op = self.opener()
        f.publish(make_body(POLICY), editor="anohi-memories")
        src = gq.GitHubGraphQLIssueSource(wiring.FIXTURE_TOKEN, enabled=True, opener=op)
        src.verify_token(timeout=5)
        self.assertEqual(src.fetch(timeout=5)["editor"], "anohi-memories")


class CliPlan(unittest.TestCase):
    REQ = {"model_id": "claude-sonnet-5-5", "session_id": "s-1", "run_id": "r-1", "effort": "medium",
           "max_budget_usd": "0.50"}
    BIN = "/opt/claude-cli/2.1.305"
    PINNED = {"realpath": BIN, "version": "2.1.305"}

    def plan(self):
        return ccp.build_plan(self.BIN, self.REQ, "/r/prompt.md", "/r/settings.json", "/Users/_g10runner")

    def probe(self, **over):
        p = {"found": True, "realpath": self.BIN, "executable": True, "version_from_path": "2.1.305"}
        p.update(over)
        return lambda: p

    def check(self, plan=None, states=("ACCEPTED", "SPAWNING"), probe=None, req=None):
        return ccp.prelaunch_check(plan or self.plan(), req or self.REQ, "/r/prompt.md", "/r/settings.json",
                                   "/Users/_g10runner", self.PINNED, list(states), probe or self.probe())

    def test_consistent_with_the_fake_adapter(self):
        from g10runner import adapter
        fake = adapter.FakeClaudeAdapter().command(self.REQ, "/r/prompt.md", "/r/settings.json")
        self.assertEqual(ccp.consistent_with_fake(self.plan(), fake), [])
        other = adapter.FakeClaudeAdapter().command(dict(self.REQ, model_id="claude-opus-5-5"), "/r/prompt.md",
                                                    "/r/settings.json")
        self.assertIn("--model differs", ccp.consistent_with_fake(self.plan(), other))
        bad = self.plan()
        bad["argv"] = bad["argv"] + ["--prompt-file", "/r/prompt.md"]
        self.assertTrue(ccp.consistent_with_fake(bad, fake))
        twice = self.plan()
        twice["argv"] = twice["argv"] + ["--model", "claude-opus-5-5"]
        self.assertTrue(ccp.consistent_with_fake(twice, fake))

    def test_describe_redacts_home_and_refuses_secrets(self):
        d = ccp.describe(self.plan())
        self.assertNotIn("/Users/_g10runner", repr(d))
        self.assertIn("<HOME>", d["env"]["HOME"])
        leaky = self.plan()
        leaky["argv"] = leaky["argv"] + ["sk-ant-" + "a" * 20]
        with self.assertRaises(ValueError):
            ccp.describe(leaky)

    def test_prelaunch_check(self):
        self.assertIsNone(self.check())
        tampered = self.plan()
        tampered["argv"][tampered["argv"].index("--max-turns") + 1] = "200"
        extra_env = self.plan()
        extra_env["env"]["ANTHROPIC_API_KEY"] = "x"
        symlink_bin = ccp.build_plan("/opt/claude", self.REQ, "/r/prompt.md", "/r/settings.json", "/Users/_g10runner")
        cases = {"second launch": self.check(states=("ACCEPTED", "SPAWNING", "SPAWNED")),
                 "not yet spawning": self.check(states=("ACCEPTED",)),
                 "aborted": self.check(states=("ACCEPTED", "ABORTED")),
                 "cli missing": self.check(probe=self.probe(found=False)),
                 "not executable": self.check(probe=self.probe(executable=False)),
                 "cli replaced": self.check(probe=self.probe(realpath="/opt/claude-cli/2.1.306")),
                 "version changed": self.check(probe=self.probe(version_from_path="2.1.306")),
                 "via symlink": self.check(plan=symlink_bin),
                 "argv tampered": self.check(plan=tampered),
                 "env added": self.check(plan=extra_env),
                 "other request": self.check(req=dict(self.REQ, session_id="s-2"))}
        for name, reason in cases.items():
            with self.subTest(case=name):
                self.assertIsNotNone(reason)

    def test_nothing_is_executed(self):
        with mock.patch("subprocess.run", side_effect=AssertionError("executed")), \
                mock.patch("subprocess.Popen", side_effect=AssertionError("executed")), \
                mock.patch("os.execv", side_effect=AssertionError("executed")):
            self.assertIsNone(self.check())
            ccp.describe(self.plan())


if __name__ == "__main__":
    unittest.main()
