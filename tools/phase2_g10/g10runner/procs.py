"""プロセスの観測・識別・停止。仕様 v5 §7、v5.3 §5。H3 R2・R3、H4 P1（部分観測）・P2（signal直前）の修正。

- 観測は独立した2経路: カーネル（libproc の `proc_listallpids`・`proc_pidinfo`）と `/bin/ps`。
  どちらかが失敗・異常（timeout・OSError・非0終了・解析できない行・自分自身を欠く一覧）なら ObservationError。
  一覧は2経路の**和集合**を使い、片方の一覧に載っていないことを「不在」の根拠にしない（H4 P1）。
  さらに呼び出し側（supervise.collector）が、登録簿の pid を一覧とは独立に直接確認する。
- 生存・ゾンビ・uid・開始時刻はカーネルから読む（`os.kill(pid, 0)` と食い違えば ObservationError）。
  開始時刻はマイクロ秒単位（`秒.マイクロ秒`）。
- 識別は正確な argv のトークン（sysctl KERN_PROCARGS2）・uid・開始時刻（H3 R3）。
- signal は、各 pid に送る**直前**に、uid・開始時刻・完全な argv をもう一度照合し、一致したときだけ送る（H4 P2）。
  照合できない・一致しない（exec による argv の変化・pid の再利用・uid の変化）ものには送らない。
  照合と送信の間のごく短い時間は、pidfd 相当の原子的な手段が macOS に無いため残る（既知の限界）。
"""
import ctypes
import ctypes.util
import errno
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


# --- カーネルからの観測（macOS: libproc） ---
_PROC_PIDTBSDINFO, _PROC_PIDT_SHORTBSDINFO, _SZOMB = 3, 13, 5
_libproc_handle = None


class _ShortBsdInfo(ctypes.Structure):
    _fields_ = [("pid", ctypes.c_uint32), ("ppid", ctypes.c_uint32), ("pgid", ctypes.c_uint32),
                ("status", ctypes.c_uint32), ("comm", ctypes.c_char * 16), ("flags", ctypes.c_uint32),
                ("uid", ctypes.c_uint32), ("gid", ctypes.c_uint32), ("ruid", ctypes.c_uint32),
                ("rgid", ctypes.c_uint32), ("svuid", ctypes.c_uint32), ("svgid", ctypes.c_uint32),
                ("rfu", ctypes.c_uint32)]


class _BsdInfo(ctypes.Structure):
    _fields_ = [("flags", ctypes.c_uint32), ("status", ctypes.c_uint32), ("xstatus", ctypes.c_uint32),
                ("pid", ctypes.c_uint32), ("ppid", ctypes.c_uint32), ("uid", ctypes.c_uint32),
                ("gid", ctypes.c_uint32), ("ruid", ctypes.c_uint32), ("rgid", ctypes.c_uint32),
                ("svuid", ctypes.c_uint32), ("svgid", ctypes.c_uint32), ("rfu_1", ctypes.c_uint32),
                ("comm", ctypes.c_char * 16), ("name", ctypes.c_char * 32), ("nfiles", ctypes.c_uint32),
                ("pgid", ctypes.c_uint32), ("pjobc", ctypes.c_uint32), ("e_tdev", ctypes.c_uint32),
                ("e_tpgid", ctypes.c_uint32), ("nice", ctypes.c_int32), ("start_tvsec", ctypes.c_uint64),
                ("start_tvusec", ctypes.c_uint64)]


def _libproc():
    global _libproc_handle
    if _libproc_handle is None:
        if sys.platform != "darwin":
            raise ObservationError("kernel process observation is only implemented for macOS")
        try:
            _libproc_handle = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        except OSError as exc:
            raise ObservationError("libproc unavailable: %s" % exc)
    return _libproc_handle


def kernel_pids():
    """カーネルの全プロセスの pid。失敗・自分自身を欠く一覧は ObservationError。"""
    lib = _libproc()
    n = lib.proc_listallpids(None, 0)
    if n <= 0:
        raise ObservationError("proc_listallpids failed")
    buf = (ctypes.c_int * (n + 256))()
    m = lib.proc_listallpids(buf, ctypes.sizeof(buf))
    if m <= 0:
        raise ObservationError("proc_listallpids failed")
    pids = {p for p in buf[:m] if p > 0}
    if os.getpid() not in pids:
        raise ObservationError("partial kernel process list (own process missing)")
    return pids


def _exists_by_kill(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def kinfo(pid):
    """カーネルの短い情報 {pid, ppid, pgid, uid, zombie}。不在なら None。読めなければ ObservationError。

    終了処理の途中（libproc は「無し」、kill(0) は「有り」、p_stat はまだゾンビでない）の一瞬は、
    短く待って見直す。それでも食い違うなら ObservationError（不在とはみなさない）。
    """
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return None
    detail = None
    for attempt in range(50):
        info = _ShortBsdInfo()
        r = _libproc().proc_pidinfo(pid, _PROC_PIDT_SHORTBSDINFO, 0, ctypes.byref(info), ctypes.sizeof(info))
        if r == ctypes.sizeof(info):
            return {"pid": int(info.pid), "ppid": int(info.ppid), "pgid": int(info.pgid), "uid": int(info.uid),
                    "zombie": info.status == _SZOMB}
        err = ctypes.get_errno()
        if not _exists_by_kill(pid):
            return None
        # libproc は終了済み（ゾンビ）の情報を返さない。sysctl KERN_PROC_PID の p_stat で確かめる
        stat_ = _kern_proc_stat(pid)
        if stat_ == _SZOMB:
            return {"pid": pid, "ppid": None, "pgid": None, "uid": None, "zombie": True}
        if stat_ is None and not _exists_by_kill(pid):
            return None
        detail = "errno %d, p_stat %r" % (err, stat_)
        time.sleep(0.01)
    raise ObservationError("cannot read kernel info of pid %d (%s)" % (pid, detail))


_KERN_PROC, _KERN_PROC_PID, _KINFO_PROC_SIZE, _P_STAT_OFFSET, _P_PID_OFFSET = 14, 1, 648, 36, 40


def _kern_proc_stat(pid):
    """sysctl KERN_PROC_PID の p_stat（不在なら None）。読めなければ ObservationError。"""
    raw = _kern_proc(pid)
    return None if raw is None else raw[_P_STAT_OFFSET]


def _kern_proc(pid):
    """sysctl KERN_PROC_PID の kinfo_proc（不在なら None）。読めなければ ObservationError。"""
    libc = _sysctl_libc()
    mib = (ctypes.c_int * 4)(_CTL_KERN, _KERN_PROC, _KERN_PROC_PID, pid)
    buf = ctypes.create_string_buffer(_KINFO_PROC_SIZE)
    size = ctypes.c_size_t(_KINFO_PROC_SIZE)
    if libc.sysctl(mib, 4, buf, ctypes.byref(size), None, 0) != 0:
        raise ObservationError("sysctl KERN_PROC_PID failed for pid %d" % pid)
    if size.value == 0:
        return None
    raw = buf.raw[:size.value]
    if size.value != _KINFO_PROC_SIZE or int.from_bytes(raw[_P_PID_OFFSET:_P_PID_OFFSET + 4], "little") != pid:
        raise ObservationError("unexpected kinfo_proc for pid %d" % pid)
    return raw


def pid_status(pid):
    """'absent'／'alive'／'zombie'。観測できなければ ObservationError。"""
    info = kinfo(pid)
    if info is None:
        return "absent"
    return "zombie" if info["zombie"] else "alive"


def start_time(pid):
    """開始時刻（`秒.マイクロ秒`、カーネル）。不在・ゾンビなら None。存在するのに読めなければ ObservationError。

    sysctl KERN_PROC_PID の p_starttime を使う（別uidのプロセスでも読める: uid が変わった既知のプロセスと、
    pid が再利用された別のプロセスを区別するため。H3 C3 R1）。同じuidなら libproc の値とも照合し、
    食い違えば ObservationError。
    """
    info = kinfo(pid)
    if info is None or info["zombie"]:
        return None
    raw = _kern_proc(pid)
    if raw is None:
        if pid_status(pid) != "alive":
            return None
        raise ObservationError("cannot read start time of pid %d" % pid)
    st = "%d.%06d" % (int.from_bytes(raw[0:8], "little"), int.from_bytes(raw[8:12], "little"))
    if info["uid"] == os.getuid():
        b = _BsdInfo()
        r = _libproc().proc_pidinfo(pid, _PROC_PIDTBSDINFO, 0, ctypes.byref(b), ctypes.sizeof(b))
        if r == ctypes.sizeof(b) and "%d.%06d" % (b.start_tvsec, b.start_tvusec) != st:
            raise ObservationError("start time sources disagree for pid %d" % pid)
        if r != ctypes.sizeof(b) and pid_status(pid) == "alive":
            raise ObservationError("cannot read start time of pid %d" % pid)
    return st


def uid_of(pid):
    info = kinfo(pid)
    return None if info is None else info["uid"]


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
    for attempt in range(5):  # 起動・exec の途中の一瞬は読めないことがある: 短く再試行してから unknown
        size = ctypes.c_size_t(argmax.value)
        if libc.sysctl(mib3, 3, buf, ctypes.byref(size), None, 0) == 0:
            break
        err = ctypes.get_errno()
        if pid_status(pid) != "alive":
            return None
        time.sleep(0.02)
    else:
        raise ObservationError("cannot read argv of pid %d (errno %d)" % (pid, err))
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


def all_pids():
    """カーネルと ps の和集合（ゾンビ・不在を除く）。どちらかの経路が観測できなければ ObservationError。"""
    pids = kernel_pids() | {row["pid"] for row in snapshot()}
    alive_pids = set()
    for pid in pids:
        if pid_status(pid) == "alive":
            alive_pids.add(pid)
    return alive_pids


def run_process_matches(pid, ident):
    """pid が識別子に正確に一致するか（uid・argv）。不在なら False。観測できなければ ObservationError。"""
    info = kinfo(pid)
    if info is None or info["zombie"] or info["uid"] != ident.uid:
        return False
    av = argv(pid)
    return av is not None and argv_matches(av, ident)


def find_run_processes(ident):
    """識別子に正確に一致するプロセス [(pid, 開始時刻)]。観測できなければ ObservationError。

    ps の起動引数の文字列は信用せず、和集合のすべての同uidのプロセスを sysctl の正確な argv で照合する。
    """
    me = os.getpid()
    found = []
    for pid in sorted(all_pids()):
        if pid == me or not run_process_matches(pid, ident):
            continue
        st = start_time(pid)
        if st is None:
            continue
        found.append((pid, st))
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
def _signal_verified(targets, sig, verify, details):
    """各 pid に送る直前に verify(pid, 開始時刻)（uid・開始時刻・完全な argv）で照合し、一致したときだけ送る。

    targets の順（呼び出し側が親＝起動スタブを先頭にする）で、1件ずつ「照合→送信」する
    （照合はカーネルと sysctl だけで、外部コマンドを使わないので、照合と送信の間は短い）。
    照合できない（ObservationError）ものには送らず、unknown とする。一致しないものは skipped に記録する。
    """
    for pid, st in list(targets.items()):
        try:
            ok = verify(pid, st)
        except ObservationError as exc:
            details["unknown"] = True
            details.setdefault("verify_errors", []).append("%d: %s" % (pid, exc))
            continue
        if not ok:
            details.setdefault("skipped", []).append(pid)  # exec・pid 再利用・uid 変化の疑い: 送らない
            continue
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            pass


def terminate(collect, grace, confirm):
    """collect() が返す {pid: 開始時刻} を、SIGTERM → 猶予 → SIGKILL → 不在確認。

    collect.verify(pid, 開始時刻) が必須（signal 直前の再照合）。無ければ何も送らず unknown。
    戻り値: {"absent": bool, "unknown": bool, ...}。観測できなければ unknown=True・absent=False。
    """
    details = {"term_targets": [], "kill_targets": [], "remaining": [], "unknown": False, "absent": False,
               "identity_drift": []}
    verify = getattr(collect, "verify", None)
    if verify is None:
        details["unknown"] = True
        details["error"] = "no signal-time verifier"
        return details
    drift = getattr(collect, "drift", None)

    def gone(targets):
        """対象が空で、かつ識別の変わった既知のプロセス（identity_drift）も無いときだけ「居ない」。"""
        if targets:
            return False
        details["identity_drift"] = drift() if drift else []
        return not details["identity_drift"]

    try:
        targets = collect()
        details["term_targets"] = list(targets)
        if gone(targets):
            details["absent"] = not details["unknown"]
            return details
        _signal_verified(dict(targets), signal.SIGTERM, verify, details)
        deadline = time.monotonic() + grace
        while time.monotonic() < deadline:
            targets = collect()
            if gone(targets):
                details["absent"] = not details["unknown"]
                return details
            time.sleep(0.05)
        targets = collect()
        details["kill_targets"] = list(targets)
        _signal_verified(dict(targets), signal.SIGKILL, verify, details)
        deadline = time.monotonic() + confirm
        while time.monotonic() < deadline:
            targets = collect()
            if gone(targets):
                details["absent"] = not details["unknown"]
                return details
            time.sleep(0.05)
        details["remaining"] = sorted(collect())
        details["absent"] = gone(details["remaining"]) and not details["unknown"]
        return details
    except ObservationError as exc:
        details["unknown"] = True
        details["absent"] = False
        details["error"] = str(exc)
        return details
