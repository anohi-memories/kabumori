"""TASK 16: H2（TASK 15 の結線の再レビュー）の P2×3 の修正の回帰。修正前HEAD（99a33246）では失敗する。

- R1: 存在する wiring.json の中身が JSON の null 等なら、「設定が無い」（従来の経路）ではなく不正として拒否する。
- R2: 承認済みの設定（人の署名の WIRING_APPROVE）を run に結び付け、起動直前・監督・finalize で消失・無承認の変更・
  承認の乗り換えを拒否する。署名方式の段飛ばし・後退は、保存・承認・ログからの導出のどこでも拒否する。
- R3: 役割の間の同じ公開鍵（同じパス・別のパス）と、秘密鍵と公開鍵の不一致を拒否する。
すべて自分の一時フォルダの中だけ（実鍵・実 token・実 GitHub は使わない）。
"""
import json
import os
import shutil
import time

from g10runner import ecdsa_signing as ec, signing, state, wiring
from g10runner.fsutil import atomic_write_json, read_json
from helpers import TRUSTED_ISSUE, make_body
from test_task15_boundaries import Keys
from test_task15_wired_e2e import WiredBase


class R1MissingVersusNull(Keys):
    def write_raw(self, text):
        path = os.path.join(self.tmp, wiring.WIRING_FILE)
        with open(path, "w") as f:
            f.write(text)
        os.chmod(path, 0o600)

    def test_present_but_invalid_contents_are_refused(self):
        signing.write_test_keys(self.tmp)  # 従来の経路へ戻れる状態でも、戻らないこと
        for text in ("null", "[]", "{}", '""', "0", "", "nul"):
            with self.subTest(contents=text):
                self.write_raw(text)
                with self.assertRaises(wiring.WiringError):
                    wiring.load(self.tmp)
                with self.assertRaises(wiring.WiringError):
                    wiring.agent_side(self.tmp)
                with self.assertRaises(wiring.WiringError):
                    wiring.binding(self.tmp)

    def test_truly_missing_file_keeps_the_legacy_path(self):
        signing.write_test_keys(self.tmp)
        self.assertIsNone(wiring.load(self.tmp))
        self.assertIsNone(wiring.binding(self.tmp))
        _, verifier = wiring.agent_side(self.tmp)
        self.assertIsInstance(verifier, signing.HmacTestVerifier)


class R3KeyIdentity(Keys):
    def test_same_key_for_several_roles_is_refused(self):
        same_path = {role: self.pub["agent"] for role in signing.ROLES}
        copies = dict(self.pub)
        for role in ("runner", "human", "witness"):
            dst = os.path.join(self.tmp, "copy-%s.pub" % role)
            shutil.copyfile(self.pub["agent"], dst)
            copies[role] = dst
        one_copy = dict(self.pub, runner=os.path.join(self.tmp, "copy-runner.pub"))
        for name, pub in (("same path", same_path), ("copied files", copies), ("one role", one_copy)):
            with self.subTest(case=name):
                with self.assertRaises(wiring.WiringError):
                    wiring.write(self.tmp, self.doc(public_keys=pub))
                with self.assertRaises(wiring.WiringError):
                    wiring.key_fingerprints(self.doc(public_keys=pub))
        self.assertIsNone(wiring.load(self.tmp))

    def test_assembly_refuses_duplicates_written_without_the_save_check(self):
        doc = self.doc(public_keys={role: self.pub["agent"] for role in signing.ROLES})
        path = os.path.join(self.tmp, wiring.WIRING_FILE)
        atomic_write_json(path, doc)  # write の検査を通らずに直接書かれた設定でも
        os.chmod(path, 0o600)  # （ecdsa なので HMAC の鍵ファイルは置かない: 別の理由での拒否と区別する）
        with self.assertRaisesRegex(wiring.WiringError, "more than one role"):
            wiring.agent_side(self.tmp)
        with self.assertRaisesRegex(wiring.WiringError, "more than one role"):
            wiring.binding(self.tmp)

    def test_reencoded_copy_of_a_key_is_the_same_identity(self):
        reencoded = os.path.join(self.tmp, "runner-reencoded.pub")
        with open(self.pub["agent"]) as f:
            lines = f.read().strip().splitlines()
        with open(reencoded, "w") as f:  # PEM の改行位置を変えた同じ鍵
            f.write(lines[0] + "\n" + "".join(lines[1:-1]) + "\n" + lines[-1] + "\n")
        self.assertEqual(ec.public_key_fingerprint(reencoded), ec.public_key_fingerprint(self.pub["agent"]))
        with self.assertRaises(wiring.WiringError):
            wiring.write(self.tmp, self.doc(public_keys=dict(self.pub, runner=reencoded)))

    def test_private_key_must_match_its_public_key(self):
        other = os.path.join(self.tmp, "other")
        os.makedirs(other)
        stray_priv, _ = ec.generate_keypair(other, "agent")
        for role, priv in (("agent", stray_priv), ("witness", self.priv["runner"])):
            with self.subTest(role=role):
                keys = {"agent": self.priv["agent"], "witness": self.priv["witness"], role: priv}
                with self.assertRaises(wiring.WiringError):
                    wiring.write(self.tmp, self.doc(private_keys=keys))

    def test_distinct_matching_keys_are_accepted(self):
        wiring.write(self.tmp, self.doc())
        fps = wiring.key_fingerprints(wiring.load(self.tmp))
        self.assertEqual(len(set(fps.values())), 4)
        signer, verifier = wiring.agent_side(self.tmp)
        sig = signer.sign("agent", b"x")
        self.assertEqual([r for r in signing.ROLES if verifier.verify(r, b"x", sig)], ["agent"])


class R2ModeSteps(Keys):
    def approvals(self, *steps):
        """WIRING_APPROVE の列を state.derive に通した結果（ログの検証は済んでいる前提の、導出の規則だけ）。"""
        events = []
        for i, (mode, gen, role) in enumerate(steps, 1):
            events.append({"seq": i, "event_id": "e%d" % i, "type": "WIRING_APPROVE", "role": role,
                           "payload": {"mode": mode, "wiring_sha256": "%064x" % i, "generation": gen}})
        return state.derive(events, [])

    def test_derive_accepts_only_one_step_forward(self):
        ok = self.approvals(("hmac", 1, "human"), ("dual", 2, "human"), ("ecdsa", 3, "human"), ("ecdsa", 4, "human"))
        self.assertIsNone(ok.wiring_problem)
        self.assertEqual((ok.wiring["mode"], ok.wiring["generation"]), ("ecdsa", 4))
        bad = {"downgrade": [("ecdsa", 1, "human"), ("hmac", 2, "human")],
               "dual back": [("dual", 1, "human"), ("hmac", 2, "human")],
               "skip": [("hmac", 1, "human"), ("ecdsa", 2, "human")],
               "generation skip": [("hmac", 1, "human"), ("hmac", 3, "human")],
               "generation reuse": [("hmac", 1, "human"), ("hmac", 1, "human")],
               "runner role": [("hmac", 1, "runner")]}
        for name, steps in bad.items():
            with self.subTest(case=name):
                st = self.approvals(*steps)
                self.assertIsNotNone(st.wiring_problem)

    def test_a_bad_approval_poisons_later_ones(self):
        st = self.approvals(("ecdsa", 1, "human"), ("hmac", 2, "human"), ("ecdsa", 2, "human"))
        self.assertIsNotNone(st.wiring_problem)
        self.assertEqual(st.wiring["generation"], 1)

    def test_write_refuses_skips_and_downgrades(self):
        hmac_doc = self.doc(mode="hmac", public_keys={}, private_keys={})
        wiring.write(self.tmp, hmac_doc)
        with self.assertRaises(wiring.WiringError):
            wiring.write(self.tmp, self.doc(mode="ecdsa"))  # 段飛ばし
        wiring.write(self.tmp, self.doc(mode="dual"))
        with self.assertRaises(wiring.WiringError):
            wiring.write(self.tmp, hmac_doc)  # 後退
        wiring.write(self.tmp, self.doc(mode="ecdsa"))
        for back in ("dual", "hmac"):
            with self.subTest(back=back):
                with self.assertRaises(wiring.WiringError):
                    wiring.write(self.tmp, self.doc(mode=back) if back == "dual" else hmac_doc)
        self.assertEqual(wiring.load(self.tmp)["mode"], "ecdsa")


class R2RunBinding(WiredBase):
    """承認済みの設定と run の結合（ecdsa・GraphQL fixture・共有台帳）。"""

    def change_ledger(self, ledger):
        cfg = wiring.load(self.env.tmp)
        cfg["ledger"] = ledger
        wiring.write(self.env.tmp, cfg)

    def assert_aborted(self, run_id, reason_part):
        stub = self.handle(run_id, {"sleep": 0.3})
        stub.wait(timeout=60)
        e = self.wait_terminal(run_id, 60)
        self.assertNotIn("SPAWNED", self.env.agent.used_state(run_id))
        self.assertEqual(e["state"], "aborted_before_spawn")
        self.assertIn(reason_part, e.get("abort_reason", ""))

    def assert_never_started(self, run_id):
        """受理で拒否されるか、スタブが起動前に中止すること（どちらでも、偽Claude は起動しない）。"""
        stub, reason = self.env.agent.handle_request_file(self.env.layout.request_file(run_id),
                                                          scenario={"sleep": 0.3})
        if stub is not None:
            self.addCleanup(lambda: (stub.poll() is None and stub.kill(), stub.wait(timeout=30)))
            self.assertNotEqual(stub.wait(timeout=60), 0)  # 中止（記録簿を検証できず ABORTED も書けない場合を含む）
        self.assertNotIn("SPAWNED", self.env.agent.used_state(run_id))
        return reason

    def test_request_carries_the_approved_binding(self):
        run_id = self.claim()
        req = read_json(self.env.layout.request_file(run_id))["request"]
        st = self.env.control.read_state()
        self.assertEqual(req["wiring_sha256"], st.wiring["wiring_sha256"])
        self.assertEqual(req["wiring_generation"], st.wiring["generation"])

    def test_unapproved_change_disables_nothing_for_a_pending_run(self):
        run_id = self.claim()
        self.env.fill_ledger()
        self.change_ledger(None)  # 台帳を外す変更（未承認）
        self.assert_aborted(run_id, "wiring")

    def test_approved_change_is_not_adopted_by_a_pending_run(self):
        run_id = self.claim()
        self.change_ledger(None)
        self.env.control.approve_wiring()  # 正規の承認（世代2）。待っているランは乗り換えない
        self.assert_aborted(run_id, "changed since CLAIM")

    def test_new_runs_use_the_new_approval(self):
        run_id = self.claim()
        self.handle(run_id, {"sleep": 0.2}).wait(timeout=60)
        self.wait_terminal(run_id, 60)
        self.assertEqual(self.env.control.finalize(run_id, current_body=self.body)[0], "ended_checks_passed")
        self.change_ledger(dict(read_json_ledger(self.env), limit_per_hour=100))
        body = make_body(self.env.policy, approval_id="g10-p2-test-0002", task_id="g10-phase2-test-20261023")
        self.env.issue.publish(body)
        refused, reason = self.env.control.try_claim(body, TRUSTED_ISSUE, time.time())
        self.assertIsNone(refused)
        self.assertIn("not the approved one", reason)  # 承認前は CLAIM しない
        self.env.control.approve_wiring()
        second = self.claim(body)
        self.assertEqual(read_json(self.env.layout.request_file(second))["request"]["wiring_generation"], 2)

    def test_missing_config_after_approval_is_refused(self):
        run_id = self.claim()
        os.unlink(os.path.join(self.env.tmp, wiring.WIRING_FILE))
        signing.write_test_keys(self.env.tmp)  # 従来の経路へ戻れる状態でも、戻らない
        self.assert_never_started(run_id)
        refused, reason = self.env.control.try_claim(self.body, TRUSTED_ISSUE, time.time())
        self.assertIsNone(refused)

    def test_public_key_contents_replaced_at_the_same_path(self):
        run_id = self.claim()
        before = wiring.binding(self.env.tmp)["sha256"]
        other = os.path.join(self.env.real, "other")
        os.makedirs(other)
        _, stray_pub = ec.generate_keypair(other, "human")
        shutil.copyfile(stray_pub, self.env.pub["human"])  # 設定のパスは同じ・中身だけ別の鍵
        self.assertNotEqual(wiring.binding(self.env.tmp)["sha256"], before)  # 設定のハッシュに鍵の中身が入る
        self.assert_never_started(run_id)

    def test_monitor_stops_a_run_whose_config_changes(self):
        body = make_body(self.env.policy, max_minutes="60")
        self.env.issue.publish(body)
        run_id = self.claim(body)
        self.handle(run_id, {"sleep": 30})
        self.wait_used(run_id, "SPAWNED")
        self.change_ledger(None)
        e = self.wait_terminal(run_id, 30)
        self.assertEqual(e.get("stop_reason"), "issue_changed_while_running")
        lines = [json.loads(x) for x in open(os.path.join(self.env.layout.run_dir(run_id), "issue_monitor.jsonl"))]
        self.assertIn("wiring", lines[-1].get("reason") or "")

    def test_finalize_does_not_pass_after_a_config_change(self):
        run_id = self.claim()
        self.handle(run_id, {"sleep": 0.2}).wait(timeout=60)
        self.wait_terminal(run_id, 60)
        self.change_ledger(None)
        status, end = self.env.control.finalize(run_id, current_body=self.body)
        self.assertNotEqual(status, "ended_checks_passed")
        self.assertFalse(end["payload"]["checks"]["wiring_unchanged"])

    def test_control_refuses_a_downgrade_approval(self):
        cfg = wiring.load(self.env.tmp)
        path = os.path.join(self.env.tmp, wiring.WIRING_FILE)
        downgraded = dict(cfg, mode="dual")
        atomic_write_json(path, downgraded)  # write の歯止めを通らずに直接書き換えても
        os.chmod(path, 0o600)
        with self.assertRaises(wiring.WiringError):
            self.env.control.approve_wiring()
        refused, reason = self.env.control.try_claim(self.body, TRUSTED_ISSUE, time.time())
        self.assertIsNone(refused)


def read_json_ledger(env):
    return wiring.load(env.tmp)["ledger"]


if __name__ == "__main__":
    import unittest
    unittest.main()
