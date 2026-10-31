"""署名の境界。仕様 v5.3 §3・v5.4 §1。

役割（role）: runner（ランナー鍵）／human（人の鍵・パスフレーズつき）／agent（実行側の鍵）／
witness（Issue #323 の取得係の鍵。runner とは別。H4 P1）。
本TASKでは、実際の非対称署名（Ed25519／ECDSA と openssl）は実装しない（NOT_VERIFIED）。
試験用に、役割ごとに別の鍵を持つ HMAC の署名器を使い、「役割の取り違え・改ざん・欠落」を
検出できることだけを検証する。HmacTestSigner を実運用に使ってはならない。
"""
import hashlib
import hmac

ROLES = ("runner", "human", "agent", "witness")
# 署名方式の段階（TASK 15・16）。hmac → dual → ecdsa の順に1段ずつだけ進める
SIG_MODES = ("hmac", "dual", "ecdsa")


def mode_transition_allowed(old, new):
    """署名方式の切替は、同じか、1段先（hmac→dual→ecdsa）だけ。飛ばす・戻すは不可（戻すのは人が記録簿ごと作り直す）。"""
    if old not in SIG_MODES or new not in SIG_MODES:
        return False
    return SIG_MODES.index(new) - SIG_MODES.index(old) in (0, 1)


class SignatureError(ValueError):
    pass


class HmacTestSigner:
    """試験専用。roles に与えた役割の鍵だけを持つ（持たない役割では署名できない）。"""

    TEST_ONLY = True

    def __init__(self, keys):
        for role in keys:
            if role not in ROLES:
                raise ValueError("unknown role: " + role)
        self._keys = dict(keys)

    def can_sign(self, role):
        return role in self._keys

    def sign(self, role, data):
        if role not in self._keys:
            raise SignatureError("no key for role: " + role)
        return "hmac-sha256:" + hmac.new(self._keys[role], data, hashlib.sha256).hexdigest()


class HmacTestVerifier:
    """試験専用の検証器（公開鍵の代わりに、同じ鍵で検証する）。"""

    TEST_ONLY = True

    def __init__(self, keys):
        self._keys = dict(keys)

    def verify(self, role, data, sig):
        key = self._keys.get(role)
        if key is None or not isinstance(sig, str) or not sig.startswith("hmac-sha256:"):
            return False
        expected = "hmac-sha256:" + hmac.new(key, data, hashlib.sha256).hexdigest()
        return hmac.compare_digest(expected, sig)


def test_keys():
    return {"runner": b"test-runner-key", "human": b"test-human-key", "agent": b"test-agent-key",
            "witness": b"test-witness-key"}


TEST_KEYS_FILE = "test_keys.json"


def write_test_keys(root, keys=None):
    """試験専用の鍵ファイル（root/test_keys.json）。実運用の鍵の保管は未実装（NOT_VERIFIED）。"""
    import json
    import os
    keys = keys or test_keys()
    with open(os.path.join(root, TEST_KEYS_FILE), "w", encoding="utf-8") as f:
        json.dump({k: v.hex() for k, v in keys.items()}, f)


def load_test_keys(root):
    import json
    import os
    with open(os.path.join(root, TEST_KEYS_FILE), "r", encoding="utf-8") as f:
        return {k: bytes.fromhex(v) for k, v in json.load(f).items()}


def agent_side(root):
    """実行側のプロセス（スタブ・S1・S2）が使う署名器（agent の鍵のみ）と検証器。"""
    keys = load_test_keys(root)
    return HmacTestSigner({"agent": keys["agent"]}), HmacTestVerifier(keys)
