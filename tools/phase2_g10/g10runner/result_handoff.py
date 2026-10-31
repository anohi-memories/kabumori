"""専用ユーザー方式: ランの結果を _kaburun（実行）→ yuya（制御）に渡す橋（設計 §15.10・Q2）。

finalize は yuya 側のまま（GitHub の postflight・ledger の CLAIM 照合・ポリシー／wiring・取消・human/runner 署名）。
_kaburun は finalize が読む実行プレーンの成果物（request・registry の proc・run フォルダ・work フォルダ）を handoff/out に
**agent 署名つきのマニフェスト**で書き出す。yuya はマニフェストの署名と各ファイルの SHA-256・集合を検証してから、自分の
レイアウトに取り込み、既存の finalize をそのまま走らせる。

- 署名: `{"manifest": {...}, "sig": <agent 署名>}`（canonical バイトに署名。chainlog と同じ）。role=agent。
- マニフェストは run_id と、束の通常ファイルの相対パス→{sha, mode} と、ディレクトリの相対パス→mode を持つ。
  finalize の work フォルダの照合（tree_digest）は**ファイル内容とパーミッションの両方**を含むので、mode も保存・復元する。
- yuya は束の通常ファイルの集合がマニフェストと完全一致し、各ファイルの SHA-256 が一致することを確かめる
  （未署名のファイルの混入・改ざんを拒否）。シンボリックリンク等の通常ファイル以外は書き出し・取り込みとも拒否（fail-closed）。
- request 封筒は runner 署名つきなので、取り込み後も finalize/Agent 側で独立に検証される（この橋は配送の完全性を担う）。
"""
import os
import stat
import time

from . import handoff
from .fsutil import atomic_write_json, canonical, read_json, sha256_hex

MANIFEST = "manifest.json"
MANIFEST_ROLE = "agent"


class ResultHandoffError(ValueError):
    pass


def _read_regular(path):
    """通常ファイルを O_NOFOLLOW で読む（シンボリックリンク・特殊ファイルは拒否）。"""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ResultHandoffError("not a regular file: " + path)
        chunks = []
        while True:
            chunk = os.read(fd, 1 << 16)
            if not chunk:
                break
            chunks.append(chunk)
    finally:
        os.close(fd)
    return b"".join(chunks)


def _mode(path):
    return stat.S_IMODE(os.lstat(path).st_mode)


def _copy_file(src, bundle, rel, files):
    data = _read_regular(src)
    dst = os.path.join(bundle, rel)
    os.makedirs(os.path.dirname(dst) or bundle, exist_ok=True)
    with open(dst, "wb") as f:
        f.write(data)
    files[rel] = {"sha": sha256_hex(data), "mode": _mode(src)}


def _copy_tree(src_root, bundle, prefix, files, dirs):
    """src_root 以下を bundle/prefix/ に写し、files（通常ファイル）と dirs（ディレクトリの mode）を記録する。
    シンボリックリンク・特殊ファイルがあれば拒否（fail-closed）。"""
    dirs[prefix] = _mode(src_root)
    for dirpath, dirnames, filenames in os.walk(src_root):
        for name in sorted(dirnames):
            full = os.path.join(dirpath, name)
            if os.path.islink(full):
                raise ResultHandoffError("bundle may contain only regular files/dirs: " + full)
            rel = os.path.join(prefix, os.path.relpath(full, src_root))
            dirs[rel] = _mode(full)
            os.makedirs(os.path.join(bundle, rel), exist_ok=True)
        for name in sorted(filenames):
            full = os.path.join(dirpath, name)
            st = os.lstat(full)
            if not stat.S_ISREG(st.st_mode) or stat.S_ISLNK(st.st_mode):
                raise ResultHandoffError("bundle may contain only regular files/dirs: " + full)
            _copy_file(full, bundle, os.path.join(prefix, os.path.relpath(full, src_root)), files)


def export_result(layout, run_id, out_dir, signer, now=time.time):
    """実行プレーンの成果物を out_dir/<run_id>/ に agent 署名つきで書き出す。"""
    handoff._safe_owned_dir(out_dir)  # _kaburun 所有・group/other 書き込み不可
    if not handoff._JOB_ID.fullmatch(run_id):
        raise ResultHandoffError("run_id invalid")
    bundle = os.path.join(out_dir, run_id)
    if os.path.exists(bundle):
        raise ResultHandoffError("result bundle already exists")
    os.makedirs(bundle, 0o700)
    files, dirs = {}, {}
    _copy_file(layout.request_file(run_id), bundle, "request.json", files)
    _copy_file(layout.proc_file(run_id), bundle, "proc.json", files)
    _copy_tree(layout.run_dir(run_id), bundle, "run", files, dirs)
    work = layout.work_dir(run_id)
    if os.path.isdir(work):
        _copy_tree(work, bundle, "work", files, dirs)
    manifest = {"run_id": run_id, "created_at": now(), "files": files, "dirs": dirs}
    atomic_write_json(os.path.join(bundle, MANIFEST),
                      {"manifest": manifest, "sig": signer.sign(MANIFEST_ROLE, canonical(manifest))})
    return manifest


def _bundle_regular_files(bundle):
    """束の中の通常ファイルの相対パス一覧（MANIFEST を除く。シンボリックリンク等があれば拒否）。"""
    rels = []
    for dirpath, dirnames, filenames in os.walk(bundle):
        for name in dirnames:
            if os.path.islink(os.path.join(dirpath, name)):
                raise ResultHandoffError("bundle contains a symlink")
        for name in filenames:
            full = os.path.join(dirpath, name)
            if not stat.S_ISREG(os.lstat(full).st_mode):
                raise ResultHandoffError("bundle contains a non-regular file: " + full)
            rel = os.path.relpath(full, bundle)
            if rel != MANIFEST:
                rels.append(rel)
    return set(rels)


def _verify_bundle(bundle, verifier):
    """束のマニフェストの署名とファイル集合・SHA-256 を検証。問題なければ (manifest, {rel: bytes}) を返す。"""
    if not (os.path.isdir(bundle) and not os.path.islink(bundle)):
        raise ResultHandoffError("result bundle is not a directory")
    env = read_json(os.path.join(bundle, MANIFEST))
    if not (isinstance(env, dict) and set(env) == {"manifest", "sig"} and isinstance(env.get("sig"), str)):
        raise ResultHandoffError("manifest envelope invalid")
    manifest = env["manifest"]
    if not verifier.verify(MANIFEST_ROLE, canonical(manifest), env["sig"]):
        raise ResultHandoffError("manifest signature does not verify for the agent role")
    if not (isinstance(manifest, dict) and isinstance(manifest.get("files"), dict)
            and isinstance(manifest.get("dirs"), dict) and handoff._JOB_ID.fullmatch(str(manifest.get("run_id")))):
        raise ResultHandoffError("manifest invalid")
    if _bundle_regular_files(bundle) != set(manifest["files"]):
        raise ResultHandoffError("bundle files do not match the manifest")
    data = {}
    for rel, meta in manifest["files"].items():
        if os.path.isabs(rel) or os.path.normpath(rel).startswith(".."):
            raise ResultHandoffError("manifest path escapes the bundle: " + rel)
        if not (isinstance(meta, dict) and set(meta) == {"sha", "mode"}):
            raise ResultHandoffError("manifest file entry invalid: " + rel)
        raw = _read_regular(os.path.join(bundle, rel))
        if sha256_hex(raw) != meta["sha"]:
            raise ResultHandoffError("file digest mismatch: " + rel)
        data[rel] = raw
    for rel in manifest["dirs"]:
        if os.path.isabs(rel) or os.path.normpath(rel).startswith(".."):
            raise ResultHandoffError("manifest dir escapes the bundle: " + rel)
    return manifest, data


def ingest_result(out_dir, run_id, dest_layout, verifier):
    """out_dir/<run_id>/ を検証し、dest_layout の finalize が読む場所に取り込む。戻り値: manifest。"""
    handoff._safe_source_dir(out_dir)  # yuya=読み（_kaburun=書き・group/other 不可）
    if not handoff._JOB_ID.fullmatch(run_id):
        raise ResultHandoffError("run_id invalid")
    bundle = os.path.join(out_dir, run_id)
    manifest, data = _verify_bundle(bundle, verifier)
    if manifest["run_id"] != run_id:
        raise ResultHandoffError("manifest run_id differs from the requested run")

    def dest_path(rel):
        if rel == "request.json":
            return dest_layout.request_file(run_id)
        if rel == "proc.json":
            return dest_layout.proc_file(run_id)
        if rel == "run" or rel.startswith("run/"):
            return os.path.join(dest_layout.run_dir(run_id), rel[len("run/"):]) if rel != "run" \
                else dest_layout.run_dir(run_id)
        if rel == "work" or rel.startswith("work/"):
            return os.path.join(dest_layout.work_dir(run_id), rel[len("work/"):]) if rel != "work" \
                else dest_layout.work_dir(run_id)
        raise ResultHandoffError("unexpected bundle entry: " + rel)

    # 先にディレクトリを作り（書き込み可のまま）、ファイルを書き、最後に mode を復元する
    for rel in manifest["dirs"]:
        os.makedirs(dest_path(rel), exist_ok=True)
    for rel, raw in data.items():
        dst = dest_path(rel)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, "wb") as f:
            f.write(raw)
        os.chmod(dst, manifest["files"][rel]["mode"])
    # ディレクトリの mode は、子の書き込みを終えてから、深い方から復元する（読み取り専用でも親に影響しない）
    for rel in sorted(manifest["dirs"], key=lambda r: r.count(os.sep), reverse=True):
        os.chmod(dest_path(rel), manifest["dirs"][rel])
    return manifest
