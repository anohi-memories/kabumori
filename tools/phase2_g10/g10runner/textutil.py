"""秘密情報の伏せ字（Phase 1 と同じ規則）。ログ・REPORT・標準出力の出口で必ず通す。"""
import re

SECRET_PATTERNS = (
    (re.compile(r"gh[pousr]_[A-Za-z0-9]{16,}"), "[REDACTED]"),
    (re.compile(r"github_pat_[A-Za-z0-9_]{16,}"), "[REDACTED]"),
    (re.compile(r"sk-ant-[A-Za-z0-9_-]{16,}"), "[REDACTED]"),
    (re.compile(r"(?i)\bbearer\s+[^\s\"']+"), "Bearer [REDACTED]"),
    (re.compile(r"(?i)\b(token|authorization|password|passwd|secret|api[_-]?key)\b"
                r"(?:\s*[:=]\s*|\s+)(?:(?:token|bearer|basic)\s+)?[^\s\"']+"), r"\1 [REDACTED]"),
    (re.compile(r"\b[0-9a-fA-F]{40,}\b"), "[REDACTED]"),
)


def redact(text):
    text = str(text)
    for pattern, replacement in SECRET_PATTERNS:
        text = pattern.sub(replacement, text)
    return text


def safe(value, limit=200):
    """伏せてから切り詰める（先に切ると、トークンの一部だけが残る）。"""
    return re.sub(r"[^\x20-\x7e　-鿿＀-￯]", "?", redact(value))[:limit]
