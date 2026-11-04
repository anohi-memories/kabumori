"""固定版（不変のスナップショット）の作成と検証（TASK 22）。

常駐（LaunchAgent）の検知役・S2・スタブが、動き続ける G10 の開発 worktree ではなく、いつも同じ検証済みのコードを
使うようにする。

- install: 開発 worktree の tools/phase2_g10 の実行に要るファイル（g10runner・bin・fake_claude の *.py）を、
  固定の親フォルダの下の `<版>/` へ写す。版はマニフェスト（各ファイルの SHA-256 と git のコミット）のハッシュの先頭16桁。
  - 写す前に、元が git で変更なし（tools/phase2_g10 に未コミットの変更が無い）であることを確かめる。
  - 一時フォルダに写してマニフェストを書き、ファイルを 0444・フォルダを 0555 にしてから、名前を変えて置く。
  - 同じ版が既にあれば、検証して再利用する（上書きしない）。
- verify: マニフェストのハッシュが期待の版のハッシュと一致し、ファイルの集合・中身・権限（書き込み不可）・
  シンボリックリンクなしがマニフェストどおりかを確かめ、問題の一覧を返す（空なら合格）。
- 検知役は、起動の前ごとに verify を行い、合わなければハードHALT にして起動しない（bin/g10_autorun.py）。
"""
import json
import os
import re
import shutil
import stat
import subprocess
import tempfile

from .fsutil import canonical, sha256_hex

GIT = "/usr/bin/git"
MANIFEST = "manifest.json"
DIRS = ("g10runner", "bin", "fake_claude")
_DIGEST = re.compile(r"[0-9a-f]{64}")


class ReleaseError(ValueError):
    pass


def collect(package_root):
    """固定版に含めるファイル（相対パス・並べ替え済み）。"""
    out = []
    for d in DIRS:
        base = os.path.join(package_root, d)
        for name in sorted(os.listdir(base)):
            if name.endswith(".py") and os.path.isfile(os.path.join(base, name)):
                out.append(d + "/" + name)
    return out


def _file_sha(path):
    with open(path, "rb") as f:
        return sha256_hex(f.read())


def manifest_digest(manifest):
    return sha256_hex(canonical({"files": manifest["files"], "git_commit": manifest["git_commit"]}))


def _git(args, cwd):
    r = subprocess.run([GIT] + args, cwd=cwd, capture_output=True, timeout=60,
                       env={"PATH": "/usr/bin:/bin", "LANG": "C", "GIT_CONFIG_NOSYSTEM": "1", "HOME": "/nonexistent"})
    if r.returncode != 0:
        raise ReleaseError("git %s failed" % args[0])
    return r.stdout.decode("utf-8", "replace")


def source_commit(package_root):
    """元の git のコミット。tools/phase2_g10 に未コミットの変更があれば ReleaseError（写すものを確定できない）。"""
    if _git(["status", "--porcelain", "--untracked-files=all", "--", "."], package_root).strip():
        raise ReleaseError("the source has uncommitted changes; commit them before installing")
    return _git(["rev-parse", "HEAD"], package_root).strip()


def install(package_root, dest_parent, git_commit=None):
    """固定版を作る。(版のフォルダ, マニフェストのハッシュ) を返す。"""
    git_commit = source_commit(package_root) if git_commit is None else git_commit
    files = {rel: _file_sha(os.path.join(package_root, rel)) for rel in collect(package_root)}
    manifest = {"version": 1, "git_commit": git_commit, "files": files}
    digest = manifest_digest(manifest)
    manifest["digest"] = digest
    os.makedirs(dest_parent, 0o700, exist_ok=True)
    dest = os.path.join(dest_parent, digest[:16])
    if os.path.exists(dest):
        problems = verify(dest, digest)
        if problems:
            raise ReleaseError("an existing release with this version does not verify: %s" % problems[:3])
        return dest, digest
    tmp = tempfile.mkdtemp(prefix=".install-", dir=dest_parent)
    try:
        for rel in files:
            os.makedirs(os.path.join(tmp, os.path.dirname(rel)), exist_ok=True)
            shutil.copyfile(os.path.join(package_root, rel), os.path.join(tmp, rel))
        with open(os.path.join(tmp, MANIFEST), "w", encoding="utf-8") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=1, sort_keys=True)
        for rel in files:
            if _file_sha(os.path.join(tmp, rel)) != files[rel]:
                raise ReleaseError("copy changed while installing: %s" % rel)
        _freeze(tmp)
        os.rename(tmp, dest)
    except BaseException:
        _thaw(tmp)
        shutil.rmtree(tmp, ignore_errors=True)
        raise
    problems = verify(dest, digest)
    if problems:
        raise ReleaseError("the installed release does not verify: %s" % problems[:3])
    return dest, digest


def _freeze(root):
    for dirpath, dirnames, filenames in os.walk(root):
        for name in filenames:
            os.chmod(os.path.join(dirpath, name), 0o444)
    for dirpath, dirnames, filenames in os.walk(root, topdown=False):
        os.chmod(dirpath, 0o555)


def _thaw(root):
    for dirpath, dirnames, filenames in os.walk(root):
        os.chmod(dirpath, 0o700)


def verify(release_dir, expected_digest):
    """固定版の検証。問題の一覧（空なら合格）。"""
    if not (isinstance(expected_digest, str) and _DIGEST.fullmatch(expected_digest)):
        return ["expected digest is not a sha256 hex"]
    try:
        with open(os.path.join(release_dir, MANIFEST), encoding="utf-8") as f:
            manifest = json.load(f)
    except (OSError, ValueError) as exc:
        return ["manifest unreadable: %s" % type(exc).__name__]
    problems = []
    files = manifest.get("files") if isinstance(manifest, dict) else None
    if not isinstance(files, dict) or not isinstance(manifest.get("git_commit"), str):
        return ["manifest shape invalid"]
    digest = manifest_digest(manifest)
    if digest != expected_digest or manifest.get("digest") != expected_digest:
        problems.append("manifest digest differs from the expected release")
    if os.path.basename(os.path.normpath(release_dir)) != expected_digest[:16]:
        problems.append("release folder name differs from the digest")
    actual = set()
    for dirpath, dirnames, filenames in os.walk(release_dir):
        for name in dirnames + filenames:
            p = os.path.join(dirpath, name)
            if os.path.islink(p):
                problems.append("symlink in release: %s" % os.path.relpath(p, release_dir))
        for name in filenames:
            rel = os.path.relpath(os.path.join(dirpath, name), release_dir)
            if rel != MANIFEST:
                actual.add(rel)
    if actual != set(files):
        problems.append("file set differs (extra %s, missing %s)" % (sorted(actual - set(files))[:3],
                                                                     sorted(set(files) - actual)[:3]))
    for rel, sha in sorted(files.items()):
        p = os.path.join(release_dir, rel)
        if rel in actual and _file_sha(p) != sha:
            problems.append("content differs: %s" % rel)
    for dirpath, dirnames, filenames in os.walk(release_dir):
        for name in [""] + filenames:
            p = os.path.join(dirpath, name) if name else dirpath
            if not os.path.islink(p) and os.stat(p).st_mode & (stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH):
                problems.append("writable in release: %s" % (os.path.relpath(p, release_dir)))
    return problems


def package_manifest(package_root):
    """このパッケージが固定版ならマニフェスト、開発 worktree なら None。"""
    try:
        with open(os.path.join(package_root, MANIFEST), encoding="utf-8") as f:
            return json.load(f)
    except OSError:
        return None
