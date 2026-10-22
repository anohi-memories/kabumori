"""プロセス登録簿。仕様 v5 §7-1、v5.1 §1、v5.2 §1、v5.1 §5-2。

- 不変の項目（run_id・session_id・settings_path・hard_deadline・policy_sha256・request_id・
  approval_id・task_id）は、作成時に immutable_sha256 として固定し、読むたびに照合する。
- 状態は、定められた遷移だけを許す。
"""
import os

from .fsutil import FileLock, atomic_write_json, canonical, read_json, sha256_hex, touch

IMMUTABLE = ("run_id", "session_id", "settings_path", "hard_deadline", "policy_sha256",
             "request_id", "approval_id", "task_id", "uid", "root", "task_sha256")
NON_TERMINAL = ("starting", "running")
TERMINAL = ("exited", "interrupted", "aborted_before_spawn", "aborted_by_halt", "runner_crashed")
UNRESOLVED = ("stop_unconfirmed",)
TRANSITIONS = {
    "starting": {"running", "aborted_before_spawn", "aborted_by_halt", "runner_crashed",
                 "interrupted", "stop_unconfirmed"},
    "running": {"exited", "interrupted", "runner_crashed", "stop_unconfirmed"},
    "stop_unconfirmed": {"interrupted", "runner_crashed"},
}


class RegistryError(ValueError):
    pass


def _immutable_digest(entry):
    return sha256_hex(canonical({k: entry.get(k) for k in IMMUTABLE}))


def identity(entry):
    """プロセスの識別子（正確な session_id・ランの settings の正規化パス・uid）。H3 R3。"""
    from .procs import RunIdentity
    return RunIdentity(entry["session_id"], entry["settings_path"], entry["uid"])


def create(layout, fields):
    path = layout.proc_file(fields["run_id"])
    if os.path.exists(path):
        raise RegistryError("registry entry already exists: " + fields["run_id"])
    entry = dict(fields)
    entry["state"] = "starting"
    entry["immutable_sha256"] = _immutable_digest(entry)
    touch(path + ".lock")
    atomic_write_json(path, entry)
    return entry


def load(layout, run_id):
    entry = read_json(layout.proc_file(run_id))
    if entry is None:
        return None
    if entry.get("immutable_sha256") != _immutable_digest(entry):
        raise RegistryError("immutable fields changed: " + run_id)
    if entry.get("state") not in NON_TERMINAL + TERMINAL + UNRESOLVED:
        raise RegistryError("unknown state: " + run_id)
    return entry


def update(layout, run_id, new_state=None, **mutable):
    path = layout.proc_file(run_id)
    touch(path + ".lock")
    with FileLock(path + ".lock", "ex"):
        entry = load(layout, run_id)
        if entry is None:
            raise RegistryError("no registry entry: " + run_id)
        for key in mutable:
            if key in IMMUTABLE or key in ("state", "immutable_sha256"):
                raise RegistryError("cannot change protected field: " + key)
        if new_state is not None and new_state != entry["state"]:
            allowed = TRANSITIONS.get(entry["state"], set())
            if new_state not in allowed:
                raise RegistryError("invalid transition %s -> %s" % (entry["state"], new_state))
            entry["state"] = new_state
        entry.update(mutable)
        atomic_write_json(path, entry)
        return entry


def all_entries(layout):
    out = []
    for name in sorted(os.listdir(layout.proc)):
        if name.endswith(".json"):
            out.append(name[:-5])
    return out


def inconsistencies(layout):
    """登録簿の不整合（不変項目の変更・未知の状態・読めない）を列挙する。"""
    problems = []
    for run_id in all_entries(layout):
        try:
            load(layout, run_id)
        except (RegistryError, ValueError) as exc:
            problems.append(str(exc))
    return problems


def non_terminal(layout):
    out = []
    for run_id in all_entries(layout):
        try:
            e = load(layout, run_id)
        except (RegistryError, ValueError):
            continue
        if e and e["state"] in NON_TERMINAL + UNRESOLVED:
            out.append(e)
    return out
