"""4つのログの定義（種類と、署名に必要な役割）。"""
from .chainlog import ChainLog

# 制御側のイベントログ（状態の正本）。停止の方向はランナー鍵でもよい。起動・解除の方向は人の鍵。
CONTROL_TYPES = {
    "HALT": {"runner", "human"},
    "STOP": {"runner", "human"},
    "ENVELOPE_REVOKE": {"runner", "human"},
    "ISSUE_REVOKE": {"runner", "human"},  # 特定のTASKの取消（TASK 5）。取り消す方向なのでランナー鍵でもよい
    "ENVELOPE_APPROVE": "human",
    "ENVELOPE_SUPERSEDE": "human",
    "CONFIRM": "human",
    "UNHALT": "human",
    "STOP_OFF": "human",
    "WIRING_APPROVE": "human",  # 結線の設定（wiring.json）の承認（TASK 16 R2）。世代・mode・設定のハッシュ
}
STOP_DIRECTION = {"HALT", "STOP", "ENVELOPE_REVOKE", "ENVELOPE_SUPERSEDE", "ISSUE_REVOKE"}

# 制御側の台帳（承認IDの消費・終了の事実・確認）
LEDGER_TYPES = {
    "CLAIM": "runner",
    "END": "runner",
    "HALT_RECORD": "runner",
    "ACK_RESULT": {"runner", "human"},
    "ACK_SAFETY": "human",
}

# 実行側のログ
AGENT_TYPES = {"HALT_AGENT": "agent"}
USED_TYPES = {"ACCEPTED": "agent", "SPAWNING": "agent", "SPAWNED": "agent", "ABORTED": "agent"}


def control_log(layout, verifier):
    return ChainLog(layout.control_events, verifier, CONTROL_TYPES)


def ledger(layout, verifier):
    return ChainLog(layout.ledger, verifier, LEDGER_TYPES)


def agent_log(layout, verifier):
    return ChainLog(layout.agent_events, verifier, AGENT_TYPES)


def used_log(layout, verifier):
    return ChainLog(layout.used_requests, verifier, USED_TYPES)
