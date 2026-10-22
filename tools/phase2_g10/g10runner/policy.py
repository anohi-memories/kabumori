"""ポリシー（実行権限設定）。正規化したJSONのSHA-256がダイジェスト。仕様 v5 §6-8。"""
import copy

from .fsutil import canonical, read_json, sha256_hex

DEFAULT_POLICY = {
    "version": "policy-v1",
    "adapter": "fake",  # 実Claudeへの切替は設定では不可能（adapter.py が fake 以外を拒否）
    "models": {"sonnet": "claude-sonnet-5-5", "opus": "claude-opus-5-5"},
    "allowed_secondary_models": [],
    "required_task_keys": ["task_id", "slot", "owner", "status", "next_owner", "return_to",
                           "completion_code", "recommended_model", "production_permission"],
    "phase2_additional_required_keys": [],
    "required_sections": ["目的", "preflight", "実行", "安全", "tests・完了条件"],
    "timing": {
        "absolute_max_minutes": 120,
        "grace_seconds": 20.0,
        "confirm_seconds": 10.0,
        "reaper_interval": 1.0,
        "reaper_confirm_timeout": 10.0,
        "s2_heartbeat_max_age": 90.0,
        "s2_redundancy_loss_age": 120.0,
        "starting_timeout": 30.0,
        "deadline_slack": 30.0,
        "request_ttl": 120.0,
        "halt_sync_wait": 30.0,
        "halt_escalation": 10.0,
        "minute_seconds": 60.0,
        "issue_evidence_max_age": 120.0,  # Issue #323 の取得証拠の有効時間（H4 P1）
    },
    "rate_guard": {"window_seconds": 600, "max_starts": 10},
    "breaker_consecutive_failures": 3,
    "max_concurrent": 1,
    "prompt_template_version": "prompt-v1",
}


def digest(policy):
    clean = {k: v for k, v in policy.items() if not k.startswith("_")}
    return sha256_hex(canonical(clean))


def with_digest(policy):
    p = copy.deepcopy(policy)
    p["_digest"] = digest(p)
    return p


def load(path):
    p = read_json(path)
    if p is None:
        raise FileNotFoundError(path)
    return with_digest(p)


def timing(policy, key):
    return float(policy["timing"][key])
