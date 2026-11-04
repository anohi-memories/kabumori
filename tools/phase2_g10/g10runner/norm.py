"""NORM-1（承認ハッシュ）。仕様 v5 §4・v5.1 §3。

- norm1_digest(text): 低水準関数。領域の検査をしない（Unicodeなどの低水準の性質の試験用）。
- compute_hash(body): BOM・不正UTF-8・正式メタデータ領域を検査してから norm1_digest を呼ぶ。
"""
import hashlib
import re

from . import meta

HASH_LINE_PREFIX = "- phase2_task_sha256: "
NORM_VERSION = "NORM-1"


class NormError(ValueError):
    pass


def normalize_lines(text):
    """CRLF・CR を LF にし、各行の末尾の空白・タブを削る。"""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    return [line.rstrip(" \t") for line in text.split("\n")]


def _digest_from_lines(lines, drop_index):
    kept = [line for i, line in enumerate(lines) if i != drop_index]
    text = "\n".join(kept).rstrip("\n") + "\n"
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def norm1_digest(text):
    """低水準: ハッシュ行（行頭が `- phase2_task_sha256: `）がちょうど1つであれば、その行を除いてSHA-256。"""
    lines = normalize_lines(text)
    hits = [i for i, line in enumerate(lines) if line.startswith(HASH_LINE_PREFIX)]
    if len(hits) != 1:
        raise NormError("hash line count is %d (must be 1)" % len(hits))
    return _digest_from_lines(lines, hits[0])


def check_text_encoding(body):
    if not isinstance(body, str):
        raise NormError("body is not text")
    if body.startswith("﻿"):
        raise NormError("BOM is not allowed")
    try:
        body.encode("utf-8")
    except UnicodeEncodeError:
        raise NormError("body is not valid UTF-8 (lone surrogate)")


def compute_hash(body):
    """正式メタデータ領域の中の、ちょうど1つのハッシュ行を除いて NORM-1 を計算する。"""
    check_text_encoding(body)
    lines = normalize_lines(body)
    region = meta.find_region(lines)
    if region is None:
        raise NormError("formal metadata region not found")
    start, end = region
    in_region = [i for i in range(start, end) if lines[i].startswith(HASH_LINE_PREFIX)]
    if len(in_region) != 1:
        raise NormError("hash line count in region is %d (must be 1)" % len(in_region))
    for i, line in enumerate(lines):
        if start <= i < end:
            continue
        key = meta.field_format_key(line)
        if key == "phase2_task_sha256":
            raise NormError("hash field outside the formal region (line %d)" % (i + 1))
    return _digest_from_lines(lines, in_region[0])


def is_placeholder(value):
    return bool(re.fullmatch(r"0{64}", value or ""))
