"""ログから状態を導く。仕様 v5.4 §1（状態の正本はイベントログ。フラグは合図のみ）。

制御側の状態: HALT（ソフト／ハード）・STOP・有効なENVELOPE・CONFIRM。
実行側の状態: HALT_AGENT。処理済み番号（control_seen）と巻き戻りの検知。
"""
import os

import re

from . import jstclock, signing
from .chainlog import record_hash
from .fsutil import atomic_write_json, read_json


class RewindError(ValueError):
    pass


class ControlState:
    def __init__(self):
        self.control_halts = {}  # event_id -> payload（未解除）
        self.agent_halts = {}    # event_id -> (seq, payload)（未解除）
        self.stopped = False
        self.envelope = None     # 有効なENVELOPE（失効は判定時に別途）
        self.confirms = {}       # approval_id -> payload
        self.issue_revokes = []  # ISSUE_REVOKE の payload（取り消しは解除しない。UNHALT でも消えない）
        self.problems = []
        self.head = (0, None)
        self.wiring = None          # 最新の有効な WIRING_APPROVE（TASK 16 R2）。無ければ従来の経路だけ
        self.wiring_problem = None  # 不正な承認（段飛ばし・後退・形の違反）。一度立てば以後の承認では消えない
        self.real_gos = []          # 有効な REAL_CLAUDE_GO（TASK 17。人の署名・形の検査済み。期限は使う側で判定）

    @property
    def go_bodies(self):
        """人の GO が本文の SHA-256 を承認している本文（編集者が分からない取得元でも、この本文なら信頼できる）。"""
        return frozenset(g["body_sha256"] for g in self.real_gos)

    @property
    def halted(self):
        return bool(self.control_halts) or bool(self.agent_halts)

    @property
    def hard_halted(self):
        if self.agent_halts:
            return True  # 実行側の HALT は安全違反として扱う（ハード）
        return any(p.get("kind") == "hard" for p in self.control_halts.values())


def derive(control_events, agent_events):
    """制御側と実行側のログから状態を導く。どちらのログも、検証済み（ChainLog.read_all）であること。"""
    st = ControlState()
    agent_halt_by_id = {}
    for rec in agent_events:
        if rec["type"] == "HALT_AGENT":
            agent_halt_by_id[rec["event_id"]] = (rec["seq"], rec["payload"])
    covered_agent = set()
    used_unhalt = set()
    for rec in control_events:
        t, p, eid = rec["type"], rec["payload"], rec["event_id"]
        if t == "HALT":
            st.control_halts[eid] = p
        elif t == "UNHALT":
            if eid in used_unhalt:
                st.problems.append("UNHALT reused")
                continue
            halt_ids = set(p.get("halt_ids", []))
            agent_ids = set(p.get("agent_halt_ids", []))
            head_seq = p.get("agent_head_seq", 0)
            expected_agent = {aid for aid, (seq, _) in agent_halt_by_id.items() if seq <= head_seq}
            if halt_ids != set(st.control_halts.keys()) or agent_ids != expected_agent:
                st.problems.append("UNHALT does not cover all unresolved halts")
                continue
            used_unhalt.add(eid)
            st.control_halts = {}
            covered_agent |= agent_ids
        elif t == "STOP":
            st.stopped = True
        elif t == "STOP_OFF":
            st.stopped = False
        elif t == "ENVELOPE_APPROVE":
            expected = jstclock.next_rollover(p.get("approved_at", 0))
            if abs(p.get("expires_at", -1) - expected) > 0.001:
                st.problems.append("ENVELOPE expires_at mismatch")
                st.envelope = None
                continue
            st.envelope = dict(p, event_id=eid)
        elif t == "ENVELOPE_SUPERSEDE":
            if st.envelope and st.envelope.get("envelope_id") == p.get("envelope_id"):
                st.envelope = None
        elif t == "ENVELOPE_REVOKE":
            if st.envelope and st.envelope.get("envelope_id") == p.get("envelope_id"):
                st.envelope = None
        elif t == "CONFIRM":
            st.confirms[p.get("approval_id")] = p
        elif t == "ISSUE_REVOKE":
            st.issue_revokes.append(p)
        elif t == "REAL_CLAUDE_GO":
            from . import real_claude
            if rec.get("role") == "human" and real_claude.go_problem(p) is None \
                    and all(g["go_id"] != p["go_id"] for g in st.real_gos):
                st.real_gos.append(dict(p, event_id=eid))
            else:
                st.problems.append("REAL_CLAUDE_GO invalid")
        elif t == "WIRING_APPROVE":
            reason = wiring_step_problem(st.wiring, p, rec.get("role"))
            if reason or st.wiring_problem:
                st.wiring_problem = st.wiring_problem or reason
            else:
                st.wiring = dict(p, event_id=eid)
    st.agent_halts = {aid: v for aid, v in agent_halt_by_id.items() if aid not in covered_agent}
    if control_events:
        st.head = (control_events[-1]["seq"], record_hash(control_events[-1]))
    return st


_SHA256 = re.compile(r"[0-9a-f]{64}")


def wiring_step_problem(prev, payload, role):
    """設定承認（TASK 16 R2）の1件の検査。人の署名・決まった形・世代が1つずつ増える・署名方式は同じか1段先だけ。"""
    if role != "human":
        return "wiring approval must be signed by the human role"
    if not isinstance(payload, dict) or set(payload) != {"mode", "wiring_sha256", "generation"}:
        return "wiring approval malformed"
    gen = payload["generation"]
    if payload["mode"] not in signing.SIG_MODES or not isinstance(payload["wiring_sha256"], str) \
            or not _SHA256.fullmatch(payload["wiring_sha256"]) or not isinstance(gen, int) or isinstance(gen, bool):
        return "wiring approval malformed"
    if gen != (prev["generation"] + 1 if prev else 1):
        return "wiring approval generation is not the next one"
    if prev and not signing.mode_transition_allowed(prev["mode"], payload["mode"]):
        return "wiring approval skips or reverses a signature-mode step (%s -> %s)" % (prev["mode"], payload["mode"])
    return None


def issue_revoked(st, item):
    """item（要求・登録簿の項目など: task_id・approval_id・task_sha256）が ISSUE_REVOKE の対象か。
    取消の task_id は必須。approval_id・task_sha256 は指定されたときだけ照合する（指定が無ければ、その task_id 全体）。"""
    for p in st.issue_revokes:
        if not p.get("task_id") or p.get("task_id") != item.get("task_id"):
            continue
        if p.get("approval_id") is not None and p.get("approval_id") != item.get("approval_id"):
            continue
        if p.get("task_sha256") is not None and p.get("task_sha256") != item.get("task_sha256"):
            continue
        return True
    return False


def check_seen(layout, control_events, update=True):
    """実行側の処理済み番号と照合する。巻き戻り・書き換えなら RewindError。問題なければ更新する。"""
    seen = read_json(layout.control_seen, {"seq": 0, "hash": None})
    n = len(control_events)
    if seen["seq"] > n:
        raise RewindError("control log rewound (seen %d > current %d)" % (seen["seq"], n))
    if seen["seq"] > 0 and record_hash(control_events[seen["seq"] - 1]) != seen["hash"]:
        raise RewindError("control log rewritten at seq %d" % seen["seq"])
    if update and n > seen["seq"]:
        atomic_write_json(layout.control_seen, {"seq": n, "hash": record_hash(control_events[-1])})
    return n


def flags_say_halt(layout):
    return os.path.exists(layout.halt_flag) or os.path.exists(layout.agent_halt_flag)


def flags_say_stop(layout):
    return os.path.exists(layout.stop_flag)


def envelope_covers(envelope, request):
    """起動要求が、ENVELOPE の範囲に完全に収まるか（1項目でも外れれば False）。"""
    if not envelope:
        return False
    if request.get("phase2_scope") not in envelope.get("scopes", []):
        return False
    if request.get("phase2_scope") == "limited_code_edit":  # TASK 26: コード編集は TASK ごとの人の CONFIRM だけ
        return False
    if envelope.get("models", {}).get(request.get("model")) != request.get("model_id"):
        return False
    if request.get("effort") not in envelope.get("efforts", []):
        return False
    if int(request.get("max_minutes", 10 ** 6)) > int(envelope.get("max_minutes_cap", 0)):
        return False
    if float(request.get("max_budget_usd", 10 ** 6)) > float(envelope.get("max_budget_cap", 0)):
        return False
    ref = request.get("base_ref", "")
    if not any(ref.startswith(prefix) for prefix in envelope.get("base_ref_prefixes", [])):
        return False
    if request.get("policy_sha256") != envelope.get("policy_sha256"):
        return False
    if request.get("production_permission") != "NO_GO" or request.get("report_mode") != "local_only":
        return False
    return True


def authorization_ok(state, request, local_now, reference_now):
    """CONFIRM（試験期間）または有効なENVELOPE（運用期間）で、起動要求が認められているか。"""
    mode = request.get("authorization")
    if mode == "confirm":
        c = state.confirms.get(request.get("approval_id"))
        return bool(c) and c.get("task_sha256") == request.get("task_sha256") \
            and c.get("policy_sha256") == request.get("policy_sha256")
    if mode == "envelope":
        env = state.envelope
        if not env or env.get("envelope_id") != request.get("envelope_id"):
            return False
        if not jstclock.envelope_usable(env["expires_at"], local_now, reference_now):
            return False
        return envelope_covers(env, request)
    return False
