"""置き場所。仕様 v5.3 §1-2 の制御（priv・pub）と実行（agent-out・work）の区分。

実運用では制御側と実行側が別ユーザーで、場所も分かれる（未実装：macOS別UIDはモック）。
試験では1つの一時フォルダの下に、同じ区分で作る。
"""
import os
import re

from .fsutil import touch

RUN_ID_RE = re.compile(r"^run-[0-9a-f]{16}$")


class LayoutError(ValueError):
    pass


def _contained(base, name):
    """base の直下の name だけを許す（絶対パス・..・区切り文字・シンボリックリンクでの逸脱を拒否）。H3 R1。"""
    if not isinstance(name, str) or not RUN_ID_RE.match(name):
        raise LayoutError("invalid run id")
    path = os.path.join(base, name)
    real_base = os.path.realpath(base)
    if os.path.dirname(os.path.realpath(path)) != real_base:
        raise LayoutError("path escapes its base directory")
    return path


class Layout:
    def __init__(self, root):
        self.root = os.path.abspath(root)
        self.priv = os.path.join(self.root, "control", "priv")
        self.pub = os.path.join(self.root, "pub")
        self.agent_out = os.path.join(self.root, "agent-out")
        self.work = os.path.join(self.root, "work")
        self.requests = os.path.join(self.pub, "requests")
        self.proc = os.path.join(self.agent_out, "proc")
        self.runs = os.path.join(self.agent_out, "runs")
        self.reports = os.path.join(self.priv, "reports")
        # 制御側
        self.ledger = os.path.join(self.priv, "ledger.jsonl")
        self.policy_priv = os.path.join(self.priv, "policy.json")
        self.needs_attention = os.path.join(self.priv, "NEEDS_ATTENTION.jsonl")
        self.control_events = os.path.join(self.pub, "control_events.log")
        self.halt_flag = os.path.join(self.pub, "HALT")
        self.stop_flag = os.path.join(self.pub, "STOP")
        self.halt_lock = os.path.join(self.pub, "halt.lock")
        self.policy_pub = os.path.join(self.pub, "policy.json")
        # 実行側
        self.agent_events = os.path.join(self.agent_out, "agent_events.log")
        self.used_requests = os.path.join(self.agent_out, "used_requests.log")
        self.control_seen = os.path.join(self.agent_out, "control_seen.json")
        self.s2_heartbeat = os.path.join(self.agent_out, "s2_heartbeat.json")
        self.supervisor_log = os.path.join(self.agent_out, "supervisor.log")
        self.agent_halt_flag = os.path.join(self.agent_out, "HALT_AGENT")

    def ensure(self):
        for d in (self.priv, self.pub, self.agent_out, self.work, self.requests, self.proc,
                  self.runs, self.reports):
            os.makedirs(d, exist_ok=True)
        touch(self.halt_lock)
        return self

    def run_dir(self, run_id):
        return _contained(self.runs, run_id)

    def work_dir(self, run_id):
        return _contained(self.work, run_id)

    def proc_file(self, run_id):
        return _contained(self.proc, run_id) + ".json"

    def request_file(self, run_id):
        return _contained(self.requests, run_id) + ".json"
