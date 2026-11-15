"""H2 第9TASK（C2）の反例の固定。修正前HEAD（0e527493）では失敗し、修正後に通ることを確認する。

- R1: GraphQL の provenance の項目が「無い」のを「null」と同じに扱い、編集者の根拠が欠けた・矛盾した応答から
  editor＝None（未編集）／信頼済みを作ってしまう（署名した証拠が check_evidence を通る）。
- R2: RateBudget の判定と枠の予約が一体でなく、同じ予算を共有する同時の呼び出しが残り1枠を両方とも取れる。

すべて合成の fixture（実 token・API は使わない）。修正前のコードでも動くように、振る舞いだけを使う。
"""
import threading
import unittest

from g10runner import github_graphql as gq, issue as issue_mod, rate_budget as rb, signing
from test_github_auth_budget import (BODY, NOW, TOKEN, TRUSTED, Script, edited, graphql_resp, issue_node,
                                     rate_limit_resp)


def evidence_reason(issue):
    keys = signing.test_keys()
    s = gq.GitHubGraphQLIssueSource(TOKEN, enabled=True, opener=Script(rate_limit_resp(), graphql_resp(issue=issue)),
                                    now=lambda: NOW)
    s.verify_token()
    w = issue_mod.IssueWitness(s, signing.HmacTestSigner({"witness": keys["witness"]}), lambda: NOW)
    try:
        doc = w.observe("claim", timeout=5)
    except issue_mod.IssueSourceError as exc:
        return "fetch failed: %s" % exc  # 安全な取得失敗（修正後の許容される結果）
    return issue_mod.check_evidence(doc, signing.HmacTestVerifier(keys), BODY, NOW, 120)


class R1MissingProvenance(unittest.TestCase):
    def test_missing_editor_and_last_edited_fields_are_not_never_edited(self):
        issue = issue_node()
        del issue["editor"]
        del issue["lastEditedAt"]
        self.assertIsNotNone(evidence_reason(issue), "missing provenance fields were treated as 'never edited'")

    def test_missing_deleted_at_is_not_an_undeleted_revision(self):
        issue = edited(TRUSTED)
        del issue["userContentEdits"]["nodes"][0]["deletedAt"]
        self.assertIsNotNone(evidence_reason(issue), "a revision without deletedAt was treated as not deleted")

    def test_includes_created_edit_with_an_empty_history_is_inconsistent(self):
        self.assertIsNotNone(evidence_reason(issue_node(includesCreatedEdit=True)),
                             "includesCreatedEdit=True with an empty history was treated as 'never edited'")


class R2ConcurrentReservation(unittest.TestCase):
    def test_two_threads_cannot_take_the_last_slot(self):
        budget = rb.RateBudget(3, reserve_fraction=0)  # 予備は最小1 → 許容2
        budget.before_request(NOW)  # 残り1枠
        barrier = threading.Barrier(2, timeout=1.0)

        class RacingList(list):
            def append(self, item):  # 判定を通った直後・予約の直前で、2つのスレッドを待ち合わせる
                try:
                    barrier.wait()
                except threading.BrokenBarrierError:
                    pass  # もう一方が判定と予約の一体の区間に入れない（直列化されている）
                super().append(item)

        budget.sent = RacingList(budget.sent)
        # 古さの切り捨てを、同じ RacingList のまま行う（判定・値・規則は変えない）
        budget._prune = lambda now: list.__init__(budget.sent, [t for t in budget.sent if now - t < 3600.0])
        results = []

        def call():
            try:
                budget.before_request(NOW + 1)
                results.append("accepted")
            except rb.RateLimited:
                results.append("rejected")
        threads = [threading.Thread(target=call) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(10)
        self.assertEqual(sorted(results), ["accepted", "rejected"], "both threads took the last slot")
        self.assertEqual(len(budget.sent), 2)


class R1ProvenanceBoundaries(unittest.TestCase):
    """修正後の境界（新しい規則）: 項目の有無・型・includesCreatedEdit との整合。"""

    def test_unknown_cases(self):
        def without_node_field(field):
            issue = edited(TRUSTED)
            del issue["userContentEdits"]["nodes"][0][field]
            return issue
        no_count = issue_node()
        del no_count["userContentEdits"]["totalCount"]
        cases = {
            "node without editedAt": without_node_field("editedAt"),
            "node without editor": without_node_field("editor"),
            "includesCreatedEdit missing": {k: v for k, v in issue_node().items() if k != "includesCreatedEdit"},
            "userContentEdits missing": {k: v for k, v in issue_node().items() if k != "userContentEdits"},
            "totalCount missing": no_count,
            "includesCreatedEdit not bool": issue_node(includesCreatedEdit="false"),
            "editor not an actor": issue_node(editor="anohi-memories"),
            "lastEditedAt not a string": issue_node(lastEditedAt=0),
            "created edit with a single entry": dict(edited(TRUSTED), includesCreatedEdit=True),
            "created edit with an empty history": issue_node(includesCreatedEdit=True),
        }
        for name, issue in cases.items():
            with self.subTest(case=name):
                self.assertEqual(gq.determine_editor(issue)[0], gq.UNKNOWN_EDITOR)
                self.assertIsNotNone(evidence_reason(issue))

    def test_created_edit_with_real_edits_by_the_trusted_account(self):
        issue = dict(edited(TRUSTED, TRUSTED), includesCreatedEdit=True)
        self.assertEqual(gq.determine_editor(issue)[0], TRUSTED)
        self.assertIsNone(evidence_reason(issue))

    def test_never_edited_still_passes(self):
        self.assertEqual(gq.determine_editor(issue_node())[0], None)
        self.assertIsNone(evidence_reason(issue_node()))


class R2ManyThreads(unittest.TestCase):
    def test_many_threads_take_exactly_the_allowed_slots(self):
        budget = rb.RateBudget(10, reserve_fraction=0)  # 予備は最小1 → 許容9
        start = threading.Event()
        results = []
        lock = threading.Lock()

        def call():
            start.wait(5)
            try:
                budget.before_request(NOW)
                outcome = "accepted"
            except rb.RateLimited:
                outcome = "rejected"
            with lock:
                results.append(outcome)
        threads = [threading.Thread(target=call) for _ in range(32)]
        for t in threads:
            t.start()
        start.set()
        for t in threads:
            t.join(10)
        self.assertEqual(results.count("accepted"), 9)
        self.assertEqual(len(budget.sent), 9)
