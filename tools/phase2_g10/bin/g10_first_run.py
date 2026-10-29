#!/usr/bin/env python3
"""実 Claude の監督付き初回起動の手順（TASK 17）。人が、明示の GO を得た段階ごとに1つずつ実行する。

  init      実行用のルートを作る（0700）。役割ごとの ECDSA 鍵を生成し、wiring.json（Issue #323 を認証なしの REST で
            読む・共有台帳つき）と、実 Claude CLI 用のポリシーを置き、人の鍵で設定を承認する。  ← 鍵の生成（要 GO）
  approve   Issue #323 を認証なしで読み、その本文だけに結び付いた CONFIRM と REAL_CLAUDE_GO（1回・期限つき）を
            人の鍵で記録する。                                                       ← 実 Claude 起動の承認（要 GO）
            同じ approval_id の GO が既にある・CLAIM 済みなら、何も記録せずに拒否する（TASK 24。新しい本文が要る）。
  run       （別の端末で S2 の見張り役 `bin/g10_watchdog.py --root ROOT --interval 60` を動かしてから）
            Issue #323 を取得し、その本文の GO の CLI で auth-check と同じ確認をして、ログインしていなければ
            CLAIM の前に止める（承認は消費しない）。ログインしていれば CLAIM し、受理してスタブを起動する（GO と一致すれば実 CLI を1回だけ起動）。
            終了を待ち、finalize して REPORT の下書きの場所を表示する。              ← 実 Claude の起動（要 GO）
  halt      緊急停止（ハードHALT）。実行中のランを止め、以後の起動も止める。
  install   （TASK 22）この開発 worktree から、固定の場所に不変の固定版（マニフェストのハッシュつき）を作る。
  plists    （TASK 21/22 固定版の中から実行）S2 と検知役の LaunchAgent の plist を作って検査するだけ（登録しない。登録・停止の手順を表示）。
  unhalt    （TASK 21）人の署名で HALT を解除する（--reason 必須）。実行中のラン・記録の食い違いがあれば解除しない。
  code-edit-policy  （TASK 26）今のポリシーに限定コード編集の節（--config の JSON）を加えた policy-v2 の候補と
            ダイジェストを表示する。--write のときだけ置き換える（実行中のランがあれば拒否）。  ← ポリシーの変更（要 GO）
  auth-check  （TASK 19）子と同じ環境で `<CLI> auth status --json` を1回だけ実行し、ログインの有無を表示する。
            モデルは呼ばない（課金なし）。メールアドレス等の生の出力は表示しない。--with-env NAME で、秘密を含まない
            決まった名前の環境変数（USER・LOGNAME・TMPDIR・SHELL・__CF_USER_TEXT_ENCODING）を診断のために加えられる。

- 秘密の値は表示しない。鍵はルートの keys/ に 0600。Issue への書き込み・GitHub の認証・launchd は使わない。
- 試験では --issue-source file と --cli（代役）で、ネットワークと実 Claude を使わずに通す。
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from g10runner import autorun, code_edit, ecdsa_signing as ec, launchd_plan, meta, norm, policy as policy_mod, real_claude, registry, release, signing, wiring  # noqa: E402
from g10runner.control import Control, GoReuseError  # noqa: E402
from g10runner.fsutil import sha256_hex  # noqa: E402
from g10runner.layout import Layout  # noqa: E402

# 初回の監督付き1回のためのポリシー（認証なしの REST の 60回/時×0.5 に収まる間隔・1時間に1回だけの起動）
FIRST_RUN_TIMING = {"issue_monitor_interval": 300.0}
FIRST_RUN_RATE_GUARD = {"window_seconds": 3600, "max_starts": 1}
WATCHDOG_INTERVAL = 600.0


def first_run_policy():
    p = json.loads(json.dumps(policy_mod.DEFAULT_POLICY))
    p["adapter"] = "claude_cli"
    p["timing"].update(FIRST_RUN_TIMING)
    p["rate_guard"] = dict(FIRST_RUN_RATE_GUARD)
    return p


def open_control(root):
    return autorun.open_control(root)


def cmd_init(a):
    root = os.path.realpath(a.root)
    if os.path.exists(root) and os.listdir(root):
        raise SystemExit("root is not empty: %s" % root)
    os.makedirs(root, 0o700, exist_ok=True)
    os.chmod(root, 0o700)
    layout = Layout(root).ensure()
    keys = os.path.join(root, "keys")
    os.makedirs(keys, 0o700)
    pub, priv = {}, {}
    for role in signing.ROLES:
        priv[role], pub[role] = ec.generate_keypair(keys, role)
    os.makedirs(os.path.join(root, "ledger"), 0o700)
    source = {"kind": a.issue_source}
    policy = Control.install_policy(layout, first_run_policy())
    mode, api = wiring.SOURCE_BUDGET[source["kind"]]
    limit = wiring.ledger_allowance(policy, WATCHDOG_INTERVAL, mode=mode, api=api)
    wiring.write(root, {"version": wiring.VERSION, "mode": "ecdsa", "public_keys": pub,
                        "private_keys": {"agent": priv["agent"], "witness": priv["witness"]},
                        "issue_source": source,
                        "ledger": {"path": os.path.join(root, "ledger", "github.json"), "limit_per_hour": limit,
                                   "reserve_fraction": 0.0, "watchdog_interval": WATCHDOG_INTERVAL}})
    control, _ = open_control(root)
    control.approve_wiring()
    print(json.dumps({"root": root, "keys": "generated (0600, not shown)", "issue_source": source["kind"],
                      "ledger_limit_per_hour": limit, "wiring_approved": True,
                      "policy_version": policy["version"], "phase2_policy_sha256": policy["_digest"]},
                     ensure_ascii=False))
    return 0


def fetch_body(control, policy):
    snap = control.witness.source.fetch(timeout=policy_mod.timing(policy, "issue_fetch_timeout"))
    return snap


def cmd_approve(a):
    control, policy = open_control(a.root)
    snap = fetch_body(control, policy)
    body = snap["body"]
    result = meta.validate_task(body, policy)
    if not result.ok:
        raise SystemExit("Issue #323 is not a runnable Phase 2 TASK: %s" % "; ".join(result.problems[:5]))
    task_sha = norm.compute_hash(body)
    approval_id = result.fields["phase2_approval_id"]
    cli = os.path.realpath(a.cli)
    go = {"go_id": "go-" + approval_id, "approval_id": approval_id, "task_sha256": task_sha,
          "body_sha256": sha256_hex(body.encode("utf-8")), "cli_realpath": cli, "cli_version": os.path.basename(cli),
          "home": os.path.expanduser("~"), "max_turns": a.max_turns, "source_repo": os.path.realpath(a.source_repo),
          "expires_at": time.time() + a.valid_minutes * 60, "max_runs": 1}
    reuse = control.go_reuse_problem(approval_id)
    if reuse:
        raise SystemExit("approve refused (nothing recorded): " + reuse)
    control.confirm(approval_id, task_sha)
    try:
        control.approve_real_claude_go(go)
    except GoReuseError as exc:
        raise SystemExit("approve refused (GO not recorded): %s" % exc)
    shown = dict(go, home="<HOME>")
    print(json.dumps({"confirmed": approval_id, "go": shown}, ensure_ascii=False, indent=1))
    return 0


def cmd_run(a):
    control, policy = open_control(a.root)
    snap = fetch_body(control, policy)
    go = autorun.usable_go(control, snap["body"], time.time())
    if go is None:
        raise SystemExit("no usable REAL_CLAUDE_GO for the current Issue body (nothing claimed)")
    if os.path.realpath(go["cli_realpath"]) != go["cli_realpath"]:
        raise SystemExit("CLI path changed after the GO (nothing claimed)")
    auth = real_claude.auth_status(go["cli_realpath"], go["home"])
    print(json.dumps({"auth_preflight": auth}, ensure_ascii=False))
    if auth["logged_in"] is not True:
        raise SystemExit("auth preflight failed: the CLI is not logged in in the child environment "
                         "(nothing claimed; the approval is still unused)")
    result = autorun.launch(control, policy, snap)
    if result["status"] in ("not_claimed", "not_accepted"):
        raise SystemExit("%s: %s" % (result["status"].replace("_", " "), result["reason"]))
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["status"] == "ended_checks_passed" else 1


def cmd_halt(a):
    """緊急停止（ハードHALT）。実行中のランを止め、新しい起動を止める（解除は人の UNHALT）。"""
    control, _ = open_control(a.root)
    result = control.halt("hard", a.reason)
    print(json.dumps({"halted": True, "resolved": result["resolved"], "problems": result["problems"]},
                     ensure_ascii=False))
    return 0 if result["resolved"] else 1


def cmd_unhalt(a):
    """人の署名で HALT を解除する（TASK 21）。実行中のラン・記録の食い違いがあれば解除しない。"""
    control, _ = open_control(a.root)
    rec, problems = control.unhalt(a.reason)
    print(json.dumps({"unhalted": rec is not None, "event_id": rec and rec["event_id"], "problems": problems},
                     ensure_ascii=False))
    return 0 if rec is not None else 1


DEFAULT_RELEASE_PARENT = os.path.expanduser("~/Library/Application Support/kabumori-agent-watch/phase2-release")
PACKAGE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


CODE_EDIT_POLICY_VERSION = "policy-v2"


def code_edit_policy(current, cfg):
    """今のポリシーに code_edit の節を加えた新しいポリシー（版は policy-v2）。形が正しくなければ PolicyError。"""
    new = {k: v for k, v in current.items() if not k.startswith("_")}
    new["version"] = CODE_EDIT_POLICY_VERSION
    new["code_edit"] = cfg
    return policy_mod.with_digest(new)


def cmd_code_edit_policy(a):
    """（TASK 26）限定コード編集を有効にするポリシーの候補を表示する（--write のときだけ置き換える）。"""
    layout = Layout(os.path.realpath(a.root))
    current = policy_mod.load(layout.policy_pub)
    with open(a.config, encoding="utf-8") as f:
        cfg = json.load(f)
    try:
        new = code_edit_policy(current, cfg)
    except policy_mod.PolicyError as exc:
        raise SystemExit("code edit policy refused: %s" % exc)
    out = {"current_version": current["version"], "current_policy_sha256": current["_digest"],
           "new_version": new["version"], "new_policy_sha256": new["_digest"], "code_edit": cfg, "written": False}
    if a.write:
        if registry.non_terminal(layout):
            raise SystemExit("a run is in progress; policy not changed")
        Control.install_policy(layout, new)
        if policy_mod.load_current(layout)["_digest"] != new["_digest"]:  # TASK 28: 正本と公開用の両方
            raise SystemExit("policy read-back differs")
        out["written"] = True
    print(json.dumps(out, ensure_ascii=False, indent=1))
    return 0


def cmd_install(a):
    """（TASK 22）この開発 worktree から固定版を作る（元に未コミットの変更があれば作らない）。登録はしない。"""
    dest, digest = release.install(PACKAGE, os.path.realpath(a.dest))
    print(json.dumps({"release_dir": dest, "release_digest": digest,
                      "next_not_run": "/usr/bin/python3 -I '%s' plists --root <ROOT> [--live]"
                                      % os.path.join(dest, "bin", "g10_first_run.py")}, ensure_ascii=False, indent=1))
    return 0


def cmd_plists(a):
    """（TASK 21/22）固定版の S2 と検知役の LaunchAgent の plist を作って検査する。登録はしない（人が GO の後に行う）。
    固定版の中の g10_first_run.py から実行したときだけ作る（開発 worktree からは作らない）。"""
    manifest = release.package_manifest(PACKAGE)
    if manifest is None:
        raise SystemExit("run plists from an installed release (bin/g10_first_run.py install first)")
    digest = manifest.get("digest", "")
    problems = release.verify(PACKAGE, digest)
    if problems:
        raise SystemExit("release verification failed: %s" % "; ".join(problems[:3]))
    root = os.path.realpath(a.root)
    out_dir = os.path.realpath(a.out or os.path.join(root, "launchd-plans"))
    os.makedirs(out_dir, 0o700, exist_ok=True)
    os.makedirs(os.path.join(root, "logs"), 0o700, exist_ok=True)
    shown = []
    for kind, interval, live in (("watchdog", 60.0, False), ("autorun", a.interval, a.live)):
        plan = launchd_plan.user_agent_plan(kind, "/usr/bin/python3", root, interval, digest, live=live,
                                            package_root=PACKAGE)
        path = os.path.join(out_dir, plan["Label"] + ".plist")
        with open(path, "wb") as f:
            f.write(launchd_plan.render_validated_agent(plan, PACKAGE))
        shown.append({"kind": kind, "path": path, "live": live, "lint_ok": launchd_plan.lint(path),
                      "commands_not_run": launchd_plan.agent_commands(plan["Label"], path)})
    print(json.dumps({"release_digest": digest, "plists": shown, "registered": False}, ensure_ascii=False, indent=1))
    return 0 if all(x["lint_ok"] for x in shown) else 1


def cmd_auth_check(a):
    missing = [n for n in a.with_env if n not in os.environ]
    if missing:
        raise SystemExit("not set in this environment: %s" % ", ".join(missing))
    extra = {n: os.environ[n] for n in a.with_env}
    result = real_claude.auth_status(os.path.realpath(a.cli), os.path.expanduser("~"), extra_env=extra)
    print(json.dumps({"cli": os.path.basename(os.path.realpath(a.cli)), "auth": result},
                     ensure_ascii=False))
    return 0 if result["logged_in"] is True else 1


def main(argv=None):
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    i = sub.add_parser("init")
    i.add_argument("--root", required=True)
    i.add_argument("--issue-source", choices=("github_rest_anonymous", "file"), default="github_rest_anonymous")
    g = sub.add_parser("approve")
    g.add_argument("--root", required=True)
    g.add_argument("--cli", required=True, help="Claude CLI の実体（版の名前のファイル）")
    g.add_argument("--source-repo", required=True)
    g.add_argument("--max-turns", type=int, default=10)
    g.add_argument("--valid-minutes", type=int, default=60)
    r = sub.add_parser("run")
    r.add_argument("--root", required=True)
    h = sub.add_parser("halt")
    h.add_argument("--root", required=True)
    h.add_argument("--reason", default="human emergency stop")
    u = sub.add_parser("unhalt")
    u.add_argument("--root", required=True)
    u.add_argument("--reason", required=True, help="解除の理由（人の署名とともに記録される）")
    ins = sub.add_parser("install")
    ins.add_argument("--dest", default=DEFAULT_RELEASE_PARENT, help="固定版を置く親フォルダ")
    pl = sub.add_parser("plists")
    pl.add_argument("--root", required=True)
    pl.add_argument("--out")
    pl.add_argument("--interval", type=float, default=300.0)
    pl.add_argument("--live", action="store_true", help="検知役の plist に --live を付ける（登録後、条件がそろえば起動する）")
    ce = sub.add_parser("code-edit-policy")
    ce.add_argument("--root", required=True)
    ce.add_argument("--config", required=True, help="code_edit の節の JSON ファイル")
    ce.add_argument("--write", action="store_true", help="表示した候補でポリシーを置き換える（要 GO）")
    c = sub.add_parser("auth-check")
    c.add_argument("--cli", required=True, help="Claude CLI の実体（版の名前のファイル）")
    c.add_argument("--with-env", action="append", default=[], choices=real_claude.DIAG_ENV_NAMES)
    a = p.parse_args(argv)
    return {"init": cmd_init, "approve": cmd_approve, "run": cmd_run, "halt": cmd_halt, "unhalt": cmd_unhalt,
            "install": cmd_install, "plists": cmd_plists, "auth-check": cmd_auth_check,
            "code-edit-policy": cmd_code_edit_policy}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
