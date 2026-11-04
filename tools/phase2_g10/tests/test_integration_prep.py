"""監督付き自動起動の準備（TASK 13）の試験: 別プロセスの共有台帳・主体ごとの予算・非対称署名・launchd の計画・
Claude CLI の起動計画（いずれも dry-run／オフライン。実 Claude・OS の変更・ネットワークは使わない）。"""
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

from g10runner import adapter as adapter_mod, claude_cli_plan as ccp, ecdsa_signing as ec, issue as issue_mod
from g10runner import launchd_plan as lp, rate_budget as rb, shared_ledger as sl, signing
from g10runner.fsutil import FileLock
from helpers import make_body, test_policy
from g10runner import policy as policy_mod

PKG = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NOW = 1792800000.0


class TmpDir(unittest.TestCase):
    def setUp(self):
        # 正規のパス（/tmp は /private/tmp へのシンボリックリンクなので realpath にする）・所有者だけが書けるフォルダ
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix="g10prep-", dir="/tmp"))
        os.chmod(self.tmp, 0o700)
        self.addCleanup(shutil.rmtree, self.tmp, True)


class SharedLedger(TmpDir):
    def ledger(self, limit=10, **kw):
        return sl.SharedRateLedger(os.path.join(self.tmp, "ledger.json"), limit, reserve_fraction=0, **kw)

    def test_limit_and_persistence_across_instances(self):
        a, b = self.ledger(), self.ledger()  # 予備は最小1 → 許容9
        for i in range(5):
            a.before_request(NOW + i)
        for i in range(4):
            b.before_request(NOW + 10 + i)
        with self.assertRaisesRegex(sl.RateLimited, "hourly budget"):
            a.before_request(NOW + 20)
        b.before_request(NOW + 3600.5)  # 1時間前の送信が窓から外れる

    def test_cross_process_reservations_never_exceed_the_limit(self):
        path = os.path.join(self.tmp, "ledger.json")
        code = ("import sys; sys.path.insert(0, %r)\n"
                "from g10runner import shared_ledger as sl\n"
                "led = sl.SharedRateLedger(%r, 10, reserve_fraction=0)\n"
                "ok = 0\n"
                "for i in range(5):\n"
                "    try:\n"
                "        led.before_request(%r); ok += 1\n"
                "    except sl.RateLimited:\n"
                "        pass\n"
                "print(ok)\n") % (PKG, path, NOW)
        procs = [subprocess.Popen([sys.executable, "-I", "-c", code], stdout=subprocess.PIPE, text=True)
                 for _ in range(6)]
        total = sum(int(p.communicate(timeout=60)[0].strip()) for p in procs)
        self.assertEqual(total, 9)
        self.assertEqual(len(json.load(open(path))["sent"]), 9)

    def test_check_and_write_are_one_critical_section(self):
        """判定の後・書き込みの前で2つの呼び出しを待ち合わせても、残り1枠を2つが取らない。"""
        a, b = self.ledger(limit=3), self.ledger(limit=3)  # 許容2
        a.before_request(NOW)  # 残り1枠
        barrier = threading.Barrier(2, timeout=1.0)
        for led in (a, b):
            real = led._save

            def waiting_save(*args, real=real):
                try:
                    barrier.wait()
                except threading.BrokenBarrierError:
                    pass
                real(*args)
            led._save = waiting_save
        results = []

        def call(led):
            try:
                led.before_request(NOW + 1)
                results.append("accepted")
            except sl.RateLimited:
                results.append("rejected")
        threads = [threading.Thread(target=call, args=(led,)) for led in (a, b)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(15)
        self.assertEqual(sorted(results), ["accepted", "rejected"])

    def test_corrupt_ledger_fails_closed(self):
        path = os.path.join(self.tmp, "ledger.json")
        for content in ("{bad", '{"sent": [NaN], "blocked_until": null, "server_remaining": null, "server_reset": null}',
                        '{"sent": []}', '{"sent": [], "blocked_until": null, "server_remaining": -1, "server_reset": null}',
                        '{"sent": ["x"], "blocked_until": null, "server_remaining": null, "server_reset": null}', "[]"):
            with self.subTest(content=content[:30]):
                open(path, "w").write(content)
                with self.assertRaisesRegex(sl.RateLimited, "corrupt"):
                    self.ledger().before_request(NOW)

    def test_lock_not_acquired_fails_closed(self):
        led = self.ledger(lock_timeout=0.2)
        with FileLock(led.lock_path, "ex", timeout=1) as held:
            self.assertTrue(held.acquired)
            with self.assertRaisesRegex(sl.RateLimited, "locked"):
                led.before_request(NOW)

    def test_retry_after_and_server_remaining(self):
        led = self.ledger(limit=5000)
        led.observe({"Retry-After": "30"}, NOW)
        with self.assertRaisesRegex(sl.RateLimited, "backing off"):
            self.ledger(limit=5000).before_request(NOW + 10)
        led.observe({"X-RateLimit-Remaining": "1", "X-RateLimit-Reset": str(int(NOW + 600))}, NOW + 31)
        with self.assertRaisesRegex(sl.RateLimited, "server remaining"):
            led.before_request(NOW + 40)
        led.before_request(NOW + 601)


class PrincipalBudget(unittest.TestCase):
    def test_phase1_and_witness_share_the_user_budget(self):
        p1 = rb.phase1_watch_per_hour()  # 30/h
        self.assertEqual(p1, 30.0)
        self.assertIsNone(rb.principal_check([("phase1", p1), ("g10 witness", 840)], "token"))
        self.assertIsNotNone(rb.principal_check([("phase1", p1), ("g10 witness", 2490)], "token"))
        self.assertIsNone(rb.principal_check([("phase1", p1)], "anonymous"))  # 認証なしの枠（60/h×0.5＝30）ちょうど
        self.assertIsNotNone(rb.principal_check([("phase1", p1), ("one more", 1)], "anonymous"))

    def test_invalid_inputs(self):
        with self.assertRaises(ValueError):
            rb.principal_check([("x", -1)], "token")
        with self.assertRaises(ValueError):
            rb.principal_check([("x", 1)], "nope")


class Ecdsa(TmpDir):
    def setUp(self):
        super().setUp()
        self.keys = {r: ec.generate_keypair(self.tmp, r) for r in ("runner", "witness")}
        self.verifier = ec.EcdsaVerifier({r: pub for r, (_, pub) in self.keys.items()})

    def test_sign_and_verify(self):
        signer = ec.EcdsaSigner({"runner": self.keys["runner"][0]})
        sig = signer.sign("runner", b"data")
        self.assertTrue(sig.startswith(ec.PREFIX))
        self.assertTrue(self.verifier.verify("runner", b"data", sig))
        self.assertFalse(self.verifier.verify("runner", b"datA", sig))      # 改ざん
        self.assertFalse(self.verifier.verify("witness", b"data", sig))     # 役割の取り違え

    def test_signer_only_has_its_own_roles(self):
        signer = ec.EcdsaSigner({"runner": self.keys["runner"][0]})
        self.assertFalse(signer.can_sign("witness"))
        with self.assertRaises(signing.SignatureError):
            signer.sign("witness", b"data")

    def test_key_file_rules(self):
        priv, pub = self.keys["runner"]
        os.chmod(priv, 0o644)
        with self.assertRaisesRegex(ValueError, "0600"):
            ec.EcdsaSigner({"runner": priv})
        os.chmod(priv, 0o600)
        with self.assertRaisesRegex(ValueError, "public keys only"):
            ec.EcdsaVerifier({"runner": priv})
        os.chmod(pub, 0o600)
        with self.assertRaisesRegex(ValueError, "not a private key"):
            ec.EcdsaSigner({"runner": pub})

    def test_malformed_signatures(self):
        for bad in ("", "hmac-sha256:00", ec.PREFIX, ec.PREFIX + "zz", ec.PREFIX + "abc", ec.PREFIX + "00" * 300, None):
            with self.subTest(sig=str(bad)[:24]):
                self.assertFalse(self.verifier.verify("runner", b"data", bad))

    def test_witness_evidence_with_ecdsa(self):
        body = make_body(policy_mod.with_digest(test_policy()))
        src = issue_mod.MockIssueSource()
        src.publish(body, updated_at=NOW - 10)
        w = issue_mod.IssueWitness(src, ec.EcdsaSigner({"witness": self.keys["witness"][0]}), lambda: NOW)
        doc = w.observe("claim")
        self.assertIsNone(issue_mod.check_evidence(doc, self.verifier, body, NOW, 120))
        hmac_doc = issue_mod.IssueWitness(src, signing.HmacTestSigner({"witness": signing.test_keys()["witness"]}),
                                          lambda: NOW).observe("claim")
        self.assertEqual(issue_mod.check_evidence(hmac_doc, self.verifier, body, NOW, 120),
                         "issue evidence signature invalid")

    def test_witness_must_not_hold_the_runner_key(self):
        with self.assertRaises(ValueError):
            issue_mod.IssueWitness(issue_mod.MockIssueSource(),
                                   ec.EcdsaSigner({"runner": self.keys["runner"][0],
                                                   "witness": self.keys["witness"][0]}))


class LaunchdPlan(TmpDir):
    def plan(self, **over):
        p = lp.watchdog_daemon_plan("/usr/bin/python3", "/Users/Shared/g10root", "_g10runner")
        p.update(over)
        return p

    def test_valid_plan_renders_and_lints(self):
        p = self.plan()
        self.assertTrue(lp.validate_plan(p, current_user="yuya"))
        path = os.path.join(self.tmp, "watchdog.plist")
        open(path, "wb").write(lp.render(p))
        self.assertTrue(lp.lint(path))
        self.assertIn("bootout system/" + p["Label"], lp.stop_commands(p["Label"])[0])

    def test_invalid_plans(self):
        cases = {"main user": self.plan(UserName="yuya"), "root": self.plan(UserName="root"),
                 "not dedicated": self.plan(UserName="g10runner"),
                 "secret env": self.plan(EnvironmentVariables={"PATH": "/usr/bin", "GH_TOKEN": "x"}),
                 "extra env": self.plan(EnvironmentVariables={"PATH": "/usr/bin", "HOME": "/x"}),
                 "other script": self.plan(ProgramArguments=["/usr/bin/python3", "-I", "/tmp/evil.py", "--root", "/r",
                                                             "--interval", "30.0"]),
                 "relative python": self.plan(ProgramArguments=["python3", "-I", lp.WATCHDOG, "--root", "/r"]),
                 "no -I": self.plan(ProgramArguments=["/usr/bin/python3", lp.WATCHDOG, "--root", "/r", "-I"]),
                 "umask": self.plan(Umask=0o022), "keepalive": self.plan(KeepAlive=False),
                 "label": self.plan(Label="com.example.other"),
                 "relative log": self.plan(StandardOutPath="logs/out")}
        for name, p in cases.items():
            with self.subTest(case=name):
                with self.assertRaises(lp.PlanError):
                    lp.validate_plan(p, current_user="yuya")

    def test_nothing_but_plutil_is_executed(self):
        calls = []
        real = subprocess.run

        def spy(args, *a, **kw):
            calls.append(args[0])
            return real(args, *a, **kw)
        path = os.path.join(self.tmp, "w.plist")
        open(path, "wb").write(lp.render(self.plan()))
        with mock.patch.object(lp.subprocess, "run", side_effect=spy):
            lp.validate_plan(self.plan(), current_user="yuya")
            lp.stop_commands()
            lp.lint(path)
        self.assertEqual(calls, ["/usr/bin/plutil"])


class ClaudeCliPlan(TmpDir):
    def test_probe_does_not_execute_the_cli(self):
        versions = os.path.join(self.tmp, "versions")
        os.makedirs(versions)
        target = os.path.join(versions, "9.9.9")
        open(target, "w").write("#!/bin/sh\nexit 1\n")
        os.chmod(target, 0o755)
        bindir = os.path.join(self.tmp, "bin")
        os.makedirs(bindir)
        os.symlink(target, os.path.join(bindir, "claude"))
        with mock.patch.object(subprocess, "run", side_effect=AssertionError("executed")), \
                mock.patch.object(subprocess, "Popen", side_effect=AssertionError("executed")):
            info = ccp.probe(path_env=bindir)
        self.assertEqual((info["found"], info["version_from_path"], info["executed"]), (True, "9.9.9", False))
        self.assertEqual(ccp.probe(path_env=self.tmp + "/none")["found"], False)

    def test_module_has_no_way_to_execute(self):
        src = open(ccp.__file__, encoding="utf-8").read()
        for word in ("import subprocess", "os.system", "os.exec", "Popen", "spawn"):
            self.assertNotIn(word, src)

    def test_plan_argv_env_and_prompt(self):
        req = {"model_id": "claude-sonnet-5-5", "session_id": "11111111-2222-3333-4444-555555555555",
               "run_id": "run-0123456789abcdef", "prompt": "SECRET TASK BODY", "max_budget_usd": "0.50"}
        plan = ccp.build_plan("/opt/claude", req, "/r/prompt.md", "/r/settings.json", "/Users/_g10runner")
        self.assertEqual(plan["argv"][:4], ["/opt/claude", "-p", "--output-format", "json"])
        self.assertIn("claude-sonnet-5-5", plan["argv"])
        self.assertIn(req["session_id"], plan["argv"])
        self.assertNotIn("SECRET TASK BODY", " ".join(plan["argv"]))  # 本文は argv に入れない
        self.assertEqual(plan["stdin_path"], "/r/prompt.md")
        self.assertTrue(ccp.check_env(plan["env"]))
        self.assertTrue(plan["dry_run"])

    def test_env_allowlist_and_input_checks(self):
        for bad in ({"PATH": "/usr/bin", "ANTHROPIC_API_KEY": "x"}, {"PATH": "/usr/bin", "AWS_PROFILE": "x"},
                    {"PATH": "/usr/bin", "CLAUDE_CODE_USE_BEDROCK": "1"}, {"PATH": "/usr/bin", "EXTRA": "1"}):
            with self.subTest(env=sorted(bad)):
                with self.assertRaises(ValueError):
                    ccp.check_env(bad)
        req = {"model_id": "m", "session_id": "s", "run_id": "r", "max_budget_usd": "0.10"}
        for args in (("claude", req, "/p", "/s", "/h"), ("/c", dict(req, model_id=""), "/p", "/s", "/h"),
                     ("/c", req, "p", "/s", "/h")):
            with self.subTest(args=args[0]):
                with self.assertRaises(ValueError):
                    ccp.build_plan(*args)
        with self.assertRaises(ValueError):
            ccp.build_plan("/c", req, "/p", "/s", "/h", max_turns=0)

    def test_real_adapter_is_still_refused(self):
        for name in ("claude", "real", "cli"):
            with self.subTest(adapter=name):
                with self.assertRaises(adapter_mod.AdapterError):
                    adapter_mod.get_adapter(dict(test_policy(), adapter=name))
