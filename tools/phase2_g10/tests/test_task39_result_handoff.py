"""設計 §15.10・Q2: ランの結果を _kaburun→yuya に渡す橋 result_handoff（export/ingest）。
agent 署名つきマニフェストの検証・ファイル集合と SHA-256 の一致・取り込み後に既存 finalize が緑になること。
実 Claude は使わない。E2E は代役CLI。"""
import json
import os
import shutil
import tempfile
import time
import unittest

from g10runner import handoff, result_handoff, signing
from g10runner.layout import Layout
from test_task38_dispatch import DispatchBase

AGENT = {"agent": b"agent-key"}


def make_writable(root):
    for dirpath, dirnames, filenames in os.walk(root):
        for name in [dirpath] + [os.path.join(dirpath, f) for f in filenames]:
            try:
                os.chmod(name, 0o700)
            except OSError:
                pass


class RoundTrip(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.src = Layout(os.path.join(self.tmp, "src"))
        self.dst = Layout(os.path.join(self.tmp, "dst"))
        for lay in (self.src, self.dst):
            lay.ensure()
        self.out = os.path.join(self.tmp, "out")
        os.makedirs(self.out, 0o700)
        self.signer = signing.HmacTestSigner(AGENT)
        self.verifier = signing.HmacTestVerifier(AGENT)
        self.run_id = "run-0123456789abcdef"
        self._seed()

    def _seed(self):
        with open(self.src.request_file(self.run_id), "w") as f:
            json.dump({"request": {"run_id": self.run_id}, "sig": "runner"}, f)
        os.makedirs(os.path.dirname(self.src.proc_file(self.run_id)), exist_ok=True)
        with open(self.src.proc_file(self.run_id), "w") as f:
            json.dump({"run_id": self.run_id, "state": "exited"}, f)
        rd = self.src.run_dir(self.run_id)
        os.makedirs(rd)
        with open(os.path.join(rd, "result.json"), "w") as f:
            json.dump({"exit_code": 0}, f)
        wd = self.src.work_dir(self.run_id)
        os.makedirs(os.path.join(wd, "sub"))
        with open(os.path.join(wd, "sub", "f.txt"), "w") as f:
            f.write("hello\n")

    def export(self):
        return result_handoff.export_result(self.src, self.run_id, self.out, self.signer)

    def test_round_trip_lands_all_files(self):
        self.export()
        result_handoff.ingest_result(self.out, self.run_id, self.dst, self.verifier)
        self.assertTrue(os.path.isfile(self.dst.request_file(self.run_id)))
        self.assertTrue(os.path.isfile(self.dst.proc_file(self.run_id)))
        self.assertTrue(os.path.isfile(os.path.join(self.dst.run_dir(self.run_id), "result.json")))
        self.assertEqual(open(os.path.join(self.dst.work_dir(self.run_id), "sub", "f.txt")).read(), "hello\n")

    def test_tampered_file_is_rejected(self):
        self.export()
        with open(os.path.join(self.out, self.run_id, "run", "result.json"), "w") as f:
            f.write('{"exit_code": 1}')  # 署名後に書き換え
        with self.assertRaises(result_handoff.ResultHandoffError):
            result_handoff.ingest_result(self.out, self.run_id, self.dst, self.verifier)
        self.assertFalse(os.path.exists(self.dst.request_file(self.run_id)))  # 取り込まれない

    def test_unlisted_extra_file_is_rejected(self):
        self.export()
        with open(os.path.join(self.out, self.run_id, "run", "sneaked.txt"), "w") as f:
            f.write("x")  # マニフェストに無いファイルの混入
        with self.assertRaises(result_handoff.ResultHandoffError):
            result_handoff.ingest_result(self.out, self.run_id, self.dst, self.verifier)

    def test_bad_signature_is_rejected(self):
        self.export()
        wrong = signing.HmacTestVerifier({"agent": b"other"})
        with self.assertRaises(result_handoff.ResultHandoffError):
            result_handoff.ingest_result(self.out, self.run_id, self.dst, wrong)

    def test_export_refuses_symlink_in_tree(self):
        os.symlink("/etc/hosts", os.path.join(self.src.run_dir(self.run_id), "link"))
        with self.assertRaises(result_handoff.ResultHandoffError):
            self.export()

    def test_symlink_manifest_is_rejected(self):
        """out は _kaburun 所有: manifest.json を symlink に差し替えても、ingest は O_NOFOLLOW で拒否する（read_json 追従の塞ぎ）。"""
        self.export()
        man = os.path.join(self.out, self.run_id, result_handoff.MANIFEST)
        os.remove(man)
        os.symlink("/etc/hosts", man)
        with self.assertRaises(result_handoff.ResultHandoffError):
            result_handoff.ingest_result(self.out, self.run_id, self.dst, self.verifier)

    def test_ingest_refuses_to_overwrite_an_already_ingested_run(self):
        """取り込み側の at-most-once: 同じ run の束を二度 ingest しても、既存の成果物を上書きしない。"""
        self.export()
        result_handoff.ingest_result(self.out, self.run_id, self.dst, self.verifier)
        with self.assertRaises(result_handoff.ResultHandoffError):
            result_handoff.ingest_result(self.out, self.run_id, self.dst, self.verifier)


    def test_exported_bundle_is_readable_across_the_handoff_boundary(self):
        """out は _kaburun 所有。yuya が ingest で読めるよう、束の dir=他者 read+traverse・file=他者 read に広げる
        （group/other 書き込みは与えない）。umask 077 の 0600/0700 のまま出すと yuya が読めず ingest が詰まる回帰を防ぐ。"""
        self.export()
        bundle = os.path.join(self.out, self.run_id)
        self.assertEqual(os.stat(bundle).st_mode & 0o005, 0o005)
        for dirpath, dirnames, filenames in os.walk(bundle):
            for name in dirnames:
                m = os.stat(os.path.join(dirpath, name)).st_mode
                self.assertEqual(m & 0o005, 0o005, "dir readable+traversable: " + name)
                self.assertFalse(m & 0o022, "no group/other write on dir: " + name)
            for name in filenames:
                m = os.stat(os.path.join(dirpath, name)).st_mode
                self.assertTrue(m & 0o004, "file readable by other: " + name)
                self.assertFalse(m & 0o022, "no group/other write on file: " + name)


class JobIdPattern(unittest.TestCase):
    def test_pure_dot_names_are_rejected(self):
        self.assertIsNone(handoff._JOB_ID.fullmatch("."))
        self.assertIsNone(handoff._JOB_ID.fullmatch(".."))
        self.assertIsNone(handoff._JOB_ID.fullmatch("..."))
        self.assertTrue(handoff._JOB_ID.fullmatch("job-1"))
        self.assertTrue(handoff._JOB_ID.fullmatch("run-0123456789abcdef"))


class FinalizeViaOut(DispatchBase):
    """E2E: ラン後に結果を out へ export → 実行プレーンの成果物を消す → out から ingest → 既存 finalize が緑。
    out 束だけで finalize に必要なものが全部そろっていること（＝yuya が out 経由で finalize できる）を示す。"""

    def test_finalize_succeeds_only_from_the_exported_bundle(self):
        bundle = self.make_bundle()
        go = self.go_doc(source_bundle=bundle)
        run_id, request_doc = self.approve_and_claim(go)
        self.place_job(go, request_doc)
        self.assertEqual(self.loop().step()["decision"], "ran")
        self.wait_terminal(run_id, 60)

        signer = signing.HmacTestSigner(AGENT)
        verifier = signing.HmacTestVerifier(AGENT)
        rout = os.path.join(self.env.real, "rout")
        os.makedirs(rout, 0o700)
        result_handoff.export_result(self.env.layout, run_id, rout, signer)

        # 実行プレーンの成果物を消す（finalize が out 束だけに頼ることを強制）
        for p in (self.env.layout.request_file(run_id), self.env.layout.proc_file(run_id)):
            os.remove(p)
        for d in (self.env.layout.run_dir(run_id), self.env.layout.work_dir(run_id)):
            make_writable(d)
            shutil.rmtree(d)

        result_handoff.ingest_result(rout, run_id, self.env.layout, verifier)
        status, _end = self.env.control.finalize(run_id, current_body=self.body)
        self.assertEqual(status, "ended_checks_passed", status)



class IngestedFinalize(DispatchBase):
    """分割の締め: 取り込んだ run の finalize(ingested=True) は、exec が書いた spawn_evidence と終端状態を信用し、
    control 側で #323 を取り直さず・exec のプロセスを再観測しない。再取得も観測もできない状況（witness=None・
    run_processes_present=None）でも ended_checks_passed になることを確かめる（単一プロセス前提の誤検知で止めない）。"""
    def test_ingested_finalize_trusts_bundle_without_refetch_or_reobserve(self):
        from unittest import mock
        from g10runner import supervise
        bundle = self.make_bundle()
        go = self.go_doc(source_bundle=bundle)
        run_id, request_doc = self.approve_and_claim(go)
        self.place_job(go, request_doc)
        self.assertEqual(self.loop().step()["decision"], "ran")
        self.wait_terminal(run_id, 60)
        signer = signing.HmacTestSigner(AGENT)
        verifier = signing.HmacTestVerifier(AGENT)
        rout = os.path.join(self.env.real, "rout-ing")
        os.makedirs(rout, 0o700)
        result_handoff.export_result(self.env.layout, run_id, rout, signer)
        for pth in (self.env.layout.request_file(run_id), self.env.layout.proc_file(run_id)):
            os.remove(pth)
        for d in (self.env.layout.run_dir(run_id), self.env.layout.work_dir(run_id)):
            make_writable(d)
            shutil.rmtree(d)
        result_handoff.ingest_result(rout, run_id, self.env.layout, verifier)
        # 分割相当: control は #323 を取り直せず（witness なし）、exec のプロセスも観測できない
        self.env.control.witness = None
        with mock.patch.object(supervise, "run_processes_present", return_value=None):
            status, _end = self.env.control.finalize(run_id, ingested=True)
        self.assertEqual(status, "ended_checks_passed", status)


if __name__ == "__main__":
    unittest.main()
