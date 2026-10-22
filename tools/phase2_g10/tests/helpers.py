"""試験の共通部品。実Claude・ネットワーク・GitHub・macOSの設定には触れない。"""
import copy
import os
import shutil
import stat
import tempfile
import time
import unittest

from g10runner import norm, policy as policy_mod, procs, registry, signing, supervise
from g10runner.agent import Agent
from g10runner.control import Control
from g10runner.layout import Layout
from g10runner.notify import RecordingNotifier

TASK_TEMPLATE = """# G10-02｜Phase 2 読み取り専用の試験調査（readonly_trial）
- task_id: {task_id}
- slot: G10
- owner: claude
- status: ready
- next_owner: claude
- return_to: G10担当ちゃ（開発運用統括）
- completion_code: K10
- recommended_model: Claude Sonnet5（中）
- generation_limit: 50
- production_permission: NO_GO
- safety_gate: NO_GO for production, SNS, merge, deploy, GitHub write. readonly_trial only.
- automation_enabled: true
- automation_mode: local_cli
- automation_approval: approved
- phase2_run: approved
- phase2_approval_id: {approval_id}
- phase2_norm: NORM-1
- phase2_policy_version: {policy_version}
- phase2_policy_sha256: {policy_sha256}
- phase2_task_sha256: 0000000000000000000000000000000000000000000000000000000000000000
- base_ref: refs/heads/main
- base_sha: 0c42933ca5030ab31a56267529430d0473d9b155
- model: sonnet
- phase2_model_id: claude-sonnet-5-5
- effort: medium
- max_minutes: {max_minutes}
- max_budget_usd: 0.50
- phase2_scope: readonly_trial
- phase2_report_mode: local_only

## 目的
指定コミット（base_sha）のリポジトリを読み取り、PROJECT_RULES.md の固定Issue方式の記述と、.agent/ORCHESTRATION.md の記述の食い違いを、文章で報告する。実装・変更は行わない。

## preflight
- 関連PR: なし（読み取り専用の初回調査。基点HEADのみ: 上の base_ref と base_sha）
- 使う情報は、実行係が検証して渡すこのTASK本文と、作業フォルダ内の指定コミットのファイルだけ。
- 他slotの変更ファイル、DB/RPC/Auth/Edgeへの影響はない（読み取りのみ）。依存するTASKはない。
- 本文の記述と食い違いがあれば、推測せず、質問として返す。

## 実行
1. 作業フォルダの PROJECT_RULES.md と .agent/ORCHESTRATION.md を、Read／Glob／Grep だけで読む。
2. 固定Issue方式（1枠1現役Issue・本文は現在のTASKのみ・REPORT→HISTORY→ACCEPT→次TASK）に関する記述を比べ、食い違い・不足を、根拠のファイルパスと行付きで挙げる。
3. 結果を最終回答として文章で返す（ファイルは作らない）。

## 安全
読み取り専用。変更可能な範囲はなし。ファイルの作成・編集、コマンド実行、Web・GitHubへの書き込み、SNS実投稿、DB/Auth/Edge/外部APIのwriteは禁止。production_permissionはNO_GO。

## tests・完了条件
tests: なし（読み取り専用）。実行係が、作業フォルダに変更がないこと、実使用モデルが指定IDの1件であることを機械的に確認する。完了条件: ローカルREPORTの第2部に、GitHubへ投稿できる形のREPORT（type: REPORT を1件、task_id、next_task_allowed:false、tests、changed_files、PR/HEAD、remaining_issues、safety_checks、return_to、completion_code）が含まれること。GitHubへの投稿とread-backはG10担当ちゃが行う。本文の編集は禁止。
"""

FAST_TIMING = {
    "absolute_max_minutes": 120,
    "grace_seconds": 0.5,
    "confirm_seconds": 1.5,
    "reaper_interval": 0.1,
    "reaper_confirm_timeout": 5.0,
    "s2_heartbeat_max_age": 90.0,
    "s2_redundancy_loss_age": 120.0,
    "starting_timeout": 3.0,
    "deadline_slack": 0.5,
    "request_ttl": 120.0,
    "halt_sync_wait": 10.0,
    "halt_escalation": 10.0,
    "minute_seconds": 0.5,
}
TRUSTED_ISSUE = {"state": "OPEN", "number": 323, "author": "anohi-memories", "editor": None}


def test_policy(**overrides):
    p = copy.deepcopy(policy_mod.DEFAULT_POLICY)
    p["timing"] = dict(FAST_TIMING)
    p.update(overrides)
    return p


def make_body(policy, approval_id="g10-p2-test-0001", task_id="g10-phase2-test-20261022", max_minutes="10",
              fix_hash=True, mutate=None):
    body = TASK_TEMPLATE.format(task_id=task_id, approval_id=approval_id, policy_version=policy["version"],
                                policy_sha256=policy["_digest"], max_minutes=max_minutes)
    if mutate:
        body = mutate(body)
    if fix_hash:
        h = norm.compute_hash(body)
        body = body.replace("0" * 64, h, 1)
    return body


def make_writable(root):
    for dirpath, dirnames, filenames in os.walk(root):
        try:
            os.chmod(dirpath, stat.S_IRWXU)
        except OSError:
            pass
        for name in dirnames:
            try:
                os.chmod(os.path.join(dirpath, name), stat.S_IRWXU)
            except OSError:
                pass


def kill_leftovers(layout):
    """試験の後始末: このルートの登録簿にある識別子を持つプロセスを停止する。"""
    try:
        ids = registry.all_entries(layout)
    except OSError:
        return
    for run_id in ids:
        try:
            e = registry.load(layout, run_id)
        except Exception:
            continue
        if e:
            try:
                procs.terminate(supervise.collector(layout, e), 0.3, 1.0)
            except (procs.ObservationError, KeyError):
                pass
            for key in ("reaper_pid", "stub_pid"):
                pid = e.get(key)
                try:
                    ok = pid and procs.identity_ok(pid, e.get(key.replace("pid", "start")))
                except procs.ObservationError:
                    ok = False
                if ok:
                    try:
                        os.kill(pid, 9)
                    except OSError:
                        pass


class Env:
    """1つの試験用ルート（制御側と実行側を同じユーザーで模擬）。"""

    def __init__(self, policy=None, now=None, notifier=None):
        self.tmp = tempfile.mkdtemp(prefix="g10t-", dir="/tmp")
        self.layout = Layout(self.tmp).ensure()
        signing.write_test_keys(self.tmp)
        keys = signing.test_keys()
        self.verifier = signing.HmacTestVerifier(keys)
        self.control_signer = signing.HmacTestSigner({"runner": keys["runner"], "human": keys["human"]})
        self.agent_signer = signing.HmacTestSigner({"agent": keys["agent"]})
        self.policy = Control.install_policy(self.layout, policy or test_policy())
        self.clock = now
        nowfn = (lambda: self.clock()) if callable(now) else time.time
        self.notifier = notifier or RecordingNotifier()
        self.control = Control(self.layout, self.control_signer, self.verifier, self.policy, self.notifier, nowfn)
        self.agent = Agent(self.layout, self.agent_signer, self.verifier, self.policy, nowfn)

    def s2_heartbeat(self, fresh=True):
        supervise.write_s2_heartbeat(self.layout, now=time.time() if fresh else time.time() - 10000)

    def envelope(self, **overrides):
        params = {"scopes": ["readonly_trial"], "models": dict(self.policy["models"]),
                  "efforts": ["low", "medium", "high"], "max_minutes_cap": 120, "max_budget_cap": 0.50,
                  "base_ref_prefixes": ["refs/heads/", "refs/pull/"], "policy_sha256": self.policy["_digest"]}
        params.update(overrides)
        return self.control.approve_envelope(params)

    def cleanup(self):
        kill_leftovers(self.layout)
        make_writable(self.tmp)
        shutil.rmtree(self.tmp, ignore_errors=True)


class EnvTestCase(unittest.TestCase):
    policy_overrides = {}

    def setUp(self):
        self.env = Env(policy=test_policy(**self.policy_overrides))
        self.addCleanup(self.env.cleanup)

    def claim_and_run(self, scenario=None, hooks=None, body=None, wait=True, timeout=30, **body_kw):
        env = self.env
        body = body or make_body(env.policy, **body_kw)
        run_id, reason = env.control.try_claim(body, TRUSTED_ISSUE, time.time())
        self.assertIsNotNone(run_id, reason)
        if hooks is not None:
            os.makedirs(env.layout.run_dir(run_id), exist_ok=True)
            import json
            with open(os.path.join(env.layout.run_dir(run_id), "test_hooks.json"), "w") as f:
                json.dump(hooks, f)
        stub, reason = env.agent.handle_request_file(env.layout.request_file(run_id), scenario=scenario)
        self.assertIsNotNone(stub, reason)
        if wait:
            stub.wait(timeout=timeout)
            self.wait_terminal(run_id, timeout)
        return run_id, stub, body

    def wait_terminal(self, run_id, timeout=30):
        deadline = time.time() + timeout
        while time.time() < deadline:
            e = registry.load(self.env.layout, run_id)
            if e and e["state"] not in registry.NON_TERMINAL:
                return e
            time.sleep(0.05)
        self.fail("run did not reach a terminal state: %s" % run_id)
