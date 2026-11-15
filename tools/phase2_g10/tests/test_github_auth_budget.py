"""ゲート1追加（TASK 11）のオフライン試験: token の送信前の判定と事前確認、GraphQL の編集者の根拠、回数の予算。
ネットワークには触れない（opener を差し替える）。"""
import copy
import email.utils
import json
import unittest
import urllib.error

from g10runner import github_graphql as gq, github_source as gh, issue as issue_mod, policy as policy_mod
from g10runner import rate_budget as rb, signing
from helpers import make_body, test_policy

POLICY = policy_mod.with_digest(test_policy())
BODY = make_body(POLICY)
NOW = 1792800000.0
TOKEN = "ghp_" + "A" * 36
TRUSTED = issue_mod.TRUSTED_LOGIN


class Resp:
    def __init__(self, status=200, headers=None, body=b"", url=gh.ISSUE_URL):
        self.status, self.headers, self._body, self._url = status, dict(headers or {}), body, url

    def read(self, n=-1):
        return self._body

    def geturl(self):
        return self._url

    def close(self):
        pass


def hdrs(raw=b"", **over):
    h = {"Date": email.utils.formatdate(NOW, usegmt=True), "X-RateLimit-Remaining": "4999",
         "X-RateLimit-Limit": "5000", "X-RateLimit-Reset": str(int(NOW + 3600)), "X-OAuth-Scopes": "",
         "Content-Length": str(len(raw))}
    h.update(over)
    return {k: v for k, v in h.items() if v is not None}


class Script:
    """呼ばれた順に応答（Resp か例外）を返す opener。呼ばれた回数・要求を記録する。"""

    def __init__(self, *steps):
        self.steps = list(steps)
        self.calls = []

    def __call__(self, req, timeout):
        self.calls.append(req)
        step = self.steps.pop(0)
        if isinstance(step, Exception):
            raise step
        return step


def rate_limit_resp(**over):
    raw = json.dumps({"resources": {"core": {"limit": 5000, "remaining": 4999},
                                    "graphql": {"limit": 5000, "remaining": 5000}}}).encode()
    return Resp(headers=hdrs(raw, **over), body=raw, url=gh.RATE_LIMIT_URL)


def rest_resp(etag='"abc"', **over):
    raw = json.dumps({"number": 323, "repository_url": "https://api.github.com/repos/anohi-memories/kabumori",
                      "state": "open", "user": {"login": TRUSTED}, "body": BODY,
                      "updated_at": "2026-10-23T10:00:00Z"}).encode()
    h = hdrs(raw, **over)
    if etag:
        h["ETag"] = etag
    return Resp(headers=h, body=raw)


def issue_node(**over):
    node = {"number": 323, "state": "OPEN", "body": BODY, "updatedAt": "2026-10-23T10:00:00Z",
            "lastEditedAt": None, "includesCreatedEdit": False, "author": {"login": TRUSTED}, "editor": None,
            "userContentEdits": {"totalCount": 0, "nodes": []}}
    node.update(over)
    return node


def edited(*editors, last=None, deleted=False):
    nodes = [{"editedAt": "2026-10-23T09:%02d:00Z" % i, "deletedAt": "2026-10-23T09:59:00Z" if deleted else None,
              "editor": {"login": e} if e else None} for i, e in enumerate(editors)]
    return issue_node(lastEditedAt=last or nodes[-1]["editedAt"], editor={"login": editors[-1]} if editors[-1] else None,
                      userContentEdits={"totalCount": len(nodes), "nodes": nodes})


def graphql_resp(issue=None, repo=issue_mod.REPO, errors=None, **over):
    doc = {"data": {"repository": {"nameWithOwner": repo, "issue": issue if issue is not None else issue_node()}}}
    if errors:
        doc["errors"] = errors
    raw = json.dumps(doc).encode()
    return Resp(headers=hdrs(raw, **over), body=raw, url=gq.GRAPHQL_URL)


class TokenBeforeSending(unittest.TestCase):
    def test_non_classic_tokens_are_refused_before_any_request(self):
        for bad in ("gho_" + "A" * 36, "github_pat_" + "A" * 60, "ghs_" + "A" * 36, "ghu_" + "A" * 36,
                    "ghp_short", "ghp_" + "A" * 36 + "\n", "", 123):
            with self.subTest(token=str(bad)[:12]):
                op = Script()
                with self.assertRaises(ValueError):
                    gh.GitHubIssueSource(enabled=True, token=bad, opener=op)
                with self.assertRaises(ValueError):
                    gq.GitHubGraphQLIssueSource(bad, enabled=True, opener=op)
                self.assertEqual(op.calls, [])  # 1回も送っていない

    def test_graphql_requires_a_token(self):
        with self.assertRaises(ValueError):
            gq.GitHubGraphQLIssueSource(None)

    def test_fetch_before_verification_sends_nothing(self):
        op = Script()
        with self.assertRaisesRegex(issue_mod.IssueSourceError, "not been verified"):
            gh.GitHubIssueSource(enabled=True, token=TOKEN, opener=op, now=lambda: NOW).fetch(timeout=5)
        with self.assertRaisesRegex(issue_mod.IssueSourceError, "not been verified"):
            gq.GitHubGraphQLIssueSource(TOKEN, enabled=True, opener=op, now=lambda: NOW).fetch(timeout=5)
        self.assertEqual(op.calls, [])

    def test_verification_uses_only_get_rate_limit_and_requires_empty_scopes(self):
        op = Script(rate_limit_resp())
        meta = gh.verify_token(TOKEN, op, 5, lambda: NOW)
        self.assertEqual((op.calls[0].get_method(), op.calls[0].full_url), ("GET", gh.RATE_LIMIT_URL))
        self.assertEqual(meta["limits"]["graphql"], (5000, 5000))
        for over, pattern in (({"X-OAuth-Scopes": "repo"}, "only a no-scope"),
                              ({"X-OAuth-Scopes": "public_repo"}, "only a no-scope"),
                              ({"X-OAuth-Scopes": None}, "fine-grained")):
            with self.subTest(headers=over):
                with self.assertRaisesRegex(issue_mod.IssueSourceError, pattern):
                    gh.verify_token(TOKEN, Script(rate_limit_resp(**over)), 5, lambda: NOW)
        with self.assertRaisesRegex(issue_mod.IssueSourceError, "http error 401"):
            gh.verify_token(TOKEN, Script(urllib.error.HTTPError(gh.RATE_LIMIT_URL, 401, "x", {}, None)), 5,
                            lambda: NOW)

    def test_verified_rest_source_sends_the_token_and_rechecks_scopes(self):
        op = Script(rate_limit_resp(), rest_resp(), rest_resp(**{"X-OAuth-Scopes": "repo"}))
        s = gh.GitHubIssueSource(enabled=True, token=TOKEN, opener=op, now=lambda: NOW, conditional=False)
        s.verify_token()
        self.assertEqual(s.fetch(timeout=5)["state"], "OPEN")
        self.assertEqual(op.calls[1].get_header("Authorization"), "Bearer " + TOKEN)
        with self.assertRaisesRegex(issue_mod.IssueSourceError, "only a no-scope"):
            s.fetch(timeout=5)


class ConditionalGet(unittest.TestCase):
    def test_not_modified_reuses_the_previous_snapshot(self):
        not_mod = urllib.error.HTTPError(gh.ISSUE_URL, 304, "nm", hdrs(ETag='"abc"'), None)
        op = Script(rest_resp(), not_mod)
        s = gh.GitHubIssueSource(enabled=True, opener=op, now=lambda: NOW)
        first = s.fetch(timeout=5)
        second = s.fetch(timeout=5)
        self.assertEqual(op.calls[1].get_header("If-none-match"), '"abc"')
        self.assertEqual(first, second)
        self.assertTrue(s.last_meta.get("not_modified"))

    def test_not_modified_with_another_etag_or_without_cache_fails(self):
        op = Script(rest_resp(), urllib.error.HTTPError(gh.ISSUE_URL, 304, "nm", hdrs(ETag='"zzz"'), None))
        s = gh.GitHubIssueSource(enabled=True, opener=op, now=lambda: NOW)
        s.fetch(timeout=5)
        with self.assertRaisesRegex(issue_mod.IssueSourceError, "different ETag"):
            s.fetch(timeout=5)
        op = Script(urllib.error.HTTPError(gh.ISSUE_URL, 304, "nm", hdrs(ETag='"abc"'), None))
        with self.assertRaisesRegex(issue_mod.IssueSourceError, "http error 304"):
            gh.GitHubIssueSource(enabled=True, opener=op, now=lambda: NOW).fetch(timeout=5)

    def test_not_modified_still_checks_the_date(self):
        stale = urllib.error.HTTPError(gh.ISSUE_URL, 304, "nm",
                                       hdrs(ETag='"abc"', Date=email.utils.formatdate(NOW - 900, usegmt=True)), None)
        s = gh.GitHubIssueSource(enabled=True, opener=Script(rest_resp(), stale), now=lambda: NOW)
        s.fetch(timeout=5)
        with self.assertRaisesRegex(issue_mod.IssueSourceError, "skew"):
            s.fetch(timeout=5)


class RateLimitHandling(unittest.TestCase):
    def test_429_blocks_the_budget_and_no_request_is_sent_until_retry_after(self):
        clock = {"t": NOW}
        budget = rb.RateBudget(60, now=lambda: clock["t"])
        op = Script(urllib.error.HTTPError(gh.ISSUE_URL, 429, "x", {"Retry-After": "120"}, None), rest_resp())
        s = gh.GitHubIssueSource(enabled=True, opener=op, now=lambda: clock["t"], budget=budget)
        with self.assertRaises(gh.RateLimited) as cm:
            s.fetch(timeout=5)
        self.assertEqual(cm.exception.retry_after, 120.0)
        clock["t"] += 60
        with self.assertRaisesRegex(gh.RateLimited, "backing off"):
            s.fetch(timeout=5)
        self.assertEqual(len(op.calls), 1)  # 待つ間は送らない
        clock["t"] += 61
        self.assertEqual(s.fetch(timeout=5)["state"], "OPEN")

    def test_secondary_limit_403_with_retry_after(self):
        op = Script(urllib.error.HTTPError(gq.GRAPHQL_URL, 403, "x", {"Retry-After": "30"}, None))
        s = gq.GitHubGraphQLIssueSource(TOKEN, enabled=True, opener=op, now=lambda: NOW)
        s._token_verified = True
        with self.assertRaises(gh.RateLimited) as cm:
            s.fetch(timeout=5)
        self.assertEqual(cm.exception.retry_after, 30.0)

    def test_remaining_zero_is_rate_limited(self):
        s = gh.GitHubIssueSource(enabled=True, opener=Script(rest_resp(**{"X-RateLimit-Remaining": "0"})),
                                 now=lambda: NOW)
        with self.assertRaises(gh.RateLimited):
            s.fetch(timeout=5)


class RuntimeBudget(unittest.TestCase):
    def test_local_hourly_budget_and_sliding_window(self):
        b = rb.RateBudget(10, reserve_fraction=0.2)
        for i in range(8):
            b.before_request(NOW + i)
        with self.assertRaisesRegex(gh.RateLimited, "local hourly"):
            b.before_request(NOW + 9)
        b.before_request(NOW + 3600.5)  # 1時間前の送信が窓から外れる

    def test_server_remaining_at_the_reserve(self):
        b = rb.RateBudget(5000)
        b.observe({"X-RateLimit-Remaining": "900", "X-RateLimit-Reset": str(int(NOW + 600))}, NOW)
        with self.assertRaisesRegex(gh.RateLimited, "server remaining"):
            b.before_request(NOW)
        b.before_request(NOW + 601)  # リセットの後は送れる

    def test_retry_after_blocks(self):
        b = rb.RateBudget(60)
        b.observe({"Retry-After": "10"}, NOW)
        with self.assertRaisesRegex(gh.RateLimited, "backing off"):
            b.before_request(NOW + 5)
        b.before_request(NOW + 10.5)

    def test_invalid_construction(self):
        for bad in (0, -1, 1.5, True):
            with self.subTest(limit=bad):
                with self.assertRaises(ValueError):
                    rb.RateBudget(bad)


class BudgetPlan(unittest.TestCase):
    def policy(self, interval, concurrent=1, max_starts=10, window=600):
        p = copy.deepcopy(policy_mod.DEFAULT_POLICY)
        p["timing"]["issue_monitor_interval"] = float(interval)
        p["max_concurrent"] = concurrent
        p["rate_guard"] = {"window_seconds": window, "max_starts": max_starts}
        return policy_mod.with_digest(p)

    def test_anonymous_is_never_enough_for_the_default_policy(self):
        for interval in (5, 30, 60, 600, 3600):
            with self.subTest(interval=interval):
                self.assertIsNotNone(rb.check(self.policy(interval), "anonymous", 30))
        self.assertIsNone(rb.min_monitor_interval(self.policy(5), "anonymous", 30))

    def test_token_budgets(self):
        self.assertIsNone(rb.check(self.policy(30), "token", 30))
        self.assertIsNone(rb.check(self.policy(30), "token", 30, api="graphql"))
        w = rb.worst_case(self.policy(30), "token", 30, api="graphql")
        self.assertEqual(round(w["consumed_per_hour"]), 840)
        self.assertIsNotNone(rb.check(self.policy(1), "token", 1, api="graphql"))  # 1秒間隔は収まらない

    def test_s2_and_concurrency_are_counted(self):
        base = rb.worst_case(self.policy(30), "token", 30)["fetches_per_hour"]
        self.assertGreater(rb.worst_case(self.policy(30), "token", 10)["fetches_per_hour"], base)  # S2 の周期
        self.assertGreater(rb.worst_case(self.policy(30, concurrent=2), "token", 30)["fetches_per_hour"], base)
        self.assertEqual(rb.worst_case(self.policy(30), "token", 30)["fixed_per_hour"], 180)

    def test_min_interval_is_within_budget(self):
        iv = rb.min_monitor_interval(self.policy(5), "token", 30, api="graphql")
        self.assertIsNone(rb.check(self.policy(iv * 1.01), "token", 30, api="graphql"))
        self.assertIsNotNone(rb.check(self.policy(iv * 0.9), "token", 30, api="graphql"))


class EditorProvenance(unittest.TestCase):
    def test_never_edited(self):
        self.assertEqual(gq.determine_editor(issue_node())[0], None)

    def test_all_edits_by_the_trusted_account(self):
        editor, basis = gq.determine_editor(edited(TRUSTED, TRUSTED))
        self.assertEqual(editor, TRUSTED)
        self.assertIn("all 2 edits", basis)

    def test_unknown_cases(self):
        cases = {
            "untrusted edit": edited(TRUSTED, "someone-else", TRUSTED),
            "untrusted last editor": edited("someone-else"),
            "missing editor actor": edited(TRUSTED, None),
            "deleted revision": edited(TRUSTED, deleted=True),
            "lastEditedAt mismatch": edited(TRUSTED, last="2026-10-23T11:00:00Z"),
            "incomplete history": issue_node(lastEditedAt="2026-10-23T09:00:00Z", editor={"login": TRUSTED},
                                             userContentEdits={"totalCount": 101, "nodes": edited(TRUSTED)[
                                                 "userContentEdits"]["nodes"]}),
            "count mismatch": issue_node(lastEditedAt="2026-10-23T09:00:00Z", editor={"login": TRUSTED},
                                         userContentEdits={"totalCount": 2, "nodes": edited(TRUSTED)[
                                             "userContentEdits"]["nodes"]}),
            "edit markers without history": issue_node(lastEditedAt="2026-10-23T09:00:00Z"),
            "editor without history": issue_node(editor={"login": TRUSTED}),
            "history missing": issue_node(userContentEdits=None),
            "malformed count": issue_node(userContentEdits={"totalCount": "0", "nodes": []}),
            "malformed node": issue_node(lastEditedAt="2026-10-23T09:00:00Z", editor={"login": TRUSTED},
                                         userContentEdits={"totalCount": 1, "nodes": ["x"]}),
        }
        for name, issue in cases.items():
            with self.subTest(case=name):
                self.assertEqual(gq.determine_editor(issue)[0], gq.UNKNOWN_EDITOR)


class GraphQLSource(unittest.TestCase):
    def source(self, *steps):
        op = Script(*steps)
        s = gq.GitHubGraphQLIssueSource(TOKEN, enabled=True, opener=op, now=lambda: NOW)
        s._token_verified = True  # 事前確認は TokenBeforeSending で試験
        return s, op

    def test_fixed_query_only(self):
        s, op = self.source(graphql_resp())
        s.fetch(timeout=5)
        req = op.calls[0]
        self.assertEqual((req.get_method(), req.full_url, req.data), ("POST", gq.GRAPHQL_URL, gq.FIXED_PAYLOAD))
        with self.assertRaises(ValueError):
            s._request(payload=b'{"query":"mutation { x }"}')
        with self.assertRaises(ValueError):
            s._request(method="GET")
        self.assertNotIn("mutation", gq.FIXED_QUERY)
        self.assertTrue(gq.FIXED_QUERY.startswith("query "))

    def test_disabled_by_default(self):
        s = gq.GitHubGraphQLIssueSource(TOKEN, opener=Script())
        with self.assertRaisesRegex(issue_mod.IssueSourceError, "disabled"):
            s.fetch(timeout=5)

    def test_response_validation(self):
        cases = {"errors": graphql_resp(errors=[{"message": "x"}]),
                 "other repo": graphql_resp(repo="someone/else"),
                 "other issue": graphql_resp(issue=issue_node(number=324)),
                 "state": graphql_resp(issue=issue_node(state="LOCKED")),
                 "author": graphql_resp(issue=issue_node(author=None)),
                 "body": graphql_resp(issue=issue_node(body=None)),
                 "updatedAt": graphql_resp(issue=issue_node(updatedAt="yesterday")),
                 "skew": graphql_resp(Date=email.utils.formatdate(NOW + 400, usegmt=True)),
                 "rate": graphql_resp(**{"X-RateLimit-Remaining": "0"}),
                 "scopes": graphql_resp(**{"X-OAuth-Scopes": "repo"})}
        for name, resp in cases.items():
            with self.subTest(case=name):
                s, _ = self.source(resp)
                with self.assertRaises(issue_mod.IssueSourceError):
                    s.fetch(timeout=5)

    def test_unexpected_url(self):
        resp = graphql_resp()
        resp._url = "https://evil.example/graphql"
        s, _ = self.source(resp)
        with self.assertRaisesRegex(issue_mod.IssueSourceError, "unexpected url"):
            s.fetch(timeout=5)

    def test_evidence_passes_only_with_an_established_editor(self):
        keys = signing.test_keys()
        verifier = signing.HmacTestVerifier(keys)
        for issue, ok in ((issue_node(), True), (edited(TRUSTED), True), (edited("someone-else"), False),
                          (edited(TRUSTED, deleted=True), False)):
            with self.subTest(editor=issue.get("editor")):
                s, _ = self.source(graphql_resp(issue=issue))
                w = issue_mod.IssueWitness(s, signing.HmacTestSigner({"witness": keys["witness"]}), lambda: NOW)
                reason = issue_mod.check_evidence(w.observe("claim", timeout=5), verifier, BODY, NOW, 120)
                self.assertEqual(reason is None, ok, reason)
