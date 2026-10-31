"""専用ユーザー方式のジョブ実行エージェントの常駐ループ（設計 §15）。_kaburun の GUI セッションで回す本体。

handoff/in の署名付きジョブを1周期に1件、fail-closed で回す:
  flags/HALT・STOP の確認 → CLI のログイン前チェック（固定版・モデルを呼ばない）→ HandoffInbox.accept（検証＋
  at-most-once CLAIM）→ dispatch（実行プレーンへ。注入）→ 結果を handoff/out に書く → 記録。

決めたこと:
- **認証の前チェックは周期の頭・accept の前**に、_kaburun の固定版 CLI で行う（§15.7 Q3）。未ログインなら何も CLAIM
  せずに止まる＝承認を無駄に消費しない。実行プレーン側も起動直前に自分で再確認する（多層）。
- **dispatch は実行プレーン（agent.Agent → スタブ）への呼び出し口**。request の署名境界・共有状態の所有権（§15.7
  Q1/Q2）は dispatch の内側の別段で決める。本体はそれに依存しない（テストは代役の dispatch を注入）。
- 1インスタンスだけが動く（launchd はラベルごとに1つ）。dispatch は終端まで待つ同期なので、ランは常に1本ずつ。
  周期の途中で落ちても、CLAIM 済みのジョブは claim マーカーで二度と受理されない＝再実行しない（fail-closed）。
- 記録・out には本文・秘密・メールアドレスを書かない。
"""
import json
import os
import stat
import time

from . import handoff, real_claude, registry
from .fsutil import atomic_write_json

HALT_FLAG = "HALT"
STOP_FLAG = "STOP"
DEFAULT_INTERVAL = 300.0  # autorun の MIN_LIVE_INTERVAL 相当


class ResidentLoop:
    def __init__(self, inbox, flags_dir, out_dir, cli_realpath, home, dispatch,
                 auth_check=real_claude.auth_status, now=time.time, log_path=None, release_check=None):
        if not isinstance(inbox, handoff.HandoffInbox):
            raise handoff.HandoffError("inbox must be a HandoffInbox")
        handoff._safe_source_dir(flags_dir)   # yuya=書き／_kaburun=読み（group/other 書き込み不可）
        handoff._safe_owned_dir(out_dir)       # _kaburun 所有
        if not (isinstance(cli_realpath, str) and os.path.isabs(cli_realpath)):
            raise handoff.HandoffError("cli_realpath must be an absolute path")
        if not (isinstance(home, str) and os.path.isabs(home)):
            raise handoff.HandoffError("home must be an absolute path")
        self.inbox = inbox
        self.flags_dir = flags_dir
        self.out_dir = out_dir
        self.cli_realpath = cli_realpath
        self.home = home
        self.dispatch = dispatch
        self.auth_check = auth_check
        self.now = now
        self.log_path = log_path
        self.release_check = release_check  # 固定版の検証（問題の一覧を返す）。周期の頭・auth の前で fail-closed

    # --- フラグ（UID をまたぐので signal ではなくファイル。存在＝止める＝fail-safe） ---
    def _flag_present(self, name):
        return os.path.lexists(os.path.join(self.flags_dir, name))

    def halt_reason(self):
        if self._flag_present(HALT_FLAG):
            return "halted"
        if self._flag_present(STOP_FLAG):
            return "stopped"
        return None

    def _auth(self):
        return self.auth_check(self.cli_realpath, self.home)

    def _list_jobs(self):
        """in/ の候補（通常ファイル・シンボリックリンクでない・隠しでない）。名前順で安定。安全確認は accept が再度行う。"""
        names = []
        for name in os.listdir(self.inbox.in_dir):
            if name.startswith("."):
                continue
            try:
                st = os.lstat(os.path.join(self.inbox.in_dir, name))
            except OSError:
                continue
            if stat.S_ISREG(st.st_mode):
                names.append(name)
        return sorted(names)

    def _write_out(self, job_id, disposition):
        """handoff/out に結果を1件書く（本文・秘密・メール不可）。job_id は accept で検証済み（_JOB_ID）。"""
        atomic_write_json(os.path.join(self.out_dir, job_id + ".json"), disposition)

    def _record(self, entry):
        keep = {k: entry[k] for k in ("decision", "reason", "job", "job_id", "run_id", "status", "logged_in")
                if k in entry}
        keep["ts"] = self.now()
        if self.log_path:
            with open(self.log_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(keep, ensure_ascii=False, sort_keys=True) + "\n")
        return keep

    def step(self):
        """1周期。起動した／しなかったの記録を返す。どこで欠けても起動しない（fail-closed）。"""
        reason = self.halt_reason()
        if reason:
            return self._record({"decision": "wait", "reason": reason})
        if self.release_check is not None:
            # 固定版が改変されていたら、auth も accept もせずに止める（HALT は常に先＝いつでも止められる）
            problems = self.release_check()
            if problems:
                return self._record({"decision": "wait", "reason": "release verification failed"})
        auth = self._auth()
        if auth.get("logged_in") is not True:
            # 承認を消費しない: accept の前で止める。yuya 側は out/ ではなくこのログ＋通知で気づく
            return self._record({"decision": "wait", "reason": "cli not logged in", "logged_in": auth.get("logged_in")})
        jobs = self._list_jobs()
        if not jobs:
            return self._record({"decision": "idle", "reason": "no jobs in handoff/in"})
        filename = jobs[0]
        decision = self.inbox.accept(filename)
        if not decision.ok:
            return self._record({"decision": "skip", "reason": decision.reason, "job": filename})
        job_id = decision.job["job_id"]
        try:
            result = self.dispatch(decision)
        except Exception as exc:  # dispatch の失敗は「このジョブは終わり」。CLAIM 済みなので再実行しない
            result = {"run_id": None, "status": "dispatch_failed", "reason": type(exc).__name__}
        disposition = {"job_id": job_id, "status": result.get("status"), "run_id": result.get("run_id"),
                       "ts": self.now()}
        self._write_out(job_id, disposition)
        return self._record({"decision": "ran", "reason": result.get("status"), "job": filename,
                             "job_id": job_id, "run_id": result.get("run_id"), "status": result.get("status")})

    def run(self, max_cycles=None, interval=DEFAULT_INTERVAL, sleep=time.sleep):
        """常駐。max_cycles を与えたらその回数で戻る（テスト用）。HALT/STOP では起動しないが常駐は続く
        （フラグが消えれば再開。恒久停止は launchctl bootout）。各周期の記録の一覧を返す。"""
        records = []
        count = 0
        while max_cycles is None or count < max_cycles:
            records.append(self.step())
            count += 1
            if max_cycles is not None and count >= max_cycles:
                break
            sleep(interval)
        return records


class Dispatcher:
    """dispatch シームの実結線（§15.7 Q1）。handoff が運んだ runner 署名つき request 封筒を、実行プレーンの
    request_file に置き、agent.handle_request_file でスタブを起動して終端まで待つ。

    - request の runner 署名・承認済みTASK／ポリシーとの結合・Issue 結合・権限・期限は Agent が独立に検証する
      （handoff の human 署名とは別の層）。CLAIM も3層: 制御側 ledger（try_claim）・handoff の claim マーカー・
      Agent の used ログ（ACCEPTED）。それぞれ別の再送面を塞ぐ。
    - Q2（_kaburun が書く registry/logs の所有権と yuya の finalize への受け渡し）は handoff/out 経由にするのが方針。
      ここでは終端状態を返すだけ（finalize は yuya 側＝human/runner 鍵）。
    """

    def __init__(self, agent, layout, wait_seconds=600, now=time.time, sleep=time.sleep):
        self.agent = agent
        self.layout = layout
        self.wait_seconds = wait_seconds
        self.now = now
        self.sleep = sleep

    def __call__(self, decision):
        req = decision.request
        run_id = req["run_id"]
        # handoff が運んだ封筒をそのまま実行プレーンの request_file に置く（runner 署名はバイト一致で保たれる）
        atomic_write_json(self.layout.request_file(run_id), decision.request_doc)
        stub, reason = self.agent.handle_request_file(self.layout.request_file(run_id))
        if stub is None:
            return {"run_id": run_id, "status": "not_accepted", "reason": reason}
        stub.wait()
        deadline = self.now() + self.wait_seconds
        while self.now() < deadline:
            entry = registry.load(self.layout, run_id)
            if entry and entry["state"] not in registry.NON_TERMINAL:
                return {"run_id": run_id, "status": entry["state"], "used_states": self.agent.used_state(run_id)}
            self.sleep(1)
        return {"run_id": run_id, "status": "timeout"}
