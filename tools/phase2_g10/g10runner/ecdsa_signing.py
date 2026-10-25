"""監督付き自動起動の準備（TASK 13）: 非対称署名（ECDSA P-256・SHA-256）の署名器と検証器（候補・未結線）。

試験用の HMAC（signing.py）では、検証する側も同じ鍵を持つので、検証者が署名を作れてしまう。実運用では非対称署名にし、
各役割（runner・human・agent・witness）の秘密鍵はその役割のプロセスだけが持ち、検証する側は公開鍵だけを持つ。

- この Mac の openssl（LibreSSL 3.3.6）は Ed25519 に対応していない（確認済み）。そのため ECDSA P-256 を使う。
  外部の Python パッケージは使わず、固定のパス /usr/bin/openssl を、最小の環境変数で呼ぶ。
- 署名器は、持っている役割の秘密鍵でだけ署名する。秘密鍵のファイルは所有者だけが読める（0600）こと。
- 検証器は公開鍵だけを受け付ける（秘密鍵のファイルを渡されたら拒否）。
- 署名の形式は "ecdsa-p256-sha256:<DER の16進>"。それ以外の形式・壊れた署名は「検証失敗」。
- 既定ではどこにも結線していない（現在の起動は試験用 HMAC のまま）。人の鍵のパスフレーズ・鍵の保管場所（Keychain 等）・
  ローテーションは未実装（NOT_VERIFIED）。鍵の生成（generate_keypair）は試験・dry-run 用で、実運用の鍵の作成は別承認。
"""
import os
import re
import stat
import subprocess
import tempfile

from .signing import ROLES, SignatureError

OPENSSL = "/usr/bin/openssl"
PREFIX = "ecdsa-p256-sha256:"
_ENV = {"PATH": "/usr/bin:/bin", "LANG": "C"}
_HEX = re.compile(r"[0-9a-f]+")


def _run(args, data=None):
    return subprocess.run([OPENSSL] + args, input=data, capture_output=True, env=_ENV, timeout=20)


def generate_keypair(directory, role):
    """試験・dry-run 用: directory に <role>.key（0600）と <role>.pub を作る。実運用の鍵は別承認。"""
    if role not in ROLES:
        raise ValueError("unknown role: " + role)
    priv = os.path.join(directory, role + ".key")
    pub = os.path.join(directory, role + ".pub")
    old = os.umask(0o077)
    try:
        r = _run(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", priv])
        if r.returncode != 0:
            raise RuntimeError("openssl key generation failed")
        r = _run(["ec", "-in", priv, "-pubout", "-out", pub])
        if r.returncode != 0:
            raise RuntimeError("openssl public key export failed")
    finally:
        os.umask(old)
    os.chmod(priv, 0o600)
    return priv, pub


def _check_private_key(path):
    st = os.stat(path)
    if st.st_uid != os.getuid() or stat.S_IMODE(st.st_mode) & 0o077:
        raise ValueError("private key must be owned by this user and readable only by the owner (0600)")
    with open(path, "rb") as f:
        head = f.read(64)
    if b"PRIVATE KEY" not in head:
        raise ValueError("not a private key file")


def _check_public_key(path):
    with open(path, "rb") as f:
        data = f.read()
    if not data.startswith(b"-----BEGIN PUBLIC KEY-----") or b"PRIVATE" in data:
        raise ValueError("the verifier accepts public keys only")


class EcdsaSigner:
    """持っている役割の秘密鍵でだけ署名する。signing.HmacTestSigner と同じインターフェース（can_sign／sign）。"""

    def __init__(self, private_keys):
        for role, path in private_keys.items():
            if role not in ROLES:
                raise ValueError("unknown role: " + role)
            _check_private_key(path)
        self._keys = dict(private_keys)

    def can_sign(self, role):
        return role in self._keys

    def sign(self, role, data):
        if role not in self._keys:
            raise SignatureError("no key for role: " + role)
        r = _run(["dgst", "-sha256", "-sign", self._keys[role]], data)
        if r.returncode != 0 or not r.stdout:
            raise SignatureError("signing failed")
        return PREFIX + r.stdout.hex()


class EcdsaVerifier:
    """公開鍵だけで検証する。signing.HmacTestVerifier と同じインターフェース（verify）。"""

    def __init__(self, public_keys):
        for role, path in public_keys.items():
            if role not in ROLES:
                raise ValueError("unknown role: " + role)
            _check_public_key(path)
        self._keys = dict(public_keys)

    def verify(self, role, data, sig):
        key = self._keys.get(role)
        if key is None or not isinstance(sig, str) or not sig.startswith(PREFIX):
            return False
        hexpart = sig[len(PREFIX):]
        if not hexpart or len(hexpart) % 2 or not _HEX.fullmatch(hexpart) or len(hexpart) > 400:
            return False
        with tempfile.NamedTemporaryFile(prefix="g10sig-", delete=False) as f:
            f.write(bytes.fromhex(hexpart))
            sigfile = f.name
        try:
            r = _run(["dgst", "-sha256", "-verify", key, "-signature", sigfile], data)
        finally:
            os.unlink(sigfile)
        return r.returncode == 0 and r.stdout.strip() == b"Verified OK"
