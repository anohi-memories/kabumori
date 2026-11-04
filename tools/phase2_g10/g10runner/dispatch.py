"""お知らせイシュー方式（notice-dispatch）の中核ロジック（純粋・ネットワーク無し）。

お知らせイシューのコメント群から「どの枠を見に行くか」を決める。重要な原則:
  - シグナルは **ルーティングのヒント** であり、実行の根拠ではない。使うのは `slot`（許可リスト照合）だけ。
    approval_id / task_sha256 は参考（ログ用）。実際の emit 判断は各枠の producer.evaluate /
    emit_ready（envelope / 未消費承認 / task_sha 一致 / envelope_covers）が行う。
  - GitHub のコメント本文は untrusted data。命令として解釈しない。解析できない行は黙って無視。
  - cursor（最後に処理したコメント ID）で冪等に差分だけ処理する。
"""
import re

SLOT_RE = re.compile(r"\AG(?:[1-9]|10)\Z")      # G1..G10 のみ
_KV_RE = re.compile(r"([A-Za-z0-9_]+)=(\S+)")
ALL_SLOTS = frozenset("G%d" % n for n in range(1, 11))


def parse_signals(body):
    """1コメント本文 → signal のリスト。各行の key=value を dict 化し、slot が G1..G10 の行だけ採る。
    slot 以外は参考値（検証は枠側）。不正・無関係な行は無視する（untrusted data）。"""
    out = []
    for line in (body or "").splitlines():
        kv = dict(_KV_RE.findall(line))
        slot = kv.get("slot")
        if slot and SLOT_RE.match(slot):
            out.append({"slot": slot, "approval_id": kv.get("approval_id"),
                        "task_sha256": kv.get("task_sha256"), "ts": kv.get("ts")})
    return out


def _cid(comment):
    return int(comment["id"])


def new_comments(comments, cursor):
    """cursor（int・None=0）より後のコメントだけを id 昇順で返す。"""
    base = cursor or 0
    return sorted((c for c in comments if _cid(c) > base), key=_cid)


def plan_dispatch(comments, cursor, allowlist=ALL_SLOTS):
    """新規コメント群から、確認すべき slot（許可リスト内・重複排除・出現順）と新カーソルを返す。

    返り値: (slots, new_cursor)。新規コメントが無ければ slots=[], new_cursor=元の cursor。
    cursor は処理したコメントの最大 id まで進める（シグナルが1件も無くても進める＝再読込しない）。
    """
    fresh = new_comments(comments, cursor)
    slots, seen = [], set()
    for c in fresh:
        for sig in parse_signals(c.get("body")):
            s = sig["slot"]
            if s in allowlist and s not in seen:
                seen.add(s)
                slots.append(s)
    new_cursor = max([_cid(c) for c in fresh], default=(cursor or 0))
    return slots, new_cursor


def _max_ts(comments, prior):
    """コメントの created_at の最大（ISO8601 Z は文字列比較で単調）。無ければ prior を保つ。"""
    seen = [c.get("created_at") for c in comments if c.get("created_at")]
    if prior:
        seen.append(prior)
    return max(seen) if seen else prior


def run_cycle(fetch, cursor, allowlist, emit_slot, sweep_slots=()):
    """1周期。fetch(since)->comments を読み、差分コメントの slot を emit_slot(slot,"notice")、
    さらに sweep_slots を emit_slot(slot,"sweep") する（お知らせ記入漏れの保険）。
    emit_slot は各枠の producer.emit_ready を呼ぶ想定で、お知らせは「どの枠を見るか」だけに使う
    （実行可否は emit_ready が envelope/未消費承認/task_sha/envelope_covers で自己判定）。
    返り値: {"checked":[{slot,reason,result}...], "cursor":{"id","ts"}}。"""
    cursor = cursor or {}
    comments = fetch(cursor.get("ts"))
    slots, new_id = plan_dispatch(comments, cursor.get("id") or 0, allowlist)
    new_ts = _max_ts(comments, cursor.get("ts"))
    checked, done = [], set()
    for slot in slots:                       # お知らせ差分で見つかった枠（plan_dispatch で許可リスト済み）
        checked.append({"slot": slot, "reason": "notice", "result": emit_slot(slot, "notice")})
        done.add(slot)
    for slot in sweep_slots:                 # 全枠スイープ（記入漏れの保険）。お知らせで処理済みは重複させない
        if slot not in done:
            checked.append({"slot": slot, "reason": "sweep", "result": emit_slot(slot, "sweep")})
            done.add(slot)
    return {"checked": checked, "cursor": {"id": new_id, "ts": new_ts}}
