"""実 Claude CLI の監督付き1回起動（TASK 17）。既定では無効で、次の両方がそろったときだけ使える。

1. 署名済みのポリシーが adapter: "claude_cli"（runner の設定）
2. 人の署名の REAL_CLAUDE_GO（制御ログ）が、その要求の approval_id・task_sha256・本文の SHA-256 に一致し、期限内

GO には、人が確認して固定した CLI の実体（絶対パス）と版・HOME・最大ターン数・作業フォルダの元のローカル
リポジトリ・期限を書く。approval_id は CLAIM で1回しか使えないので、GO 1件で起動は最大1回。

- 起動の直前（共有ロックの中・SPAWNING の後）に claude_cli_plan.prelaunch_check で、起動待ちがちょうど1件・
  CLI の実体と版が GO どおり・計画が承認済みの値から作り直したものと完全に同じ・環境変数が許可リストだけ、を確かめる。
- プロンプトは標準入力から渡す（argv に入れない）。環境変数は PATH・LANG・HOME・USER だけ（API キー・BASE_URL 等は
  渡さない。USER は TASK 19 で、CLI が Keychain のログイン情報を見つけるのに要ると実測）。
- 道具は読み取りだけ（Read・Glob・Grep）。設定ファイルで書き込み・コマンド・Web を拒否し、MCP は読み込まない。
- 作業フォルダは、GO のローカルリポジトリからの共有クローン（ネットワークに触れない）を base_sha で detached に
  checkout し、読み取り専用にする。
- 停止・期限・HALT は偽Claude と同じスタブと S1/S2 の仕組みで行う（実 CLI の子プロセスの停止の実機確認は未了）。
- このモジュールは、上の条件を満たさない限り何も実行しない。実 CLI のフラグの受け付け・課金・modelUsage の形は
  実機で未確認（NOT_VERIFIED）。
- TASK 19: 初回の実機起動が「Not logged in」で終わった。原因は子に USER を渡していなかったこと（auth status で実測）。
  加えて、CLAIM（承認の消費）の前に、子と同じ環境で `<CLI> auth status --json`（モデルを呼ばない・課金なし）を1回
  実行し、ログインしていなければ起動しない（auth_status）。
"""
import json
import os
import re
import subprocess
import time

from . import claude_cli_plan as ccp
from .fsutil import is_finite_number, sha256_hex

GIT = "/usr/bin/git"
GO_FIELDS = {"go_id", "approval_id", "task_sha256", "body_sha256", "cli_realpath", "cli_version", "home",
             "max_turns", "source_repo", "expires_at", "max_runs"}
READ_TOOLS = ("Read", "Glob", "Grep")
DENIED_TOOLS = ("Bash", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Task")
_SHA = re.compile(r"[0-9a-f]{64}")
_VERSION = re.compile(r"\d+\.\d+\.\d+")
AUTH_ARGS = ("auth", "status", "--json")
AUTH_TIMEOUT = 30
# 診断のときだけ、人が名前を指定して加えられる環境変数（秘密を含まない名前に限る。値は表示しない）
DIAG_ENV_NAMES = ("USER", "LOGNAME", "TMPDIR", "SHELL", "__CF_USER_TEXT_ENCODING")
_WORD = re.compile(r"[A-Za-z0-9._-]{1,40}")


class RealClaudeError(ValueError):
    pass


def child_environment(home):
    """実 CLI の子に渡す環境（claude_cli_plan.child_env と同じ: PATH・LANG・HOME・USER）。"""
    return ccp.child_env(home)


def _word(value):
    return value if isinstance(value, str) and _WORD.fullmatch(value) else None


def auth_status(cli_realpath, home, extra_env=None, timeout=AUTH_TIMEOUT):
    """`<CLI> auth status --json` を子と同じ環境で1回実行し、ログインの有無だけを返す（TASK 19）。

    モデルは呼ばない（課金なし）。出力にはメールアドレス・組織名が含まれるので、生の出力は返さず保存もしない。
    返すのは loggedIn・authMethod・apiProvider・subscriptionType（短い語のときだけ）と終了コード・環境変数の名前。"""
    env = child_environment(home)
    for name, value in (extra_env or {}).items():
        if name not in DIAG_ENV_NAMES or not isinstance(value, str):
            raise RealClaudeError("environment name not allowed for the auth check: %s" % name)
        env[name] = value
    out = {"logged_in": None, "exit_code": None, "auth_method": None, "api_provider": None,
           "subscription_type": None, "problem": None, "env_names": sorted(env)}
    try:
        r = subprocess.run([cli_realpath] + list(AUTH_ARGS), env=env, cwd="/", stdin=subprocess.DEVNULL,
                           capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        out["problem"] = "timeout"
        return out
    except OSError as exc:
        out["problem"] = type(exc).__name__
        return out
    out["exit_code"] = r.returncode
    try:
        doc = json.loads(r.stdout.decode("utf-8", "replace"))
    except ValueError:
        doc = None
    if not isinstance(doc, dict) or not isinstance(doc.get("loggedIn"), bool):
        out["problem"] = "unparseable auth status output"
        return out
    out.update(logged_in=doc["loggedIn"], auth_method=_word(doc.get("authMethod")),
               api_provider=_word(doc.get("apiProvider")), subscription_type=_word(doc.get("subscriptionType")))
    return out


def go_problem(payload):
    """REAL_CLAUDE_GO の形の検査（state.derive が使う）。問題があれば理由、なければ None。"""
    if not isinstance(payload, dict) or set(payload) != GO_FIELDS:
        return "real claude GO fields invalid"
    p = payload
    if not all(isinstance(p[k], str) and p[k] for k in ("go_id", "approval_id")):
        return "real claude GO ids invalid"
    if not all(isinstance(p[k], str) and _SHA.fullmatch(p[k]) for k in ("task_sha256", "body_sha256")):
        return "real claude GO hashes invalid"
    if not all(isinstance(p[k], str) and os.path.isabs(p[k]) for k in ("cli_realpath", "home", "source_repo")):
        return "real claude GO paths must be absolute"
    if not (isinstance(p["cli_version"], str) and _VERSION.fullmatch(p["cli_version"])
            and os.path.basename(p["cli_realpath"]) == p["cli_version"]):
        return "real claude GO cli version invalid"
    if not (isinstance(p["max_turns"], int) and not isinstance(p["max_turns"], bool) and 0 < p["max_turns"] <= 50):
        return "real claude GO max_turns out of range"
    if p["max_runs"] != 1 or isinstance(p["max_runs"], bool):
        return "real claude GO allows exactly one run"
    if not (is_finite_number(p["expires_at"]) and p["expires_at"] > 0):
        return "real claude GO expiry invalid"
    return None


def find_go(st, req, now):
    """この要求に使える GO（期限内・approval_id・TASK のハッシュ・本文が一致）。無ければ None。"""
    body_sha = sha256_hex(req.get("prompt", "").encode("utf-8")) if isinstance(req.get("prompt"), str) else None
    for go in reversed(getattr(st, "real_gos", [])):
        if go["approval_id"] == req.get("approval_id") and go["task_sha256"] == req.get("task_sha256") \
                and go["body_sha256"] == body_sha and now < go["expires_at"]:
            return go
    return None


def probe_file(path):
    """固定したパスの CLI を、実行せずに調べる（claude_cli_plan.probe と同じ形）。"""
    real = os.path.realpath(path)
    base = os.path.basename(real)
    return {"found": os.path.isfile(real), "path": path, "realpath": real, "executable": os.access(real, os.X_OK),
            "version_from_path": base if _VERSION.fullmatch(base) else None, "executed": False}


class GitSourcePreparer:
    """作業フォルダ: ローカルリポジトリからの共有クローンを base_sha で detached checkout（ネットワークなし）。"""

    def __init__(self, source_repo):
        self.source_repo = source_repo

    def _git(self, args, cwd=None):
        env = {"PATH": "/usr/bin:/bin", "LANG": "C", "GIT_CONFIG_NOSYSTEM": "1", "GIT_TERMINAL_PROMPT": "0",
               "HOME": "/nonexistent", "GIT_ALLOW_PROTOCOL": "file"}
        r = subprocess.run([GIT, "-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never",
                            "-c", "protocol.file.allow=always"] + args,
                           cwd=cwd, env=env, capture_output=True, timeout=300)
        if r.returncode != 0:
            raise RealClaudeError("git %s failed" % args[0])
        return r.stdout.decode("utf-8", "replace").strip()

    def prepare(self, work_dir, base_ref, base_sha):
        if not re.fullmatch(r"[0-9a-f]{40}", str(base_sha)):
            raise RealClaudeError("base_sha must be a full commit id")
        if os.path.exists(work_dir):
            raise RealClaudeError("work dir already exists")
        self._git(["clone", "--quiet", "--no-checkout", "--shared", self.source_repo, work_dir])
        self._git(["checkout", "--quiet", "--detach", base_sha], cwd=work_dir)
        if self._git(["rev-parse", "HEAD"], cwd=work_dir) != base_sha:
            raise RealClaudeError("checked out commit differs from base_sha")


class RealClaudeAdapter:
    """実 Claude CLI のアダプタ（GO 1件につき1回）。get_adapter からだけ作る。"""
    name = "claude_cli"
    uses_stdin = True

    def __init__(self, go):
        self.go = go

    def settings_doc(self, run_id, policy, edit=None):
        if edit:  # TASK 26: 許可ファイルへの Edit だけを加える（Write・Bash・Web は拒否のまま）
            return {"permissions": {"allow": list(READ_TOOLS) + ccp.edit_rules(edit),
                                    "deny": [t for t in DENIED_TOOLS if t != "Edit"]}}
        return {"permissions": {"allow": list(READ_TOOLS), "deny": list(DENIED_TOOLS)}}

    def plan(self, request, prompt_path, settings_path, edit=None):
        return ccp.build_plan(self.go["cli_realpath"], request, prompt_path, settings_path, self.go["home"],
                              self.go["max_turns"], edit)

    def command(self, request, prompt_path, settings_path, edit=None):
        argv = self.plan(request, prompt_path, settings_path, edit)["argv"]
        if edit:  # TASK 26: カーネルの強制（sandbox-exec）で包む。子プロセスも同じ制限を受ける
            from .code_edit import wrap
            return wrap(edit["profile_path"], argv)
        return argv

    def environment(self, scenario_path, edit=None):
        env = child_environment(self.go["home"])
        if edit:
            env["TMPDIR"] = edit["tmp_dir"]
        return env

    def source_preparer(self):
        return GitSourcePreparer(self.go["source_repo"])

    def prelaunch(self, request, prompt_path, settings_path, used_states, now=None, edit=None):
        """起動の直前の再検証。理由か None。"""
        if (time.time() if now is None else now) >= self.go["expires_at"]:
            return "real claude GO expired"
        if edit and not (os.path.isfile(edit["profile_path"]) and os.access("/usr/bin/sandbox-exec", os.X_OK)):
            return "sandbox for the code edit is not available"
        plan = self.plan(request, prompt_path, settings_path, edit)
        pinned = {"realpath": self.go["cli_realpath"], "version": self.go["cli_version"]}
        return ccp.prelaunch_check(plan, request, prompt_path, settings_path, self.go["home"], pinned,
                                   list(used_states), lambda: probe_file(self.go["cli_realpath"]),
                                   self.go["max_turns"], edit)
