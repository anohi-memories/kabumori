"""設計 §14.2-14.3: 専用ユーザー方式のジョブ受け口 handoff.HandoffInbox。
署名（human）・GO と要求の一致・期限・CLAIM（at-most-once）を fail-closed で確かめる。
実 Claude・ネットワーク・本物の HOME は使わない（検証と CLAIM のみ。起動はしない）。
"""
import json
import os
import shutil
import tempfile
import time
import unittest

from g10runner import handoff, signing
from g10runner.fsutil import canonical, sha256_hex

KEYS = {"human": b"human-key", "runner": b"runner-key"}


def make_go(prompt, **over):
    go = {"go_id": "go-1", "approval_id": "appr-1", "task_sha256": "a" * 64,
          "body_sha256": sha256_hex(prompt.encode("utf-8")), "cli_realpath": "/opt/claude/2.1.305",
          "cli_version": "2.1.305", "home": "/Users/_kaburun", "max_turns": 10,
          "source_repo": "/Users/_kaburun/src", "expires_at": time.time() + 600, "max_runs": 1}
    go.update(over)
    return go


def make_request(prompt, **over):
    req = {"approval_id": "appr-1", "task_sha256": "a" * 64, "prompt": prompt,
           "base_ref": "refs/heads/main", "base_sha": "b" * 40}
    req.update(over)
    return req


class HandoffBase(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.in_dir = os.path.join(self.tmp, "in")
        self.claims = os.path.join(self.tmp, "claims")
        os.makedirs(self.in_dir, 0o755)
        os.makedirs(self.claims, 0o700)
        self.signer = signing.HmacTestSigner(KEYS)
        self.verifier = signing.HmacTestVerifier(KEYS)
        self.now = [time.time()]

    def inbox(self):
        return handoff.HandoffInbox(self.in_dir, self.claims, self.verifier, now=lambda: self.now[0])

    def write_job(self, filename="job1.json", role="human", sign_role=None, tamper=None, prompt="do the task",
                  job_id="job-1", go_over=None, req_over=None, issued_at=None, expires_at=None, sig=None):
        body = {
            "job_id": job_id,
            "go": make_go(prompt, **(go_over or {})),
            "request_doc": {"request": make_request(prompt, **(req_over or {})), "sig": "runner-sig-opaque"},
            "issued_at": issued_at if issued_at is not None else self.now[0],
            "expires_at": expires_at if expires_at is not None else self.now[0] + 300,
            "role": role,
        }
        if tamper:
            tamper(body)
        signature = sig if sig is not None else self.signer.sign(sign_role or role, canonical(body))
        doc = dict(body, sig=signature)
        path = os.path.join(self.in_dir, filename)
        with open(path, "w", encoding="utf-8") as f:
            f.write(json.dumps(doc, ensure_ascii=False))
        return filename


class HappyPath(HandoffBase):
    def test_valid_job_is_accepted_and_claimed(self):
        fn = self.write_job()
        d = self.inbox().accept(fn)
        self.assertTrue(d.ok, d.reason)
        self.assertEqual(d.source_kind, "git")
        self.assertEqual(d.request["approval_id"], "appr-1")
        # CLAIM の跡が claims に残る
        self.assertTrue(os.path.isfile(os.path.join(self.claims, "job-1.claim")))

    def test_source_bundle_go_selects_bundle(self):
        fn = self.write_job(go_over={"source_bundle": "/Users/_kaburun/handoff/in/src.bundle"})
        d = self.inbox().accept(fn)
        self.assertTrue(d.ok, d.reason)
        self.assertEqual(d.source_kind, "bundle")

    def test_second_accept_is_refused_at_most_once(self):
        fn = self.write_job()
        box = self.inbox()
        self.assertTrue(box.accept(fn).ok)
        again = self.inbox().accept(fn)  # 別インスタンスでも claims フォルダ経由で二重を拒否
        self.assertFalse(again.ok)
        self.assertIn("already claimed", again.reason)


class Rejections(HandoffBase):
    def _assert_rejected(self, fn, needle=None):
        d = self.inbox().accept(fn)
        self.assertFalse(d.ok)
        if needle:
            self.assertIn(needle, d.reason)
        # 拒否されたジョブは CLAIM されない
        self.assertEqual(os.listdir(self.claims), [])
        return d

    def test_bad_signature_is_refused(self):
        fn = self.write_job(sig="hmac-sha256:" + "0" * 64)
        self._assert_rejected(fn, "signature")

    def test_wrong_signing_key_is_refused(self):
        other = signing.HmacTestSigner({"human": b"attacker"})
        fn = self.write_job(sig=other.sign("human", b"x"))
        self._assert_rejected(fn, "signature")

    def test_runner_role_is_refused_only_human_signs_jobs(self):
        fn = self.write_job(role="runner", sign_role="runner")
        self._assert_rejected(fn, "role is not allowed")

    def test_tampered_body_after_signing_is_refused(self):
        # まず正しく署名してから、ファイル上の中身だけ書き換える
        fn = self.write_job()
        path = os.path.join(self.in_dir, fn)
        doc = json.load(open(path))
        doc["request_doc"]["request"]["prompt"] = "something else"
        open(path, "w").write(json.dumps(doc))
        self._assert_rejected(fn, "signature")

    def test_go_request_mismatch_is_refused(self):
        fn = self.write_job(req_over={"approval_id": "other"})
        self._assert_rejected(fn)

    def test_body_hash_mismatch_is_refused(self):
        # GO の body_sha256 が prompt と合わない
        fn = self.write_job(go_over={"body_sha256": "c" * 64})
        self._assert_rejected(fn)

    def test_invalid_go_is_refused(self):
        fn = self.write_job(go_over={"max_runs": 2})
        self._assert_rejected(fn, "GO")

    def test_expired_job_is_refused(self):
        fn = self.write_job(expires_at=self.now[0] - 1)
        self._assert_rejected(fn, "expired")

    def test_expired_go_is_refused(self):
        fn = self.write_job(go_over={"expires_at": time.time() - 1})
        self._assert_rejected(fn, "expired")

    def test_missing_request_field_is_refused(self):
        fn = self.write_job(tamper=lambda b: b["request_doc"]["request"].pop("base_sha"))
        self._assert_rejected(fn)

    def test_bad_base_sha_is_refused(self):
        fn = self.write_job(req_over={"base_sha": "nothex"})
        self._assert_rejected(fn)

    def test_extra_top_level_field_is_refused(self):
        fn = self.write_job(tamper=lambda b: b.__setitem__("extra", 1))
        self._assert_rejected(fn)

    def test_request_doc_with_empty_sig_is_refused(self):
        fn = self.write_job(tamper=lambda b: b["request_doc"].__setitem__("sig", ""))
        self._assert_rejected(fn, "signed request envelope")

    def test_bad_job_id_is_refused(self):
        fn = self.write_job(job_id="../escape")
        self._assert_rejected(fn)

    def test_non_basename_filename_is_refused(self):
        self.write_job(filename="job1.json")
        d = self.inbox().accept("sub/job1.json")
        self.assertFalse(d.ok)
        self.assertIn("basename", d.reason)

    def test_symlink_job_file_is_refused(self):
        target = os.path.join(self.tmp, "outside.json")
        open(target, "w").write("{}")
        link = os.path.join(self.in_dir, "link.json")
        os.symlink(target, link)
        d = self.inbox().accept("link.json")
        self.assertFalse(d.ok)

    def test_missing_job_file_is_refused(self):
        d = self.inbox().accept("nope.json")
        self.assertFalse(d.ok)


class DirSafety(HandoffBase):
    def test_in_dir_writable_by_group_or_other_is_refused(self):
        os.chmod(self.in_dir, 0o777)
        with self.assertRaises(handoff.HandoffError):
            self.inbox()

    def test_claims_dir_writable_by_group_or_other_is_refused(self):
        os.chmod(self.claims, 0o777)
        with self.assertRaises(handoff.HandoffError):
            self.inbox()

    def test_relative_dir_is_refused(self):
        with self.assertRaises(handoff.HandoffError):
            handoff.HandoffInbox("in", self.claims, self.verifier)


if __name__ == "__main__":
    unittest.main()
