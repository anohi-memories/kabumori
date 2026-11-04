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


class SplitLayout(Layout):
    """専用ユーザー方式（B0-3）の分割レイアウト: 制御の公開状態と実行プレーンの書き込みを別の所有者の別ルートに置く。

    - control_pub（yuya 所有・_kaburun は読むだけ＝ACL 共有の読み取り専用ディレクトリ・exec_root の外）: 制御イベント
      ログ・公開ポリシー・HALT/STOP・halt.lock。Agent/stub/reaper はここを**読むだけ**で、起動後に yuya が置く HALT・
      取消・承認の取消も次の検証でそのまま効く（ジョブ発行時に凍結した写しではなく、常に最新の制御状態を読む）。
    - exec_root（_kaburun 所有）: 実行プレーンが**書く**もの（agent-out・work と、Dispatcher が request を置く requests）。

    仕組み: `exec_root/pub` を control_pub への **symlink** にする。こうすると、実行側のどのサブプロセス（stub・reaper・
    watchdog）が `--root exec_root` から素の `Layout(exec_root)` を組み直しても、制御の公開状態を control_pub から読む
    （引数で control_pub を配り回す必要がない）。実行側が**書く** requests だけは pub から外して agent-out の下に置く。
    公開状態は chainlog の署名＋巻き戻り検知（control_seen は exec 側）で守り、control_pub が _kaburun から書けない
    （group/other 書き込み不可）ことは呼び出し側（jobrunner.build_loop）が handoff._safe_source_dir で確かめる。
    """

    def __init__(self, exec_root, control_pub):
        super().__init__(exec_root)   # pub=exec_root/pub、control_events 等は pub の下（下で symlink にする）
        self.control_pub = os.path.abspath(control_pub)
        # request の置き場だけは実行プレーン側に移す（pub は読み取り専用なので pub/requests は使わない）
        self.requests = os.path.join(self.agent_out, "requests")

    def ensure(self):
        """実行プレーン側のディレクトリだけ作り、exec_root/pub を control_pub への symlink にする
        （control_pub の中身は yuya が用意する・ここでは触らない）。"""
        for d in (self.agent_out, self.work, self.proc, self.runs, self.requests):
            os.makedirs(d, exist_ok=True)
        self._link_pub()
        return self

    def _link_pub(self):
        """exec_root/pub を control_pub への symlink にする。既に symlink で指す先が違う・symlink でない実体があれば拒否。"""
        link = self.pub  # exec_root/pub
        if os.path.islink(link):
            if os.path.realpath(link) != os.path.realpath(self.control_pub):
                raise LayoutError("exec pub symlink points elsewhere than control_pub")
            return
        if os.path.exists(link):
            raise LayoutError("exec pub already exists and is not a symlink to control_pub")
        os.symlink(self.control_pub, link)

    def ensure_control_pub(self):
        """制御プレーン（yuya）側で control_pub の中身を用意する（halt.lock を含む）。初期化・試験用。"""
        os.makedirs(self.control_pub, exist_ok=True)
        touch(os.path.join(self.control_pub, "halt.lock"))
        return self
