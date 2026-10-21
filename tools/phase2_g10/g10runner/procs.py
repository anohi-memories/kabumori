"""プロセスの観測・識別・停止。仕様 v5 §7、v5.3 §5。

- 観測は ps の読み取りだけ（他のプロセスの内容には触れない）。
- 停止は、識別（pid・開始時刻・識別用の起動引数）が一致したものだけを対象にする。
  pid の再利用や、手動で起動した別のプロセスを誤って止めない。
"""
import os
import signal
import subprocess
import time


def _ps(args):
    try:
        out = subprocess.run(["/bin/ps"] + args, capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired):
        return None
    if out.returncode != 0:
        return None
    return out.stdout


def start_time(pid):
    text = _ps(["-o", "lstart=", "-p", str(pid)])
    if not text or not text.strip():
        return None
    return " ".join(text.split())


def command(pid):
    text = _ps(["-ww", "-o", "command=", "-p", str(pid)])
    if not text or not text.strip():
        return None
    return text.strip()


def is_zombie(pid):
    text = _ps(["-o", "stat=", "-p", str(pid)])
    return bool(text) and text.strip().startswith("Z")


def alive(pid):
    """生存しているか（終了済みで親に回収されていないゾンビは、生存とみなさない）。"""
    if not pid:
        return False
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return not is_zombie(pid)


def snapshot():
    """全プロセスの一覧（pid・ppid・pgid・uid・起動引数）。ゾンビ（終了済み）は含めない。"""
    text = _ps(["-axww", "-o", "pid=,ppid=,pgid=,uid=,stat=,command="])
    rows = []
    if not text:
        return rows
    for line in text.splitlines():
        parts = line.split(None, 5)
        if len(parts) < 5:
            continue
        if parts[4].startswith("Z"):
            continue
        try:
            rows.append({"pid": int(parts[0]), "ppid": int(parts[1]), "pgid": int(parts[2]),
                         "uid": int(parts[3]), "command": parts[5] if len(parts) > 5 else ""})
        except ValueError:
            continue
    return rows


def find_by_marker(marker, rows=None):
    rows = snapshot() if rows is None else rows
    me = os.getpid()
    return [r for r in rows if marker in r["command"] and r["pid"] != me]


def in_group(pgid, rows=None):
    rows = snapshot() if rows is None else rows
    return [r for r in rows if r["pgid"] == pgid]


def identity_ok(pid, expected_start, marker=None):
    """pid の開始時刻（と、指定があれば起動引数の識別子）が一致するときだけ True。"""
    if not alive(pid):
        return False
    if expected_start is not None and start_time(pid) != expected_start:
        return False
    if marker is not None:
        cmd = command(pid)
        if cmd is None or marker not in cmd:
            return False
    return True


def _targets(pgid, marker):
    rows = snapshot()
    found = {}
    if pgid:
        for r in in_group(pgid, rows):
            found[r["pid"]] = r
    if marker:
        for r in find_by_marker(marker, rows):
            found[r["pid"]] = r
    found.pop(os.getpid(), None)
    return found


def _signal_all(targets, pgid, sig):
    if pgid:
        try:
            os.killpg(pgid, sig)
        except (ProcessLookupError, PermissionError):
            pass
    for pid in targets:
        try:
            os.kill(pid, sig)
        except (ProcessLookupError, PermissionError):
            pass


def terminate(pgid, marker, grace, confirm):
    """プロセスグループと、識別子を持つプロセスを、SIGTERM → 猶予 → SIGKILL → 不在確認。

    戻り値: (absent: bool, details: dict)
    pgid は、識別を確認したグループだけを渡すこと（呼び出し側の責任）。
    """
    details = {"pgid": pgid, "marker": marker, "term_targets": [], "kill_targets": [], "remaining": []}
    targets = _targets(pgid, marker)
    details["term_targets"] = sorted(targets)
    if not targets:
        return True, details
    _signal_all(targets, pgid, signal.SIGTERM)
    deadline = time.monotonic() + grace
    while time.monotonic() < deadline:
        targets = _targets(pgid, marker)
        if not targets:
            return True, details
        time.sleep(0.05)
    targets = _targets(pgid, marker)
    details["kill_targets"] = sorted(targets)
    _signal_all(targets, pgid, signal.SIGKILL)
    deadline = time.monotonic() + confirm
    while time.monotonic() < deadline:
        targets = _targets(pgid, marker)
        if not targets:
            return True, details
        time.sleep(0.05)
    details["remaining"] = sorted(_targets(pgid, marker))
    return not details["remaining"], details
