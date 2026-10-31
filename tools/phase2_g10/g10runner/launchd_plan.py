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


def user_agent_plan(kind, python, root, interval, release_digest, live=False, package_root=PACKAGE_ROOT):
    """TASK 22: 固定版（package_root）のスクリプトを、そのマニフェストのハッシュ付きで動かす計画。"""
    if kind not in AGENT_SCRIPTS:
        raise PlanError("unknown agent kind")
    script = os.path.join(package_root, "bin", AGENT_SCRIPTS[kind])
    logs = os.path.join(root, "logs")
    args = [python, "-I", script, "--root", root, "--interval", str(float(interval)), "--release-digest", release_digest]
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


_SHAPE = "[python, -I, script, --root, ROOT, --interval, SECONDS, --release-digest, DIGEST(, --live)]"


def validate_agent_plan(plan, package_root=PACKAGE_ROOT):
    """LaunchAgent の計画の検査。規則に合わなければ PlanError。

    TASK 22: スクリプトは検証に合格した固定版（package_root）の中のものだけで、--release-digest がその版と一致すること。"""
    from . import release
    if not isinstance(plan, dict) or set(plan) != AGENT_KEYS:
        raise PlanError("agent plist keys must be exactly %s" % sorted(AGENT_KEYS))
    kind = next((k for k in AGENT_SCRIPTS if plan.get("Label") == "%s.agent.%s" % (LABEL_PREFIX, k)), None)
    if kind is None:
        raise PlanError("unexpected label")
    args = plan.get("ProgramArguments")
    live = isinstance(args, list) and len(args) == 10 and args[-1] == "--live"
    if not (isinstance(args, list) and all(isinstance(a, str) for a in args) and (len(args) == 9 or live)):
        raise PlanError("ProgramArguments must be " + _SHAPE)
    if live and kind != "autorun":
        raise PlanError("only the autorun agent may be live")
    if args[0] not in ALLOWED_PYTHONS or args[1] != "-I" or args[3] != "--root" or args[5] != "--interval" \
            or args[7] != "--release-digest":
        raise PlanError("ProgramArguments must be " + _SHAPE)
    if os.path.realpath(args[2]) != os.path.realpath(os.path.join(package_root, "bin", AGENT_SCRIPTS[kind])):
        raise PlanError("only the bundled %s may be run" % AGENT_SCRIPTS[kind])
    if release.package_manifest(package_root) is None:
        raise PlanError("plists must point at an installed release, not a development tree")
    problems = release.verify(package_root, args[8])
    if problems:
        raise PlanError("release does not verify: %s" % "; ".join(problems[:3]))
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


def render_validated_agent(plan, package_root=PACKAGE_ROOT):
    validate_agent_plan(plan, package_root)
    data = render(plan)
    if plistlib.loads(data) != plan:
        raise PlanError("rendered plist differs from the validated plan")
    return data


def agent_commands(label, path):
    """人が実行する登録・確認・停止の手順（文字列）。ここでは実行しない。sudo は要らない（主ユーザーの gui ドメイン）。"""
    return {"install": "launchctl bootstrap gui/$(id -u) '%s'" % path,
            "check": "launchctl print gui/$(id -u)/%s" % label,
            "stop": "launchctl bootout gui/$(id -u)/%s" % label}


# --- B0-2: 専用ユーザー _kaburun の常駐ジョブ実行（gui/503）の LaunchAgent（作って検査するだけ。登録しない） ---
# 常駐ドライバ bin/g10_jobrunner.py を _kaburun の GUI セッションで回す計画。_kaburun 自身のログインキーチェーンの
# トークンを使うので、主ユーザーの autorun（gui/$(id -u)）とは別に、_kaburun の gui ドメインに bootstrap する
# （登録は B2・人の GO の後、_kaburun のセッションで launchctl bootstrap gui/503）。
JOBRUNNER_SCRIPT = "g10_jobrunner.py"
JOBRUNNER_LABEL = "%s.agent.jobrunner" % LABEL_PREFIX
# ProgramArguments の形（実行先・実行のしかたを変えられないよう、完全一致で検査する）
_JOBRUNNER_SHAPE = ("[python, -I, g10_jobrunner.py, --root, ROOT, --in, IN, --claims, CLAIMS, --out, OUT, "
                    "--flags, FLAGS, --cli, CLI, --home, HOME, --interval, SECONDS, --release-digest, DIGEST]")
_JOBRUNNER_FLAGS = {3: "--root", 5: "--in", 7: "--claims", 9: "--out", 11: "--flags",
                    13: "--cli", 15: "--home", 17: "--interval", 19: "--release-digest"}
_JOBRUNNER_PATH_ARGS = (4, 6, 8, 10, 12, 14, 16)  # root/in/claims/out/flags/cli/home はすべて絶対パス


def job_runner_agent_plan(python, root, in_dir, claims, out_dir, flags, cli, home, interval, release_digest,
                          package_root=PACKAGE_ROOT):
    """固定版（package_root）の bin/g10_jobrunner.py を、そのマニフェストのハッシュ付きで _kaburun の gui で回す計画。
    handoff の向きは呼び出し側が固定したパスで渡す（in・flags=yuya 所有／out・claims=_kaburun 所有）。"""
    script = os.path.join(package_root, "bin", JOBRUNNER_SCRIPT)
    logs = os.path.join(root, "logs")
    args = [python, "-I", script, "--root", root, "--in", in_dir, "--claims", claims, "--out", out_dir,
            "--flags", flags, "--cli", cli, "--home", home, "--interval", str(float(interval)),
            "--release-digest", release_digest]
    return {
        "Label": JOBRUNNER_LABEL,
        "ProgramArguments": args,
        "KeepAlive": True,
        "RunAtLoad": True,
        "ProcessType": "Background",
        "Umask": 0o077,
        "EnvironmentVariables": {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
        "StandardOutPath": os.path.join(logs, "jobrunner.out"),
        "StandardErrorPath": os.path.join(logs, "jobrunner.err"),
    }


def validate_job_runner_plan(plan, package_root=PACKAGE_ROOT):
    """常駐ジョブ実行の LaunchAgent の計画の検査。固定版の bin/g10_jobrunner.py だけ・ハッシュ一致・全パス絶対・
    間隔は有限で 300 秒以上（--once を付けないので resident の下限と同じ）・環境は PATH/LANG だけ。合わなければ PlanError。"""
    from . import release
    if not isinstance(plan, dict) or set(plan) != AGENT_KEYS:
        raise PlanError("jobrunner plist keys must be exactly %s" % sorted(AGENT_KEYS))
    if plan.get("Label") != JOBRUNNER_LABEL:
        raise PlanError("unexpected label")
    args = plan.get("ProgramArguments")
    if not (isinstance(args, list) and len(args) == 21 and all(isinstance(a, str) for a in args)):
        raise PlanError("ProgramArguments must be " + _JOBRUNNER_SHAPE)
    if args[0] not in ALLOWED_PYTHONS or args[1] != "-I":
        raise PlanError("python must be one of %s run with -I" % (ALLOWED_PYTHONS,))
    for i, flag in _JOBRUNNER_FLAGS.items():
        if args[i] != flag:
            raise PlanError("ProgramArguments must be " + _JOBRUNNER_SHAPE)
    if os.path.realpath(args[2]) != os.path.realpath(os.path.join(package_root, "bin", JOBRUNNER_SCRIPT)):
        raise PlanError("only the bundled %s may be run" % JOBRUNNER_SCRIPT)
    if release.package_manifest(package_root) is None:
        raise PlanError("plists must point at an installed release, not a development tree")
    problems = release.verify(package_root, args[20])
    if problems:
        raise PlanError("release does not verify: %s" % "; ".join(problems[:3]))
    try:
        interval = float(args[18])
    except ValueError:
        raise PlanError("--interval must be a number")
    if not (math.isfinite(interval) and interval >= AGENT_MIN_LIVE_INTERVAL):
        raise PlanError("--interval must be a finite number >= %d" % AGENT_MIN_LIVE_INTERVAL)
    for i in _JOBRUNNER_PATH_ARGS:
        if not os.path.isabs(args[i]):
            raise PlanError("%s must be an absolute path" % _JOBRUNNER_FLAGS[i - 1])
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


def render_validated_job_runner(plan, package_root=PACKAGE_ROOT):
    validate_job_runner_plan(plan, package_root)
    data = render(plan)
    if plistlib.loads(data) != plan:
        raise PlanError("rendered plist differs from the validated plan")
    return data
