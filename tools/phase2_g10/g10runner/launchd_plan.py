"""監督付き自動起動の準備（TASK 13）: 専用 macOS ユーザーで動かす監督（S2 見張り役）の launchd の計画（dry-run のみ）。

- plist を「作って検査する」だけで、インストール・launchctl の実行・ユーザーや ACL の作成はしない（禁止）。
- 計画の規則（validate_plan）:
  - 実行ユーザーは専用ユーザー（名前が "_g10" で始まる）。主ユーザー（今のユーザー）・root は不可。
  - 実行するのは同梱の bin/g10_watchdog.py だけ。Python は絶対パス、`-I`（環境変数・ユーザーの site を無視）。
  - 環境変数は PATH と LANG だけ。token・key・secret・password を含む名前は不可。
  - KeepAlive（落ちたら再起動）、RunAtLoad、Umask 077（作るファイルは所有者だけが読める）。
  - ログはルートの下の logs/。パスはすべて絶対パス。
- TASK 14（H2 R2）: 実行先を変えられないよう、plist のキーは ALLOWED_KEYS の10個と**完全に一致**すること
  （Program・BundleProgram・WorkingDirectory・inetdCompatibility など、実行先や実行のしかたを変えるキーは不可）。
  Python は ALLOWED_PYTHONS（/usr/bin/python3）だけ。ProgramArguments は
  [python, "-I", 同梱の g10_watchdog.py, "--root", 絶対パス, "--interval", 有限の正の数] の7要素に完全に一致すること。
  plutil -lint は形式の検査で、意味（何が実行されるか）の検査は validate_plan が行う。render_validated は検査を通った計画だけを plist にする。
- 停止の方法（stop_commands）は、人が実行する手順の文字列として返すだけ（ここでは実行しない）。
- plutil -lint（読み取りだけの検査）で、plist の形式を確かめられる（lint）。
"""
import getpass
import math
import os
import plistlib
import re
import subprocess

LABEL_PREFIX = "com.kabumori.g10.phase2"
PACKAGE_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WATCHDOG = os.path.join(PACKAGE_ROOT, "bin", "g10_watchdog.py")
FORBIDDEN_ENV = re.compile(r"TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL|ANTHROPIC|AWS_|GH_|GITHUB_", re.I)
DEDICATED_USER = re.compile(r"_g10[a-z0-9_]{1,24}")
ALLOWED_PYTHONS = ("/usr/bin/python3",)
ALLOWED_KEYS = frozenset(("Label", "ProgramArguments", "UserName", "KeepAlive", "RunAtLoad", "ProcessType", "Umask",
                          "EnvironmentVariables", "StandardOutPath", "StandardErrorPath"))


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
    if not isinstance(plan, dict) or set(plan) != ALLOWED_KEYS:
        raise PlanError("plist keys must be exactly %s (no Program/BundleProgram or other keys)" % sorted(ALLOWED_KEYS))
    user = plan.get("UserName")
    if not isinstance(user, str) or not DEDICATED_USER.fullmatch(user):
        raise PlanError("the daemon must run as a dedicated _g10* user")
    if user in (current_user, "root"):
        raise PlanError("the daemon must not run as the main user or root")
    if not str(plan.get("Label", "")).startswith(LABEL_PREFIX + "."):
        raise PlanError("unexpected label")
    args = plan.get("ProgramArguments")
    if not (isinstance(args, list) and len(args) == 7 and all(isinstance(a, str) for a in args)):
        raise PlanError("ProgramArguments must be [python, -I, watchdog, --root, ROOT, --interval, SECONDS]")
    if args[0] not in ALLOWED_PYTHONS or args[1] != "-I":
        raise PlanError("python must be one of %s run with -I" % (ALLOWED_PYTHONS,))
    if args[3] != "--root" or args[5] != "--interval":
        raise PlanError("ProgramArguments must be [python, -I, watchdog, --root, ROOT, --interval, SECONDS]")
    try:
        interval = float(args[6])
    except ValueError:
        raise PlanError("--interval must be a number")
    if not (math.isfinite(interval) and interval > 0):
        raise PlanError("--interval must be a finite positive number")
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
    if not os.path.isabs(args[4]):
        raise PlanError("--root must be an absolute path")
    if plan.get("ProcessType") != "Background":
        raise PlanError("ProcessType must be Background")
    return True


def render(plan):
    return plistlib.dumps(plan, fmt=plistlib.FMT_XML, sort_keys=True)


def render_validated(plan, current_user=None):
    """検査（validate_plan）を通った計画だけを plist にする。検査したものと書き出すものが同じであることを保つ。"""
    validate_plan(plan, current_user)
    data = render(plan)
    if plistlib.loads(data) != plan:
        raise PlanError("rendered plist differs from the validated plan")
    return data


def lint(path):
    """plutil -lint（読み取りだけの検査）。形式が正しければ True。"""
    r = subprocess.run(["/usr/bin/plutil", "-lint", path], capture_output=True, env={"PATH": "/usr/bin:/bin"},
                       timeout=20)
    return r.returncode == 0


def stop_commands(label=LABEL_PREFIX + ".watchdog"):
    """人が実行する停止の手順（文字列）。ここでは実行しない。"""
    return ["sudo launchctl bootout system/%s" % label,
            "sudo launchctl print system/%s   # 止まったこと（見つからないこと）を確認" % label]


# --- TASK 21: 主ユーザーの LaunchAgent（gui ドメイン）の計画（作って検査するだけ。登録しない） ---
# Claude Max のログインは主ユーザーの Keychain にあるので、実 Claude を起動する検知役（autorun）は主ユーザーで動かす
# 必要がある（専用ユーザー _g10* では Max のログインを使えない）。そのため LaunchAgent（UserName なし）を計画する。
AGENT_KEYS = ALLOWED_KEYS - {"UserName"}
AGENT_SCRIPTS = {"watchdog": "g10_watchdog.py", "autorun": "g10_autorun.py"}
AGENT_MIN_LIVE_INTERVAL = 300.0


def user_agent_plan(kind, python, root, interval, live=False, package_root=PACKAGE_ROOT):
    if kind not in AGENT_SCRIPTS:
        raise PlanError("unknown agent kind")
    script = os.path.join(package_root, "bin", AGENT_SCRIPTS[kind])
    logs = os.path.join(root, "logs")
    args = [python, "-I", script, "--root", root, "--interval", str(float(interval))]
    if live:
        args.append("--live")
    return {
        "Label": "%s.agent.%s" % (LABEL_PREFIX, kind),
        "ProgramArguments": args,
        "KeepAlive": True,
        "RunAtLoad": True,
        "ProcessType": "Background",
        "Umask": 0o077,
        "EnvironmentVariables": {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
        "StandardOutPath": os.path.join(logs, kind + ".out"),
        "StandardErrorPath": os.path.join(logs, kind + ".err"),
    }


def validate_agent_plan(plan, package_root=PACKAGE_ROOT):
    """LaunchAgent の計画の検査。規則に合わなければ PlanError。"""
    if not isinstance(plan, dict) or set(plan) != AGENT_KEYS:
        raise PlanError("agent plist keys must be exactly %s" % sorted(AGENT_KEYS))
    kind = next((k for k in AGENT_SCRIPTS if plan.get("Label") == "%s.agent.%s" % (LABEL_PREFIX, k)), None)
    if kind is None:
        raise PlanError("unexpected label")
    args = plan.get("ProgramArguments")
    live = isinstance(args, list) and len(args) == 8 and args[-1] == "--live"
    if not (isinstance(args, list) and all(isinstance(a, str) for a in args) and (len(args) == 7 or live)):
        raise PlanError("ProgramArguments must be [python, -I, script, --root, ROOT, --interval, SECONDS(, --live)]")
    if live and kind != "autorun":
        raise PlanError("only the autorun agent may be live")
    if args[0] not in ALLOWED_PYTHONS or args[1] != "-I" or args[3] != "--root" or args[5] != "--interval":
        raise PlanError("ProgramArguments must be [python, -I, script, --root, ROOT, --interval, SECONDS(, --live)]")
    if os.path.realpath(args[2]) != os.path.realpath(os.path.join(package_root, "bin", AGENT_SCRIPTS[kind])):
        raise PlanError("only the bundled %s may be run" % AGENT_SCRIPTS[kind])
    try:
        interval = float(args[6])
    except ValueError:
        raise PlanError("--interval must be a number")
    if not (math.isfinite(interval) and interval > 0):
        raise PlanError("--interval must be a finite positive number")
    if live and interval < AGENT_MIN_LIVE_INTERVAL:
        raise PlanError("a live autorun needs --interval >= %d" % AGENT_MIN_LIVE_INTERVAL)
    if not os.path.isabs(args[4]):
        raise PlanError("--root must be an absolute path")
    env = plan.get("EnvironmentVariables", {})
    if set(env) - {"PATH", "LANG"} or any(FORBIDDEN_ENV.search(k) for k in env):
        raise PlanError("only PATH and LANG may be set in the environment")
    if plan.get("KeepAlive") is not True or plan.get("RunAtLoad") is not True:
        raise PlanError("KeepAlive and RunAtLoad must be true")
    if plan.get("Umask") != 0o077 or plan.get("ProcessType") != "Background":
        raise PlanError("Umask must be 077 and ProcessType Background")
    for key in ("StandardOutPath", "StandardErrorPath"):
        if not os.path.isabs(str(plan.get(key, ""))):
            raise PlanError("log paths must be absolute")
    return True


def render_validated_agent(plan):
    validate_agent_plan(plan)
    data = render(plan)
    if plistlib.loads(data) != plan:
        raise PlanError("rendered plist differs from the validated plan")
    return data


def agent_commands(label, path):
    """人が実行する登録・確認・停止の手順（文字列）。ここでは実行しない。sudo は要らない（主ユーザーの gui ドメイン）。"""
    return {"install": "launchctl bootstrap gui/$(id -u) '%s'" % path,
            "check": "launchctl print gui/$(id -u)/%s" % label,
            "stop": "launchctl bootout gui/$(id -u)/%s" % label}
