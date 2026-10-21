"""Phase 2 TASK本文の解析と検証。仕様 v5 §3、v5.1 §4、v5.2 §2・§3。

Phase 1 の解析器とは別実装。ハッシュ計算（norm.py）と、起動可否の検証（validate_task）を分ける。
正式メタデータ領域を求める処理（find_region）は、両者で共有する。
"""
import re

FIELD_LINE = re.compile(r"^- ([a-z][a-z0-9_]{0,63}): (.*)$")
FIELD_FORMAT = re.compile(r"^[-*+]\s+([a-z][a-z0-9_]*)\s*:\s*\S")
TASK_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$")
APPROVAL_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
HEX40 = re.compile(r"^[0-9a-f]{40}$")
BRANCH_RE = re.compile(r"^[A-Za-z0-9._/-]{1,200}$")
PULL_REF_RE = re.compile(r"^refs/pull/([0-9]+)/head$")
PR_URL_RE = re.compile(r"^https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/pull/([0-9]+)$")
MAX_MINUTES_RE = re.compile(r"^[1-9][0-9]{0,2}$")
BUDGET_RE = re.compile(r"^[0-9]\.[0-9]{1,2}$")
EFFORTS = ("low", "medium", "high", "xhigh", "max")

ZERO_WIDTH = {"​", "‌", "‍", "⁠", "﻿"}
BIDI = {chr(c) for c in list(range(0x202A, 0x202F)) + list(range(0x2066, 0x206A))}

COMMON_REQUIRED = ("task_id", "slot", "owner", "status", "next_owner", "return_to",
                   "completion_code", "recommended_model", "production_permission")
PHASE1_KEYS = ("automation_enabled", "automation_mode", "automation_approval")
PHASE2_KEYS = ("phase2_run", "phase2_approval_id", "phase2_norm", "phase2_policy_version",
               "phase2_policy_sha256", "phase2_task_sha256", "base_ref", "base_sha", "model",
               "phase2_model_id", "effort", "max_minutes", "max_budget_usd", "phase2_scope",
               "phase2_report_mode")
CONTEXT_KNOWN = ("generation_limit", "generation_task_no", "completed_tasks_in_generation",
                 "review_required", "previous_task_id", "previous_report", "previous_history",
                 "previous_accept", "review_report", "review_history", "review_accept", "target_pr",
                 "pinned_head", "evidence_pr", "safety_gate", "migration_state",
                 "protected_predecessor", "predecessor_status", "next_task_allowed", "related_pr",
                 "predecessor_disposition")
KNOWN_KEYS = set(COMMON_REQUIRED + PHASE1_KEYS + PHASE2_KEYS + CONTEXT_KNOWN)
# 値を ASCII に限る承認用の項目（return_to・recommended_model は日本語を許す）
ASCII_ONLY = set(COMMON_REQUIRED + PHASE1_KEYS + PHASE2_KEYS + ("generation_limit",)) - {"return_to", "recommended_model"}

REQUIRED_SECTIONS = ("目的", "preflight", "実行", "安全", "tests・完了条件")
REPORT_TERMS = ("type: REPORT", "task_id", "next_task_allowed:false", "tests", "changed_files",
                "PR/HEAD", "remaining_issues", "safety_checks", "return_to", "completion_code")
MAX_REGION_KEYS = 80
MAX_VALUE_LEN = 1000


def find_region(lines):
    """タイトル行（1行目・`# `）の直後に連続する `- key: value` の行。見つからなければ None。"""
    if not lines or not lines[0].startswith("# "):
        return None
    end = 1
    while end < len(lines) and FIELD_LINE.match(lines[end]):
        end += 1
    if end == 1:
        return None
    return (1, end)


def field_format_key(line):
    """引用記号・字下げを除いた行が「リスト記号＋キー: 値」の形なら、そのキーを返す。"""
    stripped = line
    while True:
        s = stripped.lstrip(" \t")
        if s.startswith(">"):
            stripped = s[1:]
            continue
        stripped = s
        break
    m = FIELD_FORMAT.match(stripped)
    return m.group(1) if m else None


def bad_chars(value):
    for ch in value:
        if ch in ZERO_WIDTH or ch in BIDI or ord(ch) < 32 or ord(ch) == 127:
            return True
    return False


def parse_sections(lines, region_end):
    sections = {}
    current = None
    for line in lines[region_end:]:
        if line.startswith("## "):
            current = line[3:].strip()
            sections.setdefault(current, [])
            continue
        if line.startswith("# "):
            current = None
            continue
        if current is not None:
            sections[current].append(line)
    return sections


def valid_base_ref(ref):
    if ref.startswith("refs/heads/"):
        name = ref[len("refs/heads/"):]
        return (bool(BRANCH_RE.match(name)) and ".." not in name and "//" not in name
                and not name.startswith("/") and not name.endswith("/")
                and not name.startswith("-") and not name.endswith(".lock"))
    return bool(PULL_REF_RE.match(ref))


class ValidationResult:
    def __init__(self):
        self.problems = []
        self.fields = {}
        self.sections = {}

    @property
    def ok(self):
        return not self.problems

    def fail(self, message):
        self.problems.append(message)


def validate_task(body, policy):
    """自動実行してよい Phase 2 TASK かを検証する。ハッシュは norm.compute_hash で別に照合する。"""
    from . import norm  # 循環を避ける

    r = ValidationResult()
    try:
        norm.check_text_encoding(body)
    except norm.NormError as exc:
        r.fail(str(exc))
        return r
    lines = norm.normalize_lines(body)
    region = find_region(lines)
    if region is None:
        r.fail("formal metadata region not found")
        return r
    start, end = region

    fields = {}
    for i in range(start, end):
        key, value = FIELD_LINE.match(lines[i]).groups()
        value = value.strip()
        if key in fields:
            r.fail("duplicate key in region: " + key)
        fields[key] = value
        if bad_chars(value):
            r.fail("forbidden character in value: " + key)
        if len(value) > MAX_VALUE_LEN:
            r.fail("value too long: " + key)
        if key in ASCII_ONLY and not all(ord(c) < 128 for c in value):
            r.fail("non-ASCII value: " + key)
        if key.startswith("phase2_") and key not in KNOWN_KEYS:
            r.fail("unknown phase2 key: " + key)
    r.fields = fields
    if len(fields) > MAX_REGION_KEYS:
        r.fail("too many keys in region")

    for i, line in enumerate(lines):
        if start <= i < end:
            continue
        key = field_format_key(line)
        if key is not None and key in KNOWN_KEYS:
            r.fail("known field outside the formal region: %s (line %d)" % (key, i + 1))

    if "migration_state" in fields:
        r.fail("migration_state present: cutover not complete")

    required = list(policy.get("required_task_keys", COMMON_REQUIRED)) + ["generation_limit"]
    required += list(PHASE1_KEYS) + list(PHASE2_KEYS)
    required += list(policy.get("phase2_additional_required_keys", []))
    for key in required:
        if key not in fields:
            r.fail("missing key: " + key)

    def expect(key, value):
        if key in fields and fields[key] != value:
            r.fail("bad value: %s" % key)

    expect("slot", "G10")
    expect("status", "ready")
    expect("owner", "claude")
    expect("next_owner", "claude")
    expect("completion_code", "K10")
    expect("production_permission", "NO_GO")
    expect("generation_limit", "50")
    expect("automation_enabled", "true")
    expect("automation_mode", "local_cli")
    expect("automation_approval", "approved")
    expect("phase2_run", "approved")
    expect("phase2_norm", "NORM-1")
    expect("phase2_scope", "readonly_trial")
    expect("phase2_report_mode", "local_only")
    expect("phase2_policy_version", policy.get("version"))
    expect("phase2_policy_sha256", policy.get("_digest"))

    if "task_id" in fields and (fields["task_id"] == "none" or not TASK_ID_RE.match(fields["task_id"])):
        r.fail("bad value: task_id")
    for key in ("return_to", "recommended_model"):
        if key in fields and not fields[key]:
            r.fail("empty value: " + key)
    if "phase2_approval_id" in fields and not APPROVAL_ID_RE.match(fields["phase2_approval_id"]):
        r.fail("bad value: phase2_approval_id")
    sha = fields.get("phase2_task_sha256")
    if sha is not None and (not HEX64.match(sha) or norm.is_placeholder(sha)):
        r.fail("bad value: phase2_task_sha256")
    if "base_ref" in fields and not valid_base_ref(fields["base_ref"]):
        r.fail("bad value: base_ref")
    if "base_sha" in fields and not HEX40.match(fields["base_sha"]):
        r.fail("bad value: base_sha")
    models = policy.get("models", {})
    if "model" in fields and fields["model"] not in models:
        r.fail("bad value: model")
    if "phase2_model_id" in fields and models.get(fields.get("model")) != fields["phase2_model_id"]:
        r.fail("bad value: phase2_model_id")
    if "effort" in fields and fields["effort"] not in EFFORTS:
        r.fail("bad value: effort")
    mm = fields.get("max_minutes")
    if mm is not None and (not MAX_MINUTES_RE.match(mm) or not 1 <= int(mm) <= 120):
        r.fail("bad value: max_minutes")
    bud = fields.get("max_budget_usd")
    if bud is not None and (not BUDGET_RE.match(bud) or not 0.01 <= float(bud) <= 0.50):
        r.fail("bad value: max_budget_usd")

    # 任意（文脈）の項目は、存在する場合だけ形式を確認する
    gtn = fields.get("generation_task_no")
    if gtn is not None and not re.match(r"^[1-9][0-9]*$", gtn):
        r.fail("bad value: generation_task_no")
    ctg = fields.get("completed_tasks_in_generation")
    if ctg is not None and not re.match(r"^(0|[1-9][0-9]*)$", ctg):
        r.fail("bad value: completed_tasks_in_generation")
    rr = fields.get("review_required")
    if rr is not None and not (rr.startswith("true") or rr.startswith("false")):
        r.fail("bad value: review_required")
    if gtn and ctg and re.match(r"^[0-9]+$", gtn) and re.match(r"^[0-9]+$", ctg):
        if int(gtn) > 50 or int(ctg) > int(gtn):
            r.fail("generation counters inconsistent")

    sections = parse_sections(lines, end)
    r.sections = sections
    for name in policy.get("required_sections", REQUIRED_SECTIONS):
        content = sections.get(name)
        if content is None or not any(line.strip() for line in content):
            r.fail("missing or empty section: " + name)

    pr_lines = [line for line in sections.get("preflight", []) if line.startswith("- 関連PR:")]
    if len(pr_lines) != 1:
        r.fail("preflight must contain exactly one '- 関連PR:' line")
    else:
        value = pr_lines[0][len("- 関連PR:"):].strip()
        has_target = "target_pr" in fields
        has_pinned = "pinned_head" in fields
        if value.startswith("なし"):
            if has_target or has_pinned:
                r.fail("関連PR is none but target_pr/pinned_head present")
        else:
            urls = value.split()
            numbers = []
            for u in urls:
                m = PR_URL_RE.match(u)
                if not m:
                    r.fail("bad 関連PR value")
                    break
                numbers.append(m.group(1))
            if not (has_target and has_pinned):
                r.fail("PR listed but target_pr/pinned_head missing")
            else:
                m = PR_URL_RE.match(fields["target_pr"])
                ref = PULL_REF_RE.match(fields.get("base_ref", ""))
                if (not m or m.group(1) not in numbers or not ref or ref.group(1) != m.group(1)
                        or fields["pinned_head"] != fields.get("base_sha")):
                    r.fail("target_pr/pinned_head/base_ref/base_sha mismatch")
    if ("target_pr" in fields) != ("pinned_head" in fields):
        r.fail("target_pr and pinned_head must appear together")

    tests_text = "\n".join(sections.get("tests・完了条件", []))
    compact = tests_text.replace(" ", "")
    for term in REPORT_TERMS:
        probe = term.replace(" ", "")
        if probe not in compact:
            r.fail("REPORT term missing in tests・完了条件: " + term)
    if not re.search(r"本文.{0,6}編集.{0,6}禁止", tests_text):
        r.fail("REPORT term missing in tests・完了条件: 本文編集禁止")
    return r
