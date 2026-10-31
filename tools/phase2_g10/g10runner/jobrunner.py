"""専用ユーザー方式の常駐ジョブ実行を1本に組む driver（B0-1）。_kaburun の GUI セッションで launchd から回す本体。

設計 §15 の部品（handoff 受け口・ResidentLoop・Dispatcher・result_handoff）を、初期化済みの exec プレーンのルート
（鍵・wiring.json・ポリシー）から1つの常駐ループに組み立てる:

  flags/HALT・STOP → 固定版の検証 → ログイン前チェック（固定版・モデル非呼び出し）→ HandoffInbox.accept
  （human 署名の検証＋at-most-once CLAIM）→ Dispatcher（request の runner 署名を Agent が再検証してスタブ起動・終端）
  → ExportingDispatcher が結果の束を handoff/out へ agent 署名つきで書き出す → ResidentLoop が disposition を out に記録。

鍵の配り方（§15.7 Q1/Q2・B0-3 の前提）:
- handoff の human 署名も request の runner 署名も、exec プレーンが持つ **4役割の公開鍵**（wiring.agent_side の verifier）で
  検証する。exec 側が持つ秘密鍵は agent だけ（human/runner は作れない＝偽造できない）。
- agent 署名器は、Agent の内部署名と、結果マニフェストの署名（result_handoff の MANIFEST_ROLE="agent"）の両方に使う。
- finalize は yuya 側（human/runner 鍵）。exec 側は束を out に出すだけで、照合・取消・GitHub postflight はしない。
"""
import os
import time

from . import handoff, policy as policy_mod, resident, result_handoff, wiring
from .agent import Agent
from .layout import Layout


class ExportingDispatcher:
    """内側の Dispatcher で終端まで回した後、結果の束を handoff/out へ agent 署名つきで書き出す（§15.10）。

    run は既に起きている（CLAIM を消費し、CLI も走った）ので、export の失敗で run を失敗扱いにはしない。例外は投げず、
    disposition 用の結果に注記だけ残す（ResidentLoop の外側 except に拾わせて dispatch_failed にしない）。yuya は
    out/<run_id>/ の束の有無で判断する（束が無ければ export 失敗＝調査。disposition の run_id は残る）。
    """

    # 束が揃う見込みの無い終端は export しない（未受理・timeout・dispatch 失敗は成果物が欠ける）
    _NO_EXPORT = frozenset({"not_accepted", "timeout", "dispatch_failed"})

    def __init__(self, dispatcher, out_dir, signer, now=time.time):
        handoff._safe_owned_dir(out_dir)  # _kaburun 所有・group/other 書き込み不可
        self.dispatcher = dispatcher
        self.out_dir = out_dir
        self.signer = signer
        self.now = now

    @property
    def layout(self):
        return self.dispatcher.layout

    def __call__(self, decision):
        result = self.dispatcher(decision)
        run_id, status = result.get("run_id"), result.get("status")
        if not run_id or status in self._NO_EXPORT:
            return result
        try:
            result_handoff.export_result(self.layout, run_id, self.out_dir, self.signer, now=self.now)
            return dict(result, exported=True)
        except (result_handoff.ResultHandoffError, OSError) as exc:  # run は成功。export の失敗は注記のみ
            return dict(result, exported=False, export_error=type(exc).__name__)


def build_loop(root, in_dir, claims_dir, out_dir, flags_dir, cli_realpath, home,
               wait_seconds=600, log_path=None, now=time.time, release_check=None):
    """_kaburun 側の常駐ループを1本に組む（B0-1）。

    root: exec プレーンの初期化済みルート（keys/・wiring.json・公開ポリシー）。bin/g10_first_run.py init 相当で作る。
    in/claims/out/flags: handoff の受け渡しフォルダ（in・flags=yuya 所有／out・claims=_kaburun 所有）。
    cli_realpath/home: _kaburun の固定版 CLI（版の名前のファイル）と HOME。ログイン前チェックと実起動に使う。
    """
    root = os.path.realpath(root)
    layout = Layout(root)
    policy = policy_mod.load_current(layout)   # 正本と公開用が一致しなければ開かない（TASK 28）
    signer, verifier = wiring.agent_side(root)  # 署名は agent のみ・検証は4役割の公開鍵
    agent = Agent(layout, signer, verifier, policy)
    inbox = handoff.HandoffInbox(in_dir, claims_dir, verifier, now=now)
    dispatcher = resident.Dispatcher(agent, layout, wait_seconds=wait_seconds, now=now)
    exporting = ExportingDispatcher(dispatcher, out_dir, signer, now=now)
    return resident.ResidentLoop(inbox, flags_dir, out_dir, cli_realpath, home, exporting,
                                 now=now, log_path=log_path, release_check=release_check)
