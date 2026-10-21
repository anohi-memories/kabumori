"""追記専用・ハッシュ連鎖・署名つきのログ。仕様 v5 §8-1、v5.4 §1・§2-2。

1行1レコード: seq（1から欠番なし）／event_id／type／ts／payload／prev_hash／role／sig。
- 追記は、ログごとの追記ロック（<path>.lock の排他）の下で行い、fsync する。
- read_all は、先頭から末尾までを1回で検証し、最新の番号とハッシュを返す。
- 検証の失敗（欠番・連鎖の不一致・署名の不正・役割の不一致・event_id の重複・壊れた行）は ChainError。
"""
import json
import os
import uuid

from .fsutil import FileLock, canonical, fsync_dir, sha256_hex, touch

GENESIS = "0" * 64


class ChainError(ValueError):
    pass


def record_hash(record):
    return sha256_hex(canonical(record))


class ChainLog:
    def __init__(self, path, verifier, type_roles):
        """type_roles: {type: 必要な役割 または 役割の集合}。表にない type は拒否。"""
        self.path = path
        self.verifier = verifier
        self.type_roles = type_roles
        self.lock_path = path + ".lock"

    def _ensure(self):
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        touch(self.lock_path)

    def read_all(self):
        records = []
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                raw = f.read()
        except FileNotFoundError:
            return records
        if raw and not raw.endswith("\n"):
            raise ChainError("truncated last line")
        prev = GENESIS
        seen_ids = set()
        for n, line in enumerate(raw.splitlines(), start=1):
            try:
                rec = json.loads(line)
            except ValueError:
                raise ChainError("unparseable record at line %d" % n)
            if not isinstance(rec, dict):
                raise ChainError("bad record at line %d" % n)
            if rec.get("seq") != n:
                raise ChainError("sequence gap at line %d" % n)
            if rec.get("prev_hash") != prev:
                raise ChainError("hash chain broken at seq %d" % n)
            if rec.get("event_id") in seen_ids:
                raise ChainError("duplicate event_id at seq %d" % n)
            seen_ids.add(rec.get("event_id"))
            allowed = self.type_roles.get(rec.get("type"))
            if allowed is None:
                raise ChainError("unknown type at seq %d" % n)
            allowed = {allowed} if isinstance(allowed, str) else set(allowed)
            if rec.get("role") not in allowed:
                raise ChainError("role not allowed for type at seq %d" % n)
            body = {k: v for k, v in rec.items() if k != "sig"}
            if not self.verifier.verify(rec["role"], canonical(body), rec.get("sig")):
                raise ChainError("bad signature at seq %d" % n)
            records.append(rec)
            prev = record_hash(rec)
        return records

    @staticmethod
    def head(records):
        if not records:
            return (0, GENESIS)
        return (records[-1]["seq"], record_hash(records[-1]))

    def _write(self, records, rtype, payload, signer, role, now):
        allowed = self.type_roles.get(rtype)
        allowed = {allowed} if isinstance(allowed, str) else set(allowed or ())
        if role not in allowed:
            raise ChainError("role %s not allowed for %s" % (role, rtype))
        seq, prev = self.head(records)
        body = {
            "seq": seq + 1,
            "event_id": uuid.uuid4().hex,
            "type": rtype,
            "ts": float(now),
            "payload": payload,
            "prev_hash": prev,
            "role": role,
        }
        body["sig"] = signer.sign(role, canonical(body))
        new = not os.path.exists(self.path)
        with open(self.path, "a", encoding="utf-8") as f:
            f.write(json.dumps(body, ensure_ascii=False, sort_keys=True) + "\n")
            f.flush()
            os.fsync(f.fileno())
        if new:
            fsync_dir(os.path.dirname(self.path))
        return body

    def append(self, rtype, payload, signer, role, now):
        record, _ = self.append_if(rtype, payload, signer, role, now, None)
        return record

    def append_if(self, rtype, payload, signer, role, now, predicate):
        """追記ロックの下で、全件を検証してから predicate(records) を評価し、True のときだけ追記する。

        predicate は (ok: bool, reason) を返す。追記しなかった場合は (None, reason)。
        """
        self._ensure()
        with FileLock(self.lock_path, "ex"):
            records = self.read_all()
            if predicate is not None:
                ok, reason = predicate(records)
                if not ok:
                    return None, reason
            return self._write(records, rtype, payload, signer, role, now), None
