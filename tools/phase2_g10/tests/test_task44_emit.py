"""B0-4 producer（署名ジョブ発行）の結線: emit.build_go / emit.emit_job が、現役 TASK から human 署名の
ジョブを handoff/in に正しく置き、それが実行プレーン（ResidentLoop → Dispatcher → Agent → スタブ → 代役CLI）を
bundle だけで完走して yuya 側 finalize が緑になる、までを1本で確かめる。実 Claude は使わない。

test_task38（dispatch）との違い: あちらは handoff の human 署名に試験専用の別 HMAC 鍵を使うが、ここは **本番と同じく
emit_job が control の human 鍵で署名**し、HandoffInbox は **wiring の4役割 verifier（env.verifier）** で検証する。
"""
import json
import os
import time

from g10runner import emit, handoff, meta, resident, source_bundle
from helpers import TRUSTED_ISSUE
from test_task38_dispatch import DispatchBase


class EmitBase(DispatchBase):
    def fields(self):
        r = meta.validate_task(self.body, self.env.policy)
        self.assertTrue(r.ok, r.problems[:3])
        return r.fields

    def build_go(self, bundle, **over):
        f = self.fields()
        go = emit.build_go(f, self.body, self.cli, self.home, self.repo, bundle,
                           time.time() + 600, over.pop("max_turns", 10))
        go.update(over)
        return go

    def loop(self):
        # 本番と同じく wiring の4役割 verifier で handoff の human 署名を検証する
        inbox = handoff.HandoffInbox(self.hin, self.claims, self.env.verifier)
        dispatcher = resident.Dispatcher(self.env.agent, self.env.layout, wait_seconds=60)
        return resident.ResidentLoop(inbox, self.flags, self.hout, self.cli, self.home, dispatcher,
                                     log_path=os.path.join(self.env.real, "resident.log"))


class EmitE2E(EmitBase):
    def test_emit_job_runs_through_the_execution_plane_from_bundle(self):
        bundle = self.make_bundle()                       # 元 repo は消える: bundle だけで完走する
        go = self.build_go(bundle)
        out = emit.emit_job(self.env.control, self.body, TRUSTED_ISSUE, time.time(), go, self.hin)

        # 置かれたジョブ: ファイル名は run_id、隠しの一時ファイルは残っていない
        self.assertEqual(out["job_id"], out["run_id"])
        self.assertEqual(os.path.basename(out["job_path"]), out["run_id"] + ".json")
        self.assertEqual(sorted(os.listdir(self.hin)), [out["run_id"] + ".json"])

        rec = self.loop().step()
        self.assertEqual(rec["decision"], "ran", rec)
        self.assertEqual(rec["run_id"], out["run_id"])

        entry = self.wait_terminal(out["run_id"], 60)
        status, _end = self.env.control.finalize(out["run_id"], current_body=self.body)
        self.assertEqual(status, "ended_checks_passed",
                         (status, {k: entry.get(k) for k in ("state", "stop_reason", "abort_reason")}))
        calls = self.calls()
        self.assertEqual(len(calls), 1)                   # 実起動はちょうど1回
        self.assertTrue(calls[0]["cwd_has_marker"])       # 作業フォルダは bundle から checkout
        disp = json.load(open(os.path.join(self.hout, out["run_id"] + ".json")))
        self.assertEqual(disp["run_id"], out["run_id"])


class BuildGoValidation(EmitBase):
    def test_missing_source_bundle_is_refused(self):
        with self.assertRaises(emit.EmitError):
            self.build_go(os.path.join(self.env.real, "no-such.bundle"))

    def test_relative_source_bundle_is_refused(self):
        bundle = self.make_bundle()
        rel = os.path.relpath(bundle, os.getcwd())
        with self.assertRaises(emit.EmitError):
            self.build_go(rel)

    def test_max_turns_out_of_range_is_refused(self):
        bundle = self.make_bundle()
        with self.assertRaises(emit.EmitError):
            self.build_go(bundle, max_turns=0)


class EmitRefusesWithoutWritingAJob(EmitBase):
    def test_try_claim_refusal_raises_and_writes_no_job(self):
        bundle = self.make_bundle()
        go = self.build_go(bundle)
        # 先に同じ承認で CLAIM を消費しておく（approve_and_claim は env.control を使う）
        self.approve_and_claim(go)
        before = set(os.listdir(self.hin))
        with self.assertRaises(emit.EmitError):
            emit.emit_job(self.env.control, self.body, TRUSTED_ISSUE, time.time(), go, self.hin, approve=False)
        self.assertEqual(set(os.listdir(self.hin)), before)   # ジョブは書かれていない（部分ファイルも無い）

    def test_second_emit_for_same_claimed_approval_is_refused(self):
        bundle = self.make_bundle()
        go1 = self.build_go(bundle)
        emit.emit_job(self.env.control, self.body, TRUSTED_ISSUE, time.time(), go1, self.hin)
        before = set(os.listdir(self.hin))
        go2 = self.build_go(bundle, go_id="go-second-1")       # 同じ approval（GOは再利用される）
        with self.assertRaises(emit.EmitError):                # try_claim: approval_id already used（at-most-once）
            emit.emit_job(self.env.control, self.body, TRUSTED_ISSUE, time.time(), go2, self.hin)
        self.assertEqual(set(os.listdir(self.hin)), before)    # 2本目のジョブは書かれない


class EmitAuthorization(EmitBase):
    def test_establishes_confirm_when_no_envelope_or_confirm(self):
        # env の ENVELOPE を取り消し、CONFIRM/ENVELOPE 無しの本番相当にする
        env_id = self.env.control.read_state().envelope["envelope_id"]
        self.env.control.revoke_envelope(env_id)
        self.assertIsNone(self.env.control.read_state().envelope)
        bundle = self.make_bundle()
        go = self.build_go(bundle)
        out = emit.emit_job(self.env.control, self.body, TRUSTED_ISSUE, time.time(), go, self.hin)
        c = self.env.control.read_state().confirms.get(go["approval_id"]) or {}
        self.assertEqual(c.get("task_sha256"), go["task_sha256"])   # per-run CONFIRM が張られた
        self.assertEqual(self.loop().step()["decision"], "ran")     # CLAIM→実行まで通る
        self.assertEqual(out["job_id"], out["run_id"])

    def test_reuses_existing_go_instead_of_reapproving(self):
        bundle = self.make_bundle()
        go = self.build_go(bundle)
        self.env.control.approve_real_claude_go(go)            # 先に GO だけ承認（孤立GO相当）
        # approve=True でも再承認せず（GoReuseError を出さず）CLAIM まで通る
        out = emit.emit_job(self.env.control, self.body, TRUSTED_ISSUE, time.time(), go, self.hin)
        self.assertEqual(out["job_id"], out["run_id"])
        self.assertEqual(self.loop().step()["decision"], "ran")


class SourceBundleBuild(EmitBase):
    def _base_sha(self):
        return source_bundle._git(["rev-parse", "HEAD"], self.repo).stdout.strip()

    def test_bundle_verifies_and_contains_base_sha(self):
        base_sha = self._base_sha()
        bundles = os.path.join(self.env.real, "bundles")
        out = source_bundle.make_source_bundle(self.repo, base_sha, bundles, "g10-p2-test-0001")
        self.assertTrue(os.path.isabs(out) and os.path.isfile(out))
        self.assertEqual(source_bundle._git(["bundle", "verify", out], self.repo).returncode, 0)
        # bundle から base_sha を実際に取り出せる（ref から辿れなくても checkout 可能）
        clone = os.path.join(self.env.real, "verify-clone")
        self.assertEqual(source_bundle._git(["clone", "--bare", out, clone], self.env.real).returncode, 0)
        self.assertEqual(source_bundle._git(["cat-file", "-e", base_sha + "^{commit}"], clone).returncode, 0)

    def test_missing_base_sha_is_refused_without_writing_a_bundle(self):
        bundles = os.path.join(self.env.real, "bundles2")
        with self.assertRaises(source_bundle.SourceBundleError):
            source_bundle.make_source_bundle(self.repo, "0" * 40, bundles, "g10-p2-test-0001")
        self.assertFalse(os.path.isdir(bundles) and os.listdir(bundles))  # bundle は書かれない


if __name__ == "__main__":
    import unittest
    unittest.main()
