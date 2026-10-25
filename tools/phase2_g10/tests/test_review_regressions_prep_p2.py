"""H2 第11TASK（C2）の反例の固定。修正前HEAD（36e4eb6a）では失敗し、修正後に通ることを確認する。

- R1: 共有台帳が、別名（シンボリックリンク）で2つに分裂し、ロックファイルの差し替えで成功した予約を失う。
- R2: launchd の計画で、Program キーによる実行先の上書き・Python 以外の実行ファイルが「有効」と判定される。
- R3: 署名器を作った後に秘密鍵を 0644 に緩めても署名できる（0600 の確認が作成時だけ）。

すべて自分の一時フォルダの中だけ（API・実鍵・launchctl は使わない）。修正前のコードでも動くように、振る舞いだけを使う。
"""
import os
import shutil
import tempfile
import threading
import unittest

from g10runner import ecdsa_signing as ec, launchd_plan as lp, shared_ledger as sl

NOW = 1792800000.0


class Tmp(unittest.TestCase):
    def setUp(self):
        self.tmp = os.path.realpath(tempfile.mkdtemp(prefix="g10p2-", dir="/tmp"))
        os.chmod(self.tmp, 0o700)
        self.addCleanup(shutil.rmtree, self.tmp, True)


class R1LedgerIdentity(Tmp):
    def test_symlink_alias_does_not_split_the_budget(self):
        master = os.path.join(self.tmp, "ledger.json")
        alias = os.path.join(self.tmp, "alias.json")
        m = sl.SharedRateLedger(master, 3, reserve_fraction=0)  # 許容2
        m.before_request(NOW)
        accepted = 1
        os.symlink(master, alias)
        try:
            a = sl.SharedRateLedger(alias, 3, reserve_fraction=0)
            a.before_request(NOW + 1)
            accepted += 1
        except (ValueError, sl.RateLimited):
            pass
        try:
            m.before_request(NOW + 2)
            accepted += 1
        except sl.RateLimited:
            pass
        self.assertLessEqual(accepted, 2, "an alias path split the shared budget")
        self.assertTrue(os.path.islink(alias), "saving through the alias replaced the symlink")

    def test_sidecar_replacement_does_not_lose_a_reservation(self):
        path = os.path.join(self.tmp, "ledger.json")
        a = sl.SharedRateLedger(path, 3, reserve_fraction=0)  # 許容2
        a.before_request(NOW)  # 1予約済み
        reached, release = threading.Event(), threading.Event()
        real_save = a._save

        def paused_save(*args, **kwargs):
            reached.set()
            release.wait(10)  # 判定の後・保存の前で止める
            return real_save(*args, **kwargs)
        a._save = paused_save
        results = []

        def run_a():
            try:
                a.before_request(NOW + 1)
                results.append("A")
            except sl.RateLimited:
                pass
        t = threading.Thread(target=run_a)
        t.start()
        self.assertTrue(reached.wait(10))
        os.unlink(path + ".lock")  # 自分の fixture の sidecar だけを差し替える
        try:
            b = sl.SharedRateLedger(path, 3, reserve_fraction=0)
            b.before_request(NOW + 2)
            results.append("B")
        except (ValueError, sl.RateLimited):
            pass
        release.set()
        t.join(15)
        import json
        saved = len(json.load(open(path))["sent"])
        self.assertLessEqual(1 + len(results), 2, "more reservations succeeded than allowed")
        self.assertEqual(saved, 1 + len(results), "a successful reservation was lost")


class R2LaunchdExecutionTarget(unittest.TestCase):
    def plan(self, **over):
        p = lp.watchdog_daemon_plan("/usr/bin/python3", "/Users/Shared/g10root", "_g10runner")
        p.update(over)
        return p

    def assert_rejected(self, plan):
        try:
            ok = lp.validate_plan(plan, current_user="yuya")
        except lp.PlanError:
            return
        self.fail("validate_plan accepted the plan (%r)" % ok)

    def test_program_key_cannot_override_the_executable(self):
        self.assert_rejected(self.plan(Program="/usr/bin/false"))

    def test_python_must_be_the_expected_interpreter(self):
        p = self.plan()
        p["ProgramArguments"] = ["/usr/bin/false"] + p["ProgramArguments"][1:]
        self.assert_rejected(p)


class R3KeyAtSignTime(Tmp):
    def test_key_loosened_after_construction_is_refused(self):
        priv, pub = ec.generate_keypair(self.tmp, "runner")
        signer = ec.EcdsaSigner({"runner": priv})
        os.chmod(priv, 0o644)  # 自分の fixture の鍵だけ
        try:
            signer.sign("runner", b"data")
        except Exception:
            return
        self.fail("signed with a private key readable by group/others")


class R1Boundaries(Tmp):
    """修正後の規則: 正規のパス・安全なフォルダ・通常ファイル・ロックの実体の一致。"""

    def led(self, path, **kw):
        return sl.SharedRateLedger(path, 10, reserve_fraction=0, **kw)

    def test_refused_at_construction(self):
        real = os.path.join(self.tmp, "real")
        os.makedirs(os.path.join(real, "inner"))
        os.symlink(real, os.path.join(self.tmp, "link"))
        open_dir = os.path.join(self.tmp, "open")
        os.makedirs(open_dir)
        os.chmod(open_dir, 0o777)
        dangling = os.path.join(self.tmp, "dangling.json")
        os.symlink(os.path.join(self.tmp, "nowhere.json"), dangling)
        hard_src = os.path.join(self.tmp, "hard.json")
        self.led(hard_src).before_request(NOW)
        os.link(hard_src, os.path.join(self.tmp, "hard2.json"))
        dir_path = os.path.join(self.tmp, "adir.json")
        os.makedirs(dir_path)
        lock_link = os.path.join(self.tmp, "ll.json")
        os.symlink(os.path.join(self.tmp, "nowhere.lock"), lock_link + ".lock")
        cases = {"relative": "ledger.json",
                 "symlinked ancestor": os.path.join(self.tmp, "link", "inner", "ledger.json"),
                 "group/other-writable dir": os.path.join(open_dir, "ledger.json"),
                 "dangling symlink": dangling,
                 "hard link alias": hard_src,
                 "directory": dir_path,
                 "dangling lock symlink": lock_link}
        for name, path in cases.items():
            with self.subTest(case=name):
                with self.assertRaises(ValueError):
                    self.led(path)

    def test_lock_replaced_after_construction_is_refused(self):
        path = os.path.join(self.tmp, "ledger.json")
        a = self.led(path)
        a.before_request(NOW)
        os.unlink(path + ".lock")
        self.led(path)  # 新しいロックを作る別のインスタンス
        with self.assertRaisesRegex(sl.RateLimited, "replaced"):
            a.before_request(NOW + 1)

    def test_data_replaced_by_a_symlink_is_corrupt(self):
        path = os.path.join(self.tmp, "ledger.json")
        a = self.led(path)
        a.before_request(NOW)
        other = os.path.join(self.tmp, "other.json")
        os.rename(path, other)
        os.symlink(other, path)
        with self.assertRaisesRegex(sl.RateLimited, "corrupt"):
            a.before_request(NOW + 1)


class R2Boundaries(unittest.TestCase):
    def plan(self, **over):
        p = lp.watchdog_daemon_plan("/usr/bin/python3", "/Users/Shared/g10root", "_g10runner")
        p.update(over)
        return p

    def test_rejected_plans(self):
        base = self.plan()
        missing = dict(base)
        del missing["ProcessType"]

        def args(**changes):
            a = list(base["ProgramArguments"])
            for i, v in changes.items():
                a[int(i[1:])] = v
            return self.plan(ProgramArguments=a)
        cases = {"BundleProgram": self.plan(BundleProgram="/usr/bin/false"),
                 "WorkingDirectory": self.plan(WorkingDirectory="/tmp"),
                 "inetdCompatibility": self.plan(inetdCompatibility={"Wait": False}),
                 "Sockets": self.plan(Sockets={}),
                 "missing key": missing,
                 "interval nan": args(i6="nan"), "interval inf": args(i6="inf"), "interval zero": args(i6="0"),
                 "interval negative": args(i6="-1"), "interval text": args(i6="soon"),
                 "relative root": args(i4="root"), "wrong flag": args(i3="--rootx"),
                 "extra argument": self.plan(ProgramArguments=base["ProgramArguments"] + ["--once"]),
                 "process type": self.plan(ProcessType="Interactive")}
        for name, p in cases.items():
            with self.subTest(case=name):
                with self.assertRaises(lp.PlanError):
                    lp.validate_plan(p, current_user="yuya")

    def test_render_validated(self):
        import plistlib
        data = lp.render_validated(self.plan(), current_user="yuya")
        self.assertEqual(plistlib.loads(data), self.plan())
        with self.assertRaises(lp.PlanError):
            lp.render_validated(self.plan(Program="/usr/bin/false"), current_user="yuya")


class R3Boundaries(Tmp):
    def setUp(self):
        super().setUp()
        self.priv, self.pub = ec.generate_keypair(self.tmp, "runner")
        self.signer = ec.EcdsaSigner({"runner": self.priv})
        self.verifier = ec.EcdsaVerifier({"runner": self.pub})

    def assert_refused(self):
        from g10runner import signing
        with self.assertRaises(signing.SignatureError):
            self.signer.sign("runner", b"data")

    def test_repeated_signing_still_works(self):
        for i in range(3):
            self.assertTrue(self.verifier.verify("runner", b"d%d" % i, self.signer.sign("runner", b"d%d" % i)))

    def test_replaced_by_a_symlink(self):
        moved = os.path.join(self.tmp, "moved.key")
        os.rename(self.priv, moved)
        os.symlink(moved, self.priv)
        self.assert_refused()

    def test_replaced_by_another_valid_key(self):
        other_dir = os.path.join(self.tmp, "other")
        os.makedirs(other_dir)
        other_priv, _ = ec.generate_keypair(other_dir, "runner")
        os.replace(other_priv, self.priv)  # 0600 の別の鍵（別の実体）
        self.assert_refused()

    def test_hard_link_added(self):
        os.link(self.priv, os.path.join(self.tmp, "copy.key"))
        self.assert_refused()
