"""限定コード編集モード（TASK 26）。phase2_scope: limited_code_edit のときだけ使う。既定のポリシーでは無効。

境界は3重:
1. 承認: 編集してよいファイル（phase2_edit_paths）・最大変更行数（phase2_edit_max_lines）・テスト（phase2_test_id）は
   TASK 本文の正式項目で、本文の NORM-1 ハッシュ（人の CONFIRM と REAL_CLAUDE_GO が束縛）に含まれる。値の上限と
   テストのコマンドは署名済みポリシーの code_edit 節が決める（本文ではコマンドを書けない）。ENVELOPE では起動しない。
2. 実行中: CLI を sandbox-exec（カーネルの強制）で包み、書き込めるのは許可ファイル・ランの一時フォルダ・CLI 自身の
   状態（~/.claude 等。ただし設定・フック・記憶は拒否）だけにする。子プロセスも同じ制限を受ける。作業フォルダは
   許可ファイル以外を読み取り専用にする。CLI の道具は Read・Glob・Grep と許可ファイルへの Edit だけ（Write・Bash・Web は拒否）。
   TASK 28: 実 CLI の Edit は、同じフォルダに `<許可ファイル>.tmp.<pid>.<16進12文字>` を O_CREAT|O_EXCL|O_NOFOLLOW で
   作って書き、許可ファイルへ rename する（CLI 2.1.305 の本体で確認、第27TASKの実機では作成が EPERM）。この名前の形の
   普通のファイルだけを許し（リンク・フォルダ・FIFO 等は種類で拒否）、許可ファイルの親フォルダだけを書き込み可にする。
3. 実行後: 作業フォルダ全体の一覧（種類・権限・中身・リンク先・リンク数）を実行前と照合する。新規・削除・リンク・
   許可外の変更・行数の超過は安全違反（HALT）。テストは実行係が、ネットワークと書き込みを拒否したサンドボックスで実行する。

作業フォルダはランごとの使い捨てのクローンで、変更はリポジトリ・GitHub に一切戻さない（差分はローカル REPORT に載せるだけ）。
"""
import difflib
import os
import re
import signal
import stat
import subprocess
import time

from . import procs
from .fsutil import atomic_write_json, canonical, loads_strict, read_json, sha256_hex

SCOPE = "limited_code_edit"
KEYS = ("phase2_edit_paths", "phase2_edit_max_lines", "phase2_test_id")
SANDBOX_EXEC = "/usr/bin/sandbox-exec"
# 各部分は英数字・_ で始まる（`..`・`.git`・隠しファイル・絶対パス・空白・カンマ・ワイルドカードは書けない）
PATH_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]*(/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$")
TEST_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,40}$")
MAX_LINES_RE = re.compile(r"^[1-9][0-9]{0,3}$")
SAFE_ABS = re.compile(r"^/[A-Za-z0-9/._ -]+$")
TEST_OUTPUT_TAIL = 4000
# CLI の状態のうち、書けると後の対話セッションに影響するもの（実行中は拒否）
HOME_DENY_LITERALS = (".claude/settings.json", ".claude/settings.local.json", ".claude/CLAUDE.md",
                      ".claude/keybindings.json")
HOME_DENY_SUBPATHS = (".claude/hooks", ".claude/agents", ".claude/commands", ".claude/skills", ".claude/plugins",
                      ".claude/rules", ".claude/output-styles")
# TASK 30: ~/.claude.json は CLI 自身が書くので許すが、後のセッションの動作を変える項目（MCP・許可・フック・環境・信頼）は
# 実行の前後で指紋を比べ、変わっていれば安全違反にする（このランの作業フォルダの項目は CLI が作るので除く）
SENSITIVE_KEY = re.compile(r"mcp|allow|permission|hook|trust|env|command|apikey|plugin|helper|statusline", re.I)
POSTRUN_STOP_SECONDS = 5.0
# TASK 28: Edit の一時ファイルの名前の後半（`.tmp.<pid>.<randomBytes(6) の16進>`）。sandbox の正規表現は {n} の回数指定を
# 黙って無視して何にも一致しなくなる（実機で確認）ので、16進1文字を12回並べて書く
TEMP_SUFFIX_RX = r"\.tmp\.[0-9]+\." + "[0-9a-f]" * 12 + "$"
# 一時ファイルの名前でも作らせない種類（普通のファイルだけを許す）
NON_FILE_TYPES = ("SYMLINK", "DIRECTORY", "FIFO", "SOCKET", "CHARACTER-DEVICE", "BLOCK-DEVICE")


class CodeEditError(ValueError):
    pass


def policy_problems(cfg):
    """ポリシーの code_edit 節の形の検査。問題の一覧（空＝正しい）。"""
    if not isinstance(cfg, dict):
        return ["code_edit must be an object"]
    problems = []
    prefixes = cfg.get("allowed_path_prefixes")
    if not (isinstance(prefixes, list) and prefixes and all(
            isinstance(p, str) and p.endswith("/") and PATH_RE.match(p[:-1]) for p in prefixes)):
        problems.append("code_edit.allowed_path_prefixes invalid")
    for key, hi in (("max_files", 10), ("max_changed_lines", 1000)):
        v = cfg.get(key)
        if not (isinstance(v, int) and not isinstance(v, bool) and 1 <= v <= hi):
            problems.append("code_edit.%s invalid" % key)
    tests = cfg.get("tests")
    if not (isinstance(tests, dict) and tests):
        problems.append("code_edit.tests invalid")
    else:
        for tid, t in tests.items():
            argv = t.get("argv") if isinstance(t, dict) else None
            timeout = t.get("timeout_seconds") if isinstance(t, dict) else None
            if not (TEST_ID_RE.match(tid) and isinstance(argv, list) and argv
                    and all(isinstance(a, str) and a for a in argv) and os.path.isabs(argv[0])
                    and isinstance(timeout, (int, float)) and not isinstance(timeout, bool) and 0 < timeout <= 600):
                problems.append("code_edit.tests entry invalid: %s" % tid)
    return problems


def spec_from_fields(fields, policy):
    """承認済み本文の正式項目から編集の範囲を作る。(問題の一覧, spec または None)。"""
    cfg = policy.get("code_edit")
    if cfg is None:
        return ["policy has no code_edit section (limited_code_edit is not enabled)"], None
    problems = policy_problems(cfg)
    if problems:
        return problems, None
    for key in KEYS:
        if key not in fields:
            problems.append("missing key: " + key)
    if problems:
        return problems, None
    paths = [p.strip() for p in fields["phase2_edit_paths"].split(",")]
    if not paths or any(not p for p in paths):
        problems.append("bad value: phase2_edit_paths (empty entry)")
    elif len(set(paths)) != len(paths):
        problems.append("bad value: phase2_edit_paths (duplicate)")
    elif len(paths) > cfg["max_files"]:
        problems.append("bad value: phase2_edit_paths (more than %d files)" % cfg["max_files"])
    else:
        for p in paths:
            if not PATH_RE.match(p):
                problems.append("bad value: phase2_edit_paths (%s)" % p)
            elif not any(p.startswith(prefix) for prefix in cfg["allowed_path_prefixes"]):
                problems.append("bad value: phase2_edit_paths (outside the policy prefixes: %s)" % p)
    ml = fields["phase2_edit_max_lines"]
    if not MAX_LINES_RE.match(ml) or int(ml) > cfg["max_changed_lines"]:
        problems.append("bad value: phase2_edit_max_lines")
    tid = fields["phase2_test_id"]
    if tid not in cfg["tests"]:
        problems.append("bad value: phase2_test_id")
    if problems:
        return problems, None
    return [], {"paths": sorted(paths), "max_lines": int(ml), "test_id": tid, "test": dict(cfg["tests"][tid])}


# --- 作業フォルダの一覧と照合 ---

def _read_regular(path, st):
    """TASK 30（B）: リンクも FIFO も辿らず（O_NOFOLLOW|O_NONBLOCK）開き、lstat と同じ普通のファイル（dev・ino）か確かめて
    から、その fd から1回だけ読む。差し替えられていれば None。"""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        return None
    try:
        fst = os.fstat(fd)
        if not stat.S_ISREG(fst.st_mode) or (fst.st_dev, fst.st_ino) != (st.st_dev, st.st_ino):
            return None
        chunks = []
        while True:
            b = os.read(fd, 1 << 20)
            if not b:
                break
            chunks.append(b)
        return b"".join(chunks)
    finally:
        os.close(fd)


def manifest(root, contents=None):
    """作業フォルダの全項目（リンクは辿らない）: 相対パス → [種類, 権限, 中身の SHA-256 またはリンク先, リンク数]。
    contents（相対パス → None の dict）を渡すと、その項目の中身（ハッシュに使ったのと同じバイト列）を入れて返す。
    読む途中で差し替えられた項目は種類 "x"（実行前の一覧と必ず違う）。"""
    items = {}
    for dirpath, dirnames, filenames in os.walk(root):
        for name in sorted(dirnames + filenames):
            p = os.path.join(dirpath, name)
            st = os.lstat(p)
            rel = os.path.relpath(p, root)
            if stat.S_ISLNK(st.st_mode):
                items[rel] = ["l", 0, os.readlink(p), st.st_nlink]
            elif stat.S_ISDIR(st.st_mode):
                items[rel] = ["d", st.st_mode & 0o7777, "", 0]
            elif stat.S_ISREG(st.st_mode):
                data = _read_regular(p, st)
                if data is None:
                    items[rel] = ["x", 0, "changed while reading", 0]
                    continue
                items[rel] = ["f", st.st_mode & 0o7777, sha256_hex(data), st.st_nlink]
                if contents is not None and rel in contents:
                    contents[rel] = data
            else:
                items[rel] = ["o", st.st_mode & 0o7777, "", st.st_nlink]
    st = os.lstat(root)
    items["."] = ["d", st.st_mode & 0o7777, "", 0]
    return items


def manifest_digest(m):
    return sha256_hex(canonical(sorted(m.items())))


def prepare(work_dir, run_dir, spec, home):
    """読み取り専用にした作業フォルダで、許可ファイルだけを書き込み可にし、実行前の一覧・元の中身・サンドボックスの
    設定を run_dir に書く（run_dir は CLI から書けない）。問題があれば CodeEditError。"""
    real = os.path.realpath(work_dir)
    base = {}
    for rel in spec["paths"]:
        p = os.path.join(real, rel)
        if os.path.realpath(p) != p:
            raise CodeEditError("allowed path goes through a symlink: " + rel)
        try:
            st = os.lstat(p)
        except FileNotFoundError:
            raise CodeEditError("allowed path does not exist at base_sha: " + rel)
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
            raise CodeEditError("allowed path is not a plain file: " + rel)
        with open(p, "rb") as f:
            data = f.read()
        try:
            base[rel] = data.decode("utf-8")
        except UnicodeDecodeError:
            raise CodeEditError("allowed path is not UTF-8 text: " + rel)
        os.chmod(p, (st.st_mode & 0o111) | 0o644)
    pre = manifest(real)  # TASK 30: 親フォルダを開く前の状態（実行後は seal で戻してから照合する）
    atomic_write_json(os.path.join(run_dir, "edit_base.json"), base)
    atomic_write_json(os.path.join(run_dir, "edit_manifest_pre.json"), pre)
    parents = {}
    for parent in sorted({os.path.dirname(os.path.join(real, rel)) for rel in spec["paths"]}):
        # TASK 28: Edit の一時ファイルの作成と rename に要る。何を作れるかはサンドボックスが名前と種類で決める
        mode = stat.S_IMODE(os.lstat(parent).st_mode)
        parents[os.path.relpath(parent, real)] = mode
        os.chmod(parent, mode | stat.S_IWUSR)
    atomic_write_json(os.path.join(run_dir, "edit_parents.json"), parents)
    tmp = os.path.join(run_dir, "cli-tmp")
    os.makedirs(tmp, exist_ok=True)
    profile = cli_profile([os.path.join(real, rel) for rel in spec["paths"]], os.path.realpath(tmp),
                          os.path.realpath(home))  # カーネルは実体のパスで照合する（/var → /private/var 等）
    profile_path = os.path.join(run_dir, "cli.sb")
    with open(profile_path, "w", encoding="utf-8") as f:
        f.write(profile)
    os.chmod(profile_path, 0o444)
    return {"work_dir": real, "abs_paths": [os.path.join(real, rel) for rel in spec["paths"]],
            "profile_path": profile_path, "tmp_dir": os.path.realpath(tmp)}


def _changed_lines(old, new, rel):
    diff = list(difflib.unified_diff(old.splitlines(True), new.splitlines(True), "a/" + rel, "b/" + rel))
    n = sum(1 for line in diff if (line.startswith("+") or line.startswith("-"))
            and not line.startswith("+++") and not line.startswith("---"))
    return n, "".join(line if line.endswith("\n") else line + "\n\\ No newline at end of file\n" for line in diff)


def verify(work_dir, run_dir, spec):
    """実行前の一覧と照合する。{"violations", "changed_lines", "diff", "manifest_sha256"}。"""
    real = os.path.realpath(work_dir)
    pre = read_json(os.path.join(run_dir, "edit_manifest_pre.json"))
    base = read_json(os.path.join(run_dir, "edit_base.json"))
    if not isinstance(pre, dict) or not isinstance(base, dict) or sorted(base) != spec["paths"]:
        return {"violations": ["edit baseline missing or inconsistent"], "changed_lines": 0, "diff": "",
                "manifest_sha256": None}
    contents = {rel: None for rel in spec["paths"]}
    post = manifest(real, contents)
    violations = []
    postrun = read_json(os.path.join(run_dir, "edit_postrun.json"))  # TASK 30: 残りのプロセスの停止と封印の記録
    if not isinstance(postrun, dict) or postrun.get("stopped") is not True or postrun.get("sealed") is not True:
        violations.append("processes left after the CLI exited were not confirmed stopped, or the folders not sealed")
    home_pre = read_json(os.path.join(run_dir, "home_guard_pre.json"))
    if not isinstance(home_pre, dict) or not isinstance(postrun, dict) or postrun.get("home_guard") != home_pre:
        violations.append("~/.claude.json settings that affect later sessions changed during the run (or unverifiable)")
    created = sorted(set(post) - set(pre))
    deleted = sorted(set(pre) - set(post))
    if created:
        violations.append("created outside the approval: " + ", ".join(created[:10]))
    if deleted:
        violations.append("deleted: " + ", ".join(deleted[:10]))
    allowed = set(spec["paths"])
    outside = sorted(p for p in set(pre) & set(post) if p not in allowed and post[p] != pre[p])
    if outside:
        violations.append("changed outside the allowed paths: " + ", ".join(outside[:10]))
    total = 0
    diffs = []
    for rel in spec["paths"]:
        a, b = pre.get(rel), post.get(rel)
        if b is None:
            continue
        if b[0] != "f" or b[1] != a[1] or b[3] != 1 or contents.get(rel) is None:
            violations.append("allowed path changed type, mode or links: " + rel)
            continue
        data = contents[rel]  # TASK 30: ハッシュと同じ1回の読み取り（差分を別に読み直さない）
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            violations.append("allowed path is no longer UTF-8 text: " + rel)
            continue
        n, d = _changed_lines(base[rel], text, rel)
        total += n
        diffs.append(d)
    if total > spec["max_lines"]:
        violations.append("changed lines %d exceed the approved %d" % (total, spec["max_lines"]))
    return {"violations": violations, "changed_lines": total, "diff": "".join(diffs),
            "manifest_sha256": manifest_digest(post)}


# --- 実行後（TASK 30・第29TASKの独立レビュー B）---

def home_guard(home, work_dir):
    """~/.claude.json のうち、後のセッションの動作を変える項目（SENSITIVE_KEY に合う最上位と各プロジェクトの項目）の指紋。
    このランの作業フォルダの項目（CLI が新しく作る）は除く。無い・読めない場合も、その旨を指紋にする（前後で比べる）。"""
    path = os.path.join(home, ".claude.json")
    for _ in range(5):  # 他のセッションが書いている途中なら少し待って読み直す
        try:
            with open(path, "rb") as f:
                doc = loads_strict(f.read().decode("utf-8"))
            break
        except FileNotFoundError:
            return {"state": "missing"}
        except (OSError, ValueError, UnicodeDecodeError):
            time.sleep(0.2)
    else:
        return {"state": "unreadable"}
    if not isinstance(doc, dict):
        return {"state": "not an object"}
    work = os.path.realpath(work_dir)
    picked = {k: v for k, v in doc.items() if SENSITIVE_KEY.search(k)}
    projects = doc.get("projects") if isinstance(doc.get("projects"), dict) else {}
    picked_projects = {}
    for key, entry in projects.items():
        if not isinstance(entry, dict) or os.path.realpath(key) == work or key.startswith(work + "/"):
            continue
        sub = {k: v for k, v in entry.items() if SENSITIVE_KEY.search(k)}
        if sub:
            picked_projects[key] = sub
    return {"state": "ok", "sha256": sha256_hex(canonical({"top": picked, "projects": picked_projects}))}


def stop_leftovers(own_pid=None, seconds=POSTRUN_STOP_SECONDS):
    """CLI の終了後、スタブと同じプロセスグループに残った子孫を SIGKILL し、いなくなったことを確かめる。
    スタブはセッションの先頭（agent が start_new_session で起動）なので、グループの残りは CLI の子孫だけ。
    {"stopped": bool, "killed": [pid...], "error"?}。観測できなければ stopped=False（照合で安全違反になる）。"""
    own = os.getpid() if own_pid is None else own_pid
    pgid, uid = os.getpgid(own), os.getuid()
    if pgid != own:  # グループの先頭でなければ、グループには CLI と無関係のプロセスがいる。何も止めない（照合で安全違反）
        return {"stopped": False, "killed": [], "error": "not the process group leader"}

    def members():
        found = []
        for pid in procs.kernel_pids():
            if pid == own:
                continue
            info = procs.kinfo(pid)
            if info and not info["zombie"] and info["pgid"] == pgid and info["uid"] == uid:
                found.append(pid)
        return sorted(found)

    killed = []
    try:
        deadline = time.time() + seconds
        while True:
            left = members()
            if not left:
                return {"stopped": True, "killed": killed}
            if time.time() > deadline:
                return {"stopped": False, "killed": killed, "remaining": left}
            for pid in left:
                try:
                    os.kill(pid, signal.SIGKILL)
                    killed.append(pid)
                except ProcessLookupError:
                    pass
            time.sleep(0.1)
    except (procs.ObservationError, OSError) as exc:
        return {"stopped": False, "killed": killed, "error": type(exc).__name__}


def seal(work_dir, run_dir):
    """許可ファイルの親フォルダを、prepare の前の権限に戻す（以後どのプロセスも、その中で作成・削除・改名できない）。"""
    real = os.path.realpath(work_dir)
    parents = read_json(os.path.join(run_dir, "edit_parents.json"))
    if not isinstance(parents, dict):
        return False
    try:
        for rel, mode in parents.items():
            p = os.path.join(real, rel)
            if os.path.realpath(p) != p or not isinstance(mode, int):
                return False
            os.chmod(p, mode)
    except OSError:
        return False
    return True


def finish_cli(work_dir, run_dir, home):
    """CLI の終了直後（照合の前）に実行係が行う: 残りのプロセスの停止 → 封印 → ~/.claude.json の指紋。記録して返す。"""
    stop = stop_leftovers()
    record = dict(stop, sealed=seal(work_dir, run_dir), home_guard=home_guard(home, work_dir))
    atomic_write_json(os.path.join(run_dir, "edit_postrun.json"), record)
    return record


# --- サンドボックス（sandbox-exec の設定）---

def _lit(path):
    if not SAFE_ABS.match(path) or '"' in path or "\\" in path:
        raise CodeEditError("path cannot be used in a sandbox profile: %r" % path)
    return '"%s"' % path


def _rx_prefix(path):
    _lit(path)
    return '#"^%s"' % re.sub(r"([.+*?()\[\]{}|^$])", r"\\\1", path)


def cli_profile(allowed_abs, tmp_dir, home):
    """CLI 用: 書き込みは許可ファイル・tmp_dir・/dev・CLI 自身の状態（~/.claude 以下・~/.claude.json*・キャッシュ）だけ。
    ~/.claude の設定・フック・道具の定義・記憶は拒否（後の規則が優先）。ネットワークは CLI の API 通信に要るので拒否しない
    （Web の道具と Bash は CLI の設定で拒否）。

    TASK 30（第29TASKの独立レビュー A）: パスの拒否は、親フォルダの改名・置き換えで抜けられた（`.claudeX` に設定を作り
    `.claude` と入れ替える等）。許可は境界のある subpath と `.claude.json*` の名前だけにし、`~/.claude`・`~/.claude/projects`
    のフォルダそのものへの書き込み（改名・削除・作成）と、既存のプロジェクトのフォルダの改名・削除を拒否する。`memory` という
    名前は ~/.claude の下のどこにも作らせない（作ったフォルダを projects/<x> へ改名して記憶を仕込む道を塞ぐ）。"""
    home = home.rstrip("/")
    claude = home + "/.claude"
    allow = ["(literal %s)" % _lit(p) for p in allowed_abs]
    allow += ["(subpath %s)" % _lit(tmp_dir), '(subpath "/dev")', "(subpath %s)" % _lit(claude),
              "(regex %s)" % (_rx_prefix(home + "/.claude.json")[:-1] + '(\\.[^/]+)?$"'),
              "(subpath %s)" % _lit(home + "/Library/Caches/claude-cli-nodejs")]
    deny = ["(literal %s)" % _lit(home + "/" + rel) for rel in HOME_DENY_LITERALS]
    deny += ["(subpath %s)" % _lit(home + "/" + rel) for rel in HOME_DENY_SUBPATHS]
    deny.append("(regex %s)" % (_rx_prefix(claude + "/")[:-1] + '(.*/)?memory(/|$)"'))
    deny += ["(literal %s)" % _lit(claude), "(literal %s)" % _lit(claude + "/projects")]
    projects = "(regex %s)" % (_rx_prefix(claude + "/projects/")[:-1] + '[^/]+$"')
    temps = [_rx_prefix(p)[:-1] + TEMP_SUFFIX_RX + '"' for p in allowed_abs]
    allow += ["(regex %s)" % t for t in temps]
    # TASK 30（B）: 許可ファイルの名前の位置にも、普通のファイル以外を作らせない（消してリンク・FIFO に置き換える道）
    names = ["(regex %s)" % t for t in temps] + ["(literal %s)" % _lit(p) for p in allowed_abs]
    kinds = ["(require-all %s (vnode-type %s))" % (n, k) for n in names for k in NON_FILE_TYPES]
    lines = ["(version 1)", "(allow default)", '(deny file-write* (subpath "/"))',
             "(allow file-write*\n  " + "\n  ".join(allow) + ")",
             "(deny file-write*\n  " + "\n  ".join(deny) + ")",
             "(deny file-write-unlink\n  " + projects + ")"]
    if kinds:
        lines.append("(deny file-write-create\n  " + "\n  ".join(kinds) + ")")
    return "\n".join(lines + [""])


# /usr/bin/python3 等の xcrun の入口が書くキャッシュ（書けないと警告を出すだけだが、出力を汚さないよう許す）
XCRUN_CACHE = r'(regex #"^/private/var/folders/[^/]+/[^/]+/T/xcrun_db")'


def test_profile(tmp_dir):
    """テスト用: ネットワークを拒否し、書き込みは tmp_dir・/dev・xcrun のキャッシュだけ（作業フォルダも書けない）。"""
    return "\n".join(["(version 1)", "(allow default)", "(deny network*)", '(deny file-write* (subpath "/"))',
                      "(allow file-write* (subpath %s) (subpath \"/dev\") %s)" % (_lit(tmp_dir), XCRUN_CACHE), ""])


def wrap(profile_path, argv):
    return [SANDBOX_EXEC, "-f", profile_path] + list(argv)


def run_test(spec, work_dir, run_dir):
    """承認されたテストを、実行係が作業フォルダで実行する（ネットワークなし・書き込みは一時フォルダだけ・時間の上限）。
    実行の前後で作業フォルダが同じことも確かめる。結果を test_result.json に書いて返す。"""
    real = os.path.realpath(work_dir)
    tmp = os.path.realpath(os.path.join(run_dir, "test-tmp"))
    os.makedirs(tmp, exist_ok=True)
    profile_path = os.path.join(run_dir, "test.sb")
    with open(profile_path, "w", encoding="utf-8") as f:
        f.write(test_profile(tmp))
    before = manifest_digest(manifest(real))
    env = {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": tmp, "TMPDIR": tmp, "PYTHONDONTWRITEBYTECODE": "1"}
    started = time.time()
    proc = subprocess.Popen(wrap(profile_path, spec["test"]["argv"]), cwd=real, env=env, stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True, close_fds=True)
    timed_out = False
    try:
        out, _ = proc.communicate(timeout=float(spec["test"]["timeout_seconds"]))
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except OSError:
            pass
        out, _ = proc.communicate()
    after = manifest_digest(manifest(real))
    result = {"test_id": spec["test_id"], "argv": spec["test"]["argv"], "exit_code": proc.returncode,
              "timed_out": timed_out, "seconds": round(time.time() - started, 3),
              "output_tail": out.decode("utf-8", "replace")[-TEST_OUTPUT_TAIL:],
              "tree_unchanged": before == after, "manifest_sha256": after}
    atomic_write_json(os.path.join(run_dir, "test_result.json"), result)
    return result


def tests_passed(result, manifest_sha256):
    return (isinstance(result, dict) and result.get("exit_code") == 0 and result.get("timed_out") is False
            and result.get("tree_unchanged") is True and manifest_sha256 is not None
            and result.get("manifest_sha256") == manifest_sha256)
