"""監督付き自動起動の準備（TASK 13）: 専用 macOS ユーザーで動かす監督（S2 見張り役）の launchd の計画（dry-run のみ）。

- plist を「作って検査する」だけで、インストール・launchctl の実行・ユーザーや ACL の作成はしない（禁止）。
- 計画の規則（validate_plan）:
  - 実行ユーザーは専用ユーザー（名前が "_g10" で始まる）。主ユーザー（今のユーザー）・root は不可。
  - 実行するのは同梱の bin/g10_watchdog.py だけ。Python は絶対パス、`-I`（環境変数・ユーザーの site を無視）。
  - 環境変数は PATH と LANG だけ。token・key・secret・password を含む名前は不可。
  - KeepAlive（落ちたら再起動）、RunAtLoad、Umask 077（作るファイルは所有者だけが読める）。
  - ログはルートの下の logs/。パスはすべて絶対パス。
- 停止の方法（stop_commands）は、人が実行する手順の文字列として返すだけ（ここでは実行しない）。
- plutil -lint（読み取りだけの検査）で、plist の形式を確かめられる（lint）。
"""
import getpass
import os
import plistlib
import re
import subprocess

LABEL_PREFIX = "com.kabumori.g10.phase2"
PACKAGE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WATCHDOG = os.path.join(PACKAGE_ROOT, "bin", "g10_watchdog.py")
FORBIDDEN_ENV = re.compile(r"TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|ANTHROPIC|AWS_|GH_|GITHUB_", re.I)
DEDICATED_USER = re.compile(r"_g10[a-z0-9_]{1,24}")


class PlanError(ValueError):
    pass


def watchdog_daemon_plan(python, root, user, interval=30.0, package_root=PACKAGE_ROOT):
    script = os.path.join(package_root, "bin", "g10_watchdog.py")
    logs = os.path.join(root, "logs")
    return {
        "Label": LABEL_PREFIX + ".watchdog",
        "ProgramArguments": [python, "-I", script, "--root", root, "--interval", str(float(interval))],
        "UserName": user,
        "KeepAlive": True,
        "RunAtLoad": True,
        "ProcessType": "Background",
        "Umask": 0o077,
        "EnvironmentVariables": {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
        "StandardOutPath": os.path.join(logs, "watchdog.out"),
        "StandardErrorPath": os.path.join(logs, "watchdog.err"),
    }


def validate_plan(plan, current_user=None, package_root=PACKAGE_ROOT):
    """規則に合わなければ PlanError。"""
    current_user = current_user or getpass.getuser()
    user = plan.get("UserName")
    if not isinstance(user, str) or not DEDICATED_USER.fullmatch(user):
        raise PlanError("the daemon must run as a dedicated _g10* user")
    if user in (current_user, "root"):
        raise PlanError("the daemon must not run as the main user or root")
    if not str(plan.get("Label", "")).startswith(LABEL_PREFIX + "."):
        raise PlanError("unexpected label")
    args = plan.get("ProgramArguments")
    if not (isinstance(args, list) and len(args) >= 3 and all(isinstance(a, str) for a in args)):
        raise PlanError("ProgramArguments malformed")
    if not os.path.isabs(args[0]) or args[1] != "-I":
        raise PlanError("python must be an absolute path run with -I")
    if os.path.realpath(args[2]) != os.path.realpath(os.path.join(package_root, "bin", "g10_watchdog.py")):
        raise PlanError("only the bundled g10_watchdog.py may be run")
    env = plan.get("EnvironmentVariables", {})
    if set(env) - {"PATH", "LANG"} or any(FORBIDDEN_ENV.search(k) for k in env):
        raise PlanError("only PATH and LANG may be set in the environment")
    if plan.get("KeepAlive") is not True or plan.get("RunAtLoad") is not True:
        raise PlanError("KeepAlive and RunAtLoad must be true")
    if plan.get("Umask") != 0o077:
        raise PlanError("Umask must be 077")
    for key in ("StandardOutPath", "StandardErrorPath"):
        if not os.path.isabs(str(plan.get(key, ""))):
            raise PlanError("log paths must be absolute")
    if "--root" not in args or not os.path.isabs(args[args.index("--root") + 1]):
        raise PlanError("--root must be an absolute path")
    return True


def render(plan):
    return plistlib.dumps(plan, fmt=plistlib.FMT_XML, sort_keys=True)


def lint(path):
    """plutil -lint（読み取りだけの検査）。形式が正しければ True。"""
    r = subprocess.run(["/usr/bin/plutil", "-lint", path], capture_output=True, env={"PATH": "/usr/bin:/bin"},
                       timeout=20)
    return r.returncode == 0


def stop_commands(label=LABEL_PREFIX + ".watchdog"):
    """人が実行する停止の手順（文字列）。ここでは実行しない。"""
    return ["sudo launchctl bootout system/%s" % label,
            "sudo launchctl print system/%s   # 止まったこと（見つからないこと）を確認" % label]
