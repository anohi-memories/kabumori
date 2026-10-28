#!/usr/bin/env python3
"""実 Claude の監督付き初回起動の手順（TASK 17）。人が、明示の GO を得た段階ごとに1つずつ実行する。

  init      実行用のルートを作る（0700）。役割ごとの ECDSA 鍵を生成し、wiring.json（Issue #323 を認証なしの REST で
            読む・共有台帳つき）と、実 Claude CLI 用のポリシーを置き、人の鍵で設定を承認する。  ← 鍵の生成（要 GO）
  approve   Issue #323 を認証なしで読み、その本文だけに結び付いた CONFIRM と REAL_CLAUDE_GO（1回・期限つき）を
            人の鍵で記録する。                                                       ← 実 Claude 起動の承認（要 GO）
  run       （別の端末で S2 の見張り役 `bin/g10_watchdog.py --root ROOT --interval 60` を動かしてから）
            Issue #323 を取得し、その本文の GO の CLI で auth-check と同じ確認をして、ログインしていなければ
            CLAIM の前に止める（承認は消費しない）。ログインしていれば CLAIM し、受理してスタブを起動する（GO と一致すれば実 CLI を1回だけ起動）。
            終了を待ち、finalize して REPORT の下書きの場所を表示する。              ← 実 Claude の起動（要 GO）
  halt      緊急停止（ハードHALT）。実行中のランを止め、以後の起動も止める。
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

from g10runner import ecdsa_signing as ec, meta, norm, policy as policy_mod, real_claude, registry, signing, wiring  # noqa: E402
from g10runner.agent import Agent  # noqa: E402
from g10runner.control import Control  # noqa: E402
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


def control_side(root):
    keys = os.path.join(root, "keys")
    cfg = wiring.load(root)
    signer = ec.EcdsaSigner({"runner": os.path.join(keys, "runner.key"), "human": os.path.join(keys, "human.key")})
    return Layout(root), signer, wiring.verifier(root, cfg), cfg


def open_control(root):
    layout, signer, verifier, cfg = control_side(root)
    policy = policy_mod.load(layout.policy_pub)
    return Control(layout, signer, verifier, policy, witness=wiring.witness(root, cfg, policy)), policy


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
    control.confirm(approval_id, task_sha)
    control.approve_real_claude_go(go)
    shown = dict(go, home="<HOME>")
    print(json.dumps({"confirmed": approval_id, "go": shown}, ensure_ascii=False, indent=1))
    return 0


def usable_go(control, body, now):
    """この本文の SHA-256 に結び付いた、期限内の REAL_CLAUDE_GO（無ければ None）。"""
    body_sha = sha256_hex(body.encode("utf-8"))
    for go in reversed(control.read_state().real_gos):
        if go["body_sha256"] == body_sha and now < go["expires_at"]:
            return go
    return None


def cmd_run(a):
    control, policy = open_control(a.root)
    snap = fetch_body(control, policy)
    go = usable_go(control, snap["body"], time.time())
    if go is None:
        raise SystemExit("no usable REAL_CLAUDE_GO for the current Issue body (nothing claimed)")
    if os.path.realpath(go["cli_realpath"]) != go["cli_realpath"]:
        raise SystemExit("CLI path changed after the GO (nothing claimed)")
    auth = real_claude.auth_status(go["cli_realpath"], go["home"])
    print(json.dumps({"auth_preflight": auth}, ensure_ascii=False))
    if auth["logged_in"] is not True:
        raise SystemExit("auth preflight failed: the CLI is not logged in in the child environment "
                         "(nothing claimed; the approval is still unused)")
    meta_ = {"state": snap["state"], "number": snap["number"], "author": snap["author"], "editor": None}
    run_id, reason = control.try_claim(snap["body"], meta_, time.time())
    if run_id is None:
        raise SystemExit("not claimed: %s" % reason)
    signer, verifier = wiring.agent_side(control.layout.root)
    agent = Agent(control.layout, signer, verifier, policy)
    stub, reason = agent.handle_request_file(control.layout.request_file(run_id))
    if stub is None:
        raise SystemExit("not accepted: %s" % reason)
    print(json.dumps({"run_id": run_id, "stub_pid": stub.pid, "note": "waiting for the run to end"}))
    stub.wait()
    deadline = time.time() + 600
    while time.time() < deadline:
        e = registry.load(control.layout, run_id)
        if e and e["state"] not in registry.NON_TERMINAL:
            break
        time.sleep(1)
    status, end = control.finalize(run_id, current_body=snap["body"])
    print(json.dumps({"run_id": run_id, "status": status, "used_states": agent.used_state(run_id),
                      "report": os.path.join(control.layout.reports, run_id + ".md")}, ensure_ascii=False))
    return 0 if status == "ended_checks_passed" else 1


def cmd_halt(a):
    """緊急停止（ハードHALT）。実行中のランを止め、新しい起動を止める（解除は人の UNHALT）。"""
    control, _ = open_control(a.root)
    result = control.halt("hard", a.reason)
    print(json.dumps({"halted": True, "resolved": result["resolved"], "problems": result["problems"]},
                     ensure_ascii=False))
    return 0 if result["resolved"] else 1


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
    c = sub.add_parser("auth-check")
    c.add_argument("--cli", required=True, help="Claude CLI の実体（版の名前のファイル）")
    c.add_argument("--with-env", action="append", default=[], choices=real_claude.DIAG_ENV_NAMES)
    a = p.parse_args(argv)
    return {"init": cmd_init, "approve": cmd_approve, "run": cmd_run, "halt": cmd_halt,
            "auth-check": cmd_auth_check}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
