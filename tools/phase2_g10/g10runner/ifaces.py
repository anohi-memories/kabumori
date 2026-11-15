"""macOSの実環境に依存する部分のインターフェースとモック。仕様 v5.3 §1〜§5。

本TASKでは、専用macOSユーザー・ACL・Seatbelt・launchd・Max認証・F0 に触れない。
ここにあるのは、境界（インターフェース）と、試験用のモックだけ（実装は NOT_VERIFIED）。
"""


class IsolationVerifier:
    """ISOLATION_VERIFIED（v5 §6-5）の確認。実装なし。"""

    def current_record(self):
        raise NotImplementedError("real isolation verification is not implemented (NOT_VERIFIED)")


class MockIsolationVerifier(IsolationVerifier):
    def __init__(self, valid=True):
        self.valid = valid

    def current_record(self):
        return {"valid": self.valid, "mock": True}


class AuthChecker:
    """`claude auth status` 相当の確認（claude.ai／firstParty／max）。実装なし。"""

    def status(self):
        raise NotImplementedError("real auth check is not implemented (NOT_VERIFIED)")


class MockAuthChecker(AuthChecker):
    def __init__(self, ok=True):
        self.ok = ok

    def status(self):
        if self.ok:
            return {"authMethod": "claude.ai", "apiProvider": "firstParty", "subscriptionType": "max", "mock": True}
        return {"authMethod": "apiKey", "apiProvider": "firstParty", "subscriptionType": None, "mock": True}


def auth_acceptable(status):
    return (status.get("authMethod") == "claude.ai" and status.get("apiProvider") == "firstParty"
            and status.get("subscriptionType") == "max")


class UserPlane:
    """実行プレーン（専用macOSユーザー）の境界。本TASKでは同じユーザーで動くモックだけ。"""

    same_uid_mock = True


class SourcePreparer:
    """作業フォルダの準備（実運用: 認証なしの git 取得と detached checkout）。実装なし。"""

    def prepare(self, work_dir, base_ref, base_sha):
        raise NotImplementedError("real git checkout is not implemented (NOT_VERIFIED)")


class FakeSourcePreparer(SourcePreparer):
    """試験用: 基点を記したファイル1つだけの作業フォルダを作る（ネットワークに触れない）。"""

    def prepare(self, work_dir, base_ref, base_sha):
        import os
        os.makedirs(work_dir, exist_ok=False)
        with open(os.path.join(work_dir, "BASE.txt"), "w", encoding="utf-8") as f:
            f.write("base_ref=%s\nbase_sha=%s\n" % (base_ref, base_sha))
