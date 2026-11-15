"""source bundle の作成（B0-4 producer 用）。yuya 側で、現役 TASK の base_sha を必ず含む自己完結の git bundle を
作る。実行プレーン（_kaburun）はこの bundle だけから作業フォルダを用意し、yuya の repo を一切読まない（§14.9 指摘1）。

subprocess を使うのは固定の /usr/bin/git（real_claude.GIT）だけ。Claude も launchctl も gh も push も起動しない。
"""
import os
import subprocess

from . import real_claude


class SourceBundleError(RuntimeError):
    pass


def _git(args, cwd):
    """固定の /usr/bin/git を、システム/利用者設定を読まない環境で起動する（HOME=cwd・端末プロンプト無効）。"""
    env = {"PATH": "/usr/bin:/bin", "LANG": "C", "GIT_CONFIG_NOSYSTEM": "1",
           "GIT_TERMINAL_PROMPT": "0", "HOME": cwd}
    return subprocess.run([real_claude.GIT, "-C", cwd] + args, env=env,
                          capture_output=True, text=True, timeout=300)


def make_source_bundle(source_repo, base_sha, bundles_dir, approval_id):
    """base_sha を必ず含む自己完結 bundle を作り、その絶対パスを返す。問題があれば SourceBundleError。

    `git bundle create <file> --all <base_sha>`: 全 ref に加えて base_sha のコミットも必ず入れる（ref から辿れなくても
    実行側が checkout できるように）。base_sha が repo に無ければ（別のチェックアウト等）、bundle を作らず弾く。
    """
    if _git(["cat-file", "-e", base_sha + "^{commit}"], source_repo).returncode != 0:
        raise SourceBundleError("source repo does not have base_sha %s (wrong checkout?)" % base_sha)
    os.makedirs(bundles_dir, exist_ok=True)
    bundle = os.path.realpath(os.path.join(bundles_dir, "%s-%s.bundle" % (approval_id, base_sha[:12])))
    r = _git(["bundle", "create", bundle, "--all", base_sha], source_repo)
    if r.returncode != 0 or not os.path.isfile(bundle):
        raise SourceBundleError("git bundle create failed: " + (r.stderr or "").strip()[:200])
    return bundle
