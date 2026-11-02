"""専用ユーザー方式の『署名ジョブ発行』（producer, B0-4）。

yuya（制御プレーン）側で、現役 TASK（Issue #323）から、実行プレーン（_kaburun の常駐）が拾う **human 署名の
ジョブ** を handoff/in に1件だけ置く。ここでは実 Claude を呼ばない（起動は常駐）。手順:

1. ``build_go``: TASK の fields と実機の値（固定版 CLI・HOME・source_bundle）から REAL_CLAUDE_GO を組み、
   ``real_claude.go_problem`` で自己検査する。
2. ``emit_job``: 人の GO を承認（control_events へ追記。実行側は ``exec_root/pub`` の symlink 越しに ``find_go`` で読む）
   → ``control.try_claim``（runner 署名の request を書く）→ その request を読んで ``request_doc`` にし、ジョブ封筒を
   **human 鍵で署名**して handoff/in に atomically 置く。

鍵の配り方（§15.7）: runner/human の秘密鍵は yuya だけが持つ（exec には配らない）。GO は human 署名で control_events に
載り、exec の stub は ``find_go`` で pub 越しに読む。ジョブ封筒も human 署名で、exec は4役割の公開鍵で検証する。
source_bundle があるので、実行側は yuya の repo を読まず bundle だけで完走する（§14.9 指摘1）。
"""
import json
import os
import uuid

from . import real_claude
from .fsutil import canonical, fsync_dir, read_json, sha256_hex


class EmitError(RuntimeError):
    pass


def build_go(fields, body, cli_realpath, home, source_repo, source_bundle, expires_at,
             max_turns, go_id=None):
    """TASK の fields と実機の値から REAL_CLAUDE_GO を組む（source_bundle 入り）。問題があれば EmitError。

    approval_id・task_sha256 は TASK から、body_sha256 は本文から導く（try_claim / find_go の結合に一致させる）。
    source_bundle は実在する絶対パスでなければならない（置き忘れを発行時に弾く）。
    """
    if not (isinstance(source_bundle, str) and os.path.isabs(source_bundle) and os.path.isfile(source_bundle)):
        raise EmitError("source_bundle must be an existing absolute file: %r" % (source_bundle,))
    go = {
        "go_id": go_id or ("go-" + uuid.uuid4().hex[:16]),
        "approval_id": fields["phase2_approval_id"],
        "task_sha256": fields["phase2_task_sha256"],
        "body_sha256": sha256_hex(body.encode("utf-8")),
        "cli_realpath": cli_realpath,
        "cli_version": os.path.basename(cli_realpath),
        "home": home,
        "max_turns": max_turns,
        "source_repo": source_repo,
        "source_bundle": source_bundle,
        "expires_at": expires_at,
        "max_runs": 1,
    }
    problem = real_claude.go_problem(go)
    if problem:
        raise EmitError("REAL_CLAUDE_GO invalid: " + problem)
    return go


def _write_job_atomically(in_dir, filename, doc):
    """隠しの一時ファイルに書いて rename する。常駐は隠しファイル（先頭ドット）を候補にしないので、
    書き込み途中の部分的なジョブを拾わせない。rename は同じ in_dir 内なので原子的。"""
    data = (json.dumps(doc, ensure_ascii=False, sort_keys=True) + "\n").encode("utf-8")
    tmp = os.path.join(in_dir, "." + filename + ".tmp")
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.rename(tmp, os.path.join(in_dir, filename))
    fsync_dir(in_dir)


def emit_job(control, body, issue_meta, now, go, in_dir, job_ttl=1800.0, approve=True):
    """承認 → try_claim → request 読取 → human 署名ジョブを handoff/in へ。戻り値 dict(run_id, job_id, job_path, go_id)。

    approve=True のとき GO を承認する（同じ approval_id の GO が既にあれば approve_real_claude_go が拒否＝EmitError では
    なく GoReuseError をそのまま上げる。発行のやり直しは取消が先）。try_claim が拒否したら EmitError（握りつぶさない）。
    """
    if approve:
        control.approve_real_claude_go(go)          # GoReuseError / ValueError はそのまま上げる
    run_id, reason = control.try_claim(body, issue_meta, now)
    if run_id is None:
        raise EmitError("try_claim refused: " + str(reason))
    request_doc = read_json(control.layout.request_file(run_id))
    if not (isinstance(request_doc, dict) and set(request_doc) == {"request", "sig"}
            and isinstance(request_doc.get("sig"), str) and request_doc["sig"]):
        raise EmitError("request envelope malformed after try_claim")
    job_id = run_id                                  # run-xxxx は _JOB_ID に合致し一意
    filename = job_id + ".json"
    local_now = control.now()
    envelope = {"job_id": job_id, "go": go, "request_doc": request_doc,
                "issued_at": local_now, "expires_at": local_now + job_ttl, "role": "human"}
    sig = control.signer.sign("human", canonical(envelope))
    _write_job_atomically(in_dir, filename, dict(envelope, sig=sig))
    return {"run_id": run_id, "job_id": job_id, "job_path": os.path.join(in_dir, filename),
            "go_id": go["go_id"]}
