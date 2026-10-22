"""プロセスの観測・識別・停止。仕様 v5 §7、v5.3 §5。H3 レビュー R2・R3 の修正。

- R2: 観測の失敗（ps の timeout・OSError・異常終了・解析できない行・空の一覧・argv を読めない）は
  ObservationError として伝える。「空の一覧（正常）」と「観測できない」を区別し、観測できないときに
  「不在」と判定しない。terminate は absent／unknown を分けて返す。
- R3: 停止対象は、session_id の部分一致ではなく、正確な argv のトークン
  （`--session-id <uuid>` がちょうど1つ、かつ `--settings <path>` の正規化パスがランのものと一致）と、
  期待する uid・pid・開始時刻で識別する。signal の直前に開始時刻を再照合する（pid の再利用対策）。
  開始時刻が無い・読めないものは停止しない。
"""
import ctypes
import ctypes.util
import os
import signal
import subprocess
import sys
import time


class ObservationError(RuntimeError):
    """プロセスを観測できない（不在とは区別する）。"""


def _ps(args):
    try:
        out = subprocess.run(["/bin/ps"] + args, capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ObservationError("ps failed: %s" % type(exc).__name__)
    return out.returncode, out.stdout


def _exists_by_kill(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def pid_status(pid):
    """'absent'／'alive'／'zombie'。存在するのに状態を読めなければ ObservationError。"""
    if not isinstance(pid, int) or pid <= 0:
        return "absent"
    if not _exists_by_kill(pid):
        return "absent"
    rc, text = _ps(["-o", "stat=", "-p", str(pid)])
    if rc != 0 or not text.strip():
        if not _exists_by_kill(pid):
            return "absent"
        raise ObservationError("cannot read state of pid %d" % pid)
    return "zombie" if text.strip().startswith("Z") else "alive"


def start_time(pid):
    """開始時刻。不在・ゾンビなら None。存在するのに読めなければ ObservationError。"""
    if pid_status(pid) != "alive":
        return None
    rc, text = _ps(["-o", "lstart=", "-p", str(pid)])
    if rc != 0 or not text.strip():
        if pid_status(pid) != "alive":
            return None
        raise ObservationError("cannot read start time of pid %d" % pid)
    return " ".join(text.split())


def uid_of(pid):
    rc, text = _ps(["-o", "uid=", "-p", str(pid)])
    if rc != 0 or not text.strip():
        if pid_status(pid) != "alive":
            return None
        raise ObservationError("cannot read uid of pid %d" % pid)
    try:
        return int(text.strip())
    except ValueError:
        raise ObservationError("unparseable uid for pid %d" % pid)


# --- 正確な argv（macOS: sysctl KERN_PROCARGS2） ---
_CTL_KERN, _KERN_ARGMAX, _KERN_PROCARGS2 = 1, 8, 49
_libc = None


def _sysctl_libc():
    global _libc
    if _libc is None:
        if sys.platform != "darwin":
            raise ObservationError("exact argv is only implemented for macOS")
        _libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
    return _libc


def argv(pid):
    """正確な argv（リスト）。不在・ゾンビなら None。読めなければ ObservationError。"""
    if pid_status(pid) != "alive":
        return None
    libc = _sysctl_libc()
    mib = (ctypes.c_int * 2)(_CTL_KERN, _KERN_ARGMAX)
    argmax = ctypes.c_int(0)
    size = ctypes.c_size_t(ctypes.sizeof(argmax))
    if libc.sysctl(mib, 2, ctypes.byref(argmax), ctypes.byref(size), None, 0) != 0:
        raise ObservationError("sysctl KERN_ARGMAX failed")
    buf = ctypes.create_string_buffer(argmax.value)
    size = ctypes.c_size_t(argmax.value)
    mib3 = (ctypes.c_int * 3)(_CTL_KERN, _KERN_PROCARGS2, pid)
    if libc.sysctl(mib3, 3, buf, ctypes.byref(size), None, 0) != 0:
        if pid_status(pid) != "alive":
            return None
        raise ObservationError("cannot read argv of pid %d (errno %d)" % (pid, ctypes.get_errno()))
    data = buf.raw[:size.value]
    if len(data) < 4:
        raise ObservationError("argv buffer too short")
    argc = int.from_bytes(data[:4], "little")
    rest = data[4:]
    pos = rest.find(b"\0")
    if pos < 0:
        raise ObservationError("argv buffer malformed")
    while pos < len(rest) and rest[pos] == 0:
        pos += 1
    args = []
    for _ in range(argc):
        end = rest.find(b"\0", pos)
        if end < 0:
            raise ObservationError("argv truncated")
        args.append(rest[pos:end].decode("utf-8", "surrogateescape"))
        pos = end + 1
    return args


def snapshot():
    """全プロセスの一覧（pid・ppid・pgid・uid・起動引数の文字列）。ゾンビは含めない。

    ps の失敗・解析できない行・空の一覧は ObservationError（空の一覧はあり得ない: 自分自身が居る）。
    """
    rc, text = _ps(["-axww", "-o", "pid=,ppid=,pgid=,uid=,stat=,command="])
    if rc != 0:
        raise ObservationError("ps exited with %d" % rc)
    rows = []
    for line in text.splitlines():
        if not line.strip():
            continue
        parts = line.split(None, 5)
        if len(parts) < 5:
            raise ObservationError("unparseable ps line")
        try:
            row = {"pid": int(parts[0]), "ppid": int(parts[1]), "pgid": int(parts[2]), "uid": int(parts[3]),
                   "stat": parts[4], "command": parts[5] if len(parts) > 5 else ""}
        except ValueError:
            raise ObservationError("unparseable ps line")
        if not row["stat"].startswith("Z"):
            rows.append(row)
    if not any(r["pid"] == os.getpid() for r in rows):
        raise ObservationError("partial process list (own process missing)")
    return rows


# --- 識別 ---
class RunIdentity:
    """1つのランのプロセスの識別子: session_id（正確なトークン）・settings の正規化パス・uid。"""

    def __init__(self, session_id, settings_path, uid):
        self.session_id = session_id
        self.settings_path = os.path.realpath(settings_path)
        self.uid = uid


def _flag_values(av, flag):
    """`--flag value` と `--flag=value` の両方の値（同じ識別子を別の書き方で渡されても見落とさない）。"""
    values = []
    for i, token in enumerate(av):
        if token == flag and i + 1 < len(av):
            values.append(av[i + 1])
        elif token.startswith(flag + "="):
            values.append(token[len(flag) + 1:])
    return values


def argv_matches(av, ident):
    sessions = _flag_values(av, "--session-id")
    settings = _flag_values(av, "--settings")
    return (sessions == [ident.session_id] and len(settings) == 1
            and os.path.realpath(settings[0]) == ident.settings_path)


def find_run_processes(ident):
    """識別子に正確に一致するプロセス [(pid, 開始時刻)]。観測できなければ ObservationError。

    ps の起動引数の文字列で候補を絞ってから（正確なトークンを持つなら必ず部分文字列として現れる）、
    候補ごとに sysctl の正確な argv で照合する。
    """
    me = os.getpid()
    found = []
    for row in snapshot():
        if row["pid"] == me or row["uid"] != ident.uid or ident.session_id not in row["command"]:
            continue
        av = argv(row["pid"])
        if av is None or not argv_matches(av, ident):
            continue
        st = start_time(row["pid"])
        if st is None:
            continue
        found.append((row["pid"], st))
    return found


def stub_matches(pid, expected_start, run_id, root, uid):
    """起動スタブの識別（pid・開始時刻・uid・`--run-id`・`--root` の正確なトークン）。"""
    if not expected_start or pid_status(pid) != "alive":
        return False
    if start_time(pid) != expected_start or uid_of(pid) != uid:
        return False
    av = argv(pid)
    if av is None:
        return False
    roots = _flag_values(av, "--root")
    return (_flag_values(av, "--run-id") == [run_id] and len(roots) == 1
            and os.path.realpath(roots[0]) == os.path.realpath(root))


def identity_ok(pid, expected_start):
    """pid が生存し、開始時刻が一致するときだけ True。開始時刻が無いものは False（検査を省略しない）。"""
    if not expected_start:
        return False
    if pid_status(pid) != "alive":
        return False
    return start_time(pid) == expected_start


def alive(pid):
    """生存しているか。観測できなければ ObservationError。"""
    return pid_status(pid) == "alive"


# --- 停止 ---
def _signal_verified(targets, sig):
    """signal の直前に開始時刻を再照合し、一致したものだけに送る（pid の再利用対策）。

    全員の照合を先に済ませてから、targets の順（呼び出し側が親＝起動スタブを先頭にする）で続けて送る。
    1件ずつ「照合→送信」にすると、照合（ps）の間に親が子の終了を先に記録してしまう。
    """
    verified = []
    for pid, st in list(targets.items()):
        current = start_time(pid)
        if current is None or current != st:
            targets.pop(pid, None)  # 不在、または pid が再利用された: 送らない
            continue
        verified.append(pid)
    for pid in verified:
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            targets.pop(pid, None)


def terminate(collect, grace, confirm):
    """collect() が返す {pid: 開始時刻} を、SIGTERM → 猶予 → SIGKILL → 不在確認。

    戻り値: {"absent": bool, "unknown": bool, ...}。観測できなければ unknown=True・absent=False。
    """
    details = {"term_targets": [], "kill_targets": [], "remaining": [], "unknown": False, "absent": False}
    try:
        targets = collect()
        details["term_targets"] = sorted(targets)
        if not targets:
            details["absent"] = True
            return details
        _signal_verified(dict(targets), signal.SIGTERM)
        deadline = time.monotonic() + grace
        while time.monotonic() < deadline:
            targets = collect()
            if not targets:
                details["absent"] = True
                return details
            time.sleep(0.05)
        targets = collect()
        details["kill_targets"] = sorted(targets)
        _signal_verified(dict(targets), signal.SIGKILL)
        deadline = time.monotonic() + confirm
        while time.monotonic() < deadline:
            targets = collect()
            if not targets:
                details["absent"] = True
                return details
            time.sleep(0.05)
        details["remaining"] = sorted(collect())
        details["absent"] = not details["remaining"]
        return details
    except ObservationError as exc:
        details["unknown"] = True
        details["absent"] = False
        details["error"] = str(exc)
        return details
