"""ゲート1（TASK 10）のオフライン試験: 実 GitHub の読み取り専用取得元を、偽の応答（fixture）で検証する。
ネットワークには触れない（opener を差し替える）。"""
import email.utils
import http.client
import json
import os
import socket
import time
import unittest
import urllib.error
from unittest import mock

from g10runner import github_source as gh, issue as issue_mod, policy as policy_mod, signing
from helpers import make_body, test_policy

POLICY = policy_mod.with_digest(test_policy())
BODY = make_body(POLICY)
NOW = 1792800000.0


def issue_json(**over):
    doc = {"number": 323, "repository_url": "https://api.github.com/repos/anohi-memories/kabumori",
           "state": "open", "user": {"login": "anohi-memories"}, "body": BODY,
           "updated_at": "2026-10-23T10:00:00Z"}
    doc.update(over)
    return doc


class FakeResponse:
    def __init__(self, status=200, headers=None, body=None, url=gh.ISSUE_URL, read_exc=None):
        self.status = status
        self.headers = dict(headers or {})
        self._body = body
        self._url = url
        self._read_exc = read_exc

    def read(self, n=-1):
        if self._read_exc:
            raise self._read_exc
        return self._body

    def geturl(self):
        return self._url

    def close(self):
        pass


def ok_headers(raw, **over):
    h = {"Date": email.utils.formatdate(NOW, usegmt=True), "X-RateLimit-Remaining": "59",
         "X-RateLimit-Limit": "60", "Content-Length": str(len(raw))}
    h.update(over)
    return {k: v for k, v in h.items() if v is not None}


def respond(doc=None, raw=None, headers=None, **kw):
    raw = raw if raw is not None else json.dumps(doc if doc is not None else issue_json()).encode("utf-8")
    hdrs = ok_headers(raw, **(headers or {}))
    calls = []

    def opener(req, timeout):
        calls.append(req)
        return FakeResponse(headers=hdrs, body=raw, **kw)
    opener.calls = calls
    return opener


def source(opener, **kw):
    return gh.GitHubIssueSource(enabled=True, opener=opener, now=lambda: NOW, **kw)


class Valid(unittest.TestCase):
    def test_snapshot_fields_and_anonymous_get(self):
        op = respond()
        snap = source(op).fetch(timeout=5)
        self.assertEqual((snap["state"], snap["author"], snap["number"], snap["repo"]),
                         ("OPEN", "anohi-memories", 323, "anohi-memories/kabumori"))
        self.assertEqual(snap["body"], BODY)
        self.assertEqual(snap["editor"], gh.UNKNOWN_EDITOR)
        req = op.calls[0]
        self.assertEqual((req.get_method(), req.full_url), ("GET", gh.ISSUE_URL))
        self.assertIsNone(req.get_header("Authorization"))

    def test_unknown_editor_is_rejected_by_the_evidence_check(self):
        """編集者が分からない本文は、署名つき証拠にしても受け付けない（推測で「未編集」にしない）。"""
        keys = signing.test_keys()
        w = issue_mod.IssueWitness(source(respond()), signing.HmacTestSigner({"witness": keys["witness"]}),
                                   lambda: NOW)
        doc = w.observe("claim", timeout=5)
        reason = issue_mod.check_evidence(doc, signing.HmacTestVerifier(keys), BODY, NOW, 120)
        self.assertEqual(reason, "issue author/editor not trusted")

    def test_environment_tokens_are_never_used(self):
        op = respond()
        with mock.patch.dict(os.environ, {"GH_TOKEN": "x", "GITHUB_TOKEN": "y"}):
            source(op).fetch(timeout=5)
        self.assertIsNone(op.calls[0].get_header("Authorization"))

    def test_disabled_by_default(self):
        with self.assertRaisesRegex(issue_mod.IssueSourceError, "disabled"):
            gh.GitHubIssueSource(opener=respond()).fetch(timeout=5)

    def test_timeout_is_required(self):
        for bad in (None, 0, -1, float("nan"), float("inf"), True):
            with self.subTest(timeout=bad):
                with self.assertRaises(issue_mod.IssueSourceError):
                    source(respond()).fetch(timeout=bad)


class IssueContent(unittest.TestCase):
    def evidence(self, doc, nonce=None, purpose="claim"):
        keys = signing.test_keys()
        w = issue_mod.IssueWitness(source(respond(doc)), signing.HmacTestSigner({"witness": keys["witness"]}),
                                   lambda: NOW)
        return w.observe(purpose, nonce, timeout=5), signing.HmacTestVerifier(keys)

    def test_closed(self):
        snap = source(respond(issue_json(state="closed"))).fetch(timeout=5)
        self.assertEqual(snap["state"], "CLOSED")

    def test_body_changes_do_not_match_the_approved_task(self):
        for old, new in (("- status: ready", "- status: idle"), ("- status: ready", "- status: review_required"),
                         ("- task_id: g10-phase2-test-20261022", "- task_id: g10-phase2-other-20261022")):
            with self.subTest(change=new):
                doc, verifier = self.evidence(issue_json(body=BODY.replace(old, new, 1)))
                reason = issue_mod.check_evidence(doc, verifier, BODY, NOW, 120)
                self.assertIsNotNone(reason)

    def test_generation_change_is_detected(self):
        claim, verifier = self.evidence(issue_json())
        later, _ = self.evidence(issue_json(updated_at="2026-10-23T10:05:00Z"), nonce="monitor:x", purpose="monitor")
        self.assertIn("generation", issue_mod._same_generation(later, claim))

    def test_nonce_mismatch_and_reuse(self):
        doc, verifier = self.evidence(issue_json(), nonce="monitor:a", purpose="monitor")
        self.assertIn("another purpose or run",
                      issue_mod.check_evidence(doc, verifier, BODY, NOW, 120, purpose="monitor", nonce="monitor:b"))
        self.assertIn("another purpose or run",
                      issue_mod.check_evidence(doc, verifier, BODY, NOW, 120, purpose="spawn", nonce="monitor:a"))

    def test_other_issue_repo_or_pull_request(self):
        cases = {"number": issue_json(number=324),
                 "repo": issue_json(repository_url="https://api.github.com/repos/someone/else"),
                 "pull request": issue_json(pull_request={"url": "x"}),
                 "state": issue_json(state="locked"),
                 "author": issue_json(user=None),
                 "body": issue_json(body=None),
                 "updated_at": issue_json(updated_at="2026-10-23 10:00:00")}
        for name, doc in cases.items():
            with self.subTest(case=name):
                with self.assertRaises(issue_mod.IssueSourceError):
                    source(respond(doc)).fetch(timeout=5)


class TransportFailures(unittest.TestCase):
    def assert_fails(self, opener, pattern=None):
        with self.assertRaises(issue_mod.IssueSourceError) as cm:
            source(opener).fetch(timeout=5)
        if pattern:
            self.assertRegex(str(cm.exception), pattern)
        return str(cm.exception)

    def test_http_errors(self):
        for code in (403, 404, 429, 500, 502, 503):
            with self.subTest(code=code):
                def opener(req, timeout, c=code):
                    raise urllib.error.HTTPError(gh.ISSUE_URL, c, "err", {}, None)
                self.assert_fails(opener, "github http error %d" % code)

    def test_non_200_status(self):
        for status in (201, 204, 304):
            with self.subTest(status=status):
                self.assert_fails(respond(status=status), "status")

    def test_rate_limit_exhausted(self):
        self.assert_fails(respond(headers={"X-RateLimit-Remaining": "0"}), "rate limit")

    def test_date_header_missing_or_skewed(self):
        self.assert_fails(respond(headers={"Date": None}), "Date")
        self.assert_fails(respond(headers={"Date": "not a date"}), "Date")
        self.assert_fails(respond(headers={"Date": email.utils.formatdate(NOW - 301, usegmt=True)}), "skew")
        self.assert_fails(respond(headers={"Date": email.utils.formatdate(NOW + 301, usegmt=True)}), "skew")
        source(respond(headers={"Date": email.utils.formatdate(NOW - 299, usegmt=True)})).fetch(timeout=5)

    def test_timeout_and_disconnect(self):
        detail = "secret-detail-7f3a"  # 例外の本文は理由に出さない
        for exc in (socket.timeout(detail), ConnectionResetError(detail), urllib.error.URLError(detail)):
            with self.subTest(exc=type(exc).__name__):
                def opener(req, timeout, e=exc):
                    raise e
                msg = self.assert_fails(opener, "fetch failed")
                self.assertNotIn(detail, msg)

    def test_invalid_json_nan_and_partial(self):
        self.assert_fails(respond(raw=b"{not json"), "not valid JSON")
        self.assert_fails(respond(raw=json.dumps(issue_json()).encode().replace(b'"number": 323', b'"number": NaN')),
                          "not valid JSON")
        raw = json.dumps(issue_json()).encode()
        self.assert_fails(respond(raw=raw, headers={"Content-Length": str(len(raw) + 10)}), "partial")
        self.assert_fails(respond(read_exc=http.client.IncompleteRead(b"{")), "read failed")
        self.assert_fails(respond(raw=b"[]"), "not an object")

    def test_redirect_and_unexpected_url(self):
        self.assert_fails(respond(url="https://api.github.com/repos/someone/else/issues/323"), "unexpected url")
        handler = gh._NoRedirect()
        with self.assertRaises(urllib.error.HTTPError):
            handler.redirect_request(gh.GitHubIssueSource(enabled=True)._request(), None, 301, "moved",
                                     {}, "https://evil.example/")


class RequestBoundaries(unittest.TestCase):
    def test_only_issue_323_of_this_repo(self):
        with self.assertRaises(ValueError):
            gh.GitHubIssueSource(repo="someone/else")
        with self.assertRaises(ValueError):
            gh.GitHubIssueSource(number=324)

    def test_only_https_get_to_the_api_host(self):
        s = gh.GitHubIssueSource(enabled=True)
        with self.assertRaises(ValueError):
            s._request("POST")
        req = s._request()
        self.assertEqual((req.get_method(), req.host, req.type), ("GET", "api.github.com", "https"))

    def test_token_scope_rules(self):
        op = respond(headers={"X-OAuth-Scopes": "repo, workflow"})
        with self.assertRaisesRegex(issue_mod.IssueSourceError, "only a no-scope"):
            source(op, token="t0ken").fetch(timeout=5)
        with self.assertRaisesRegex(issue_mod.IssueSourceError, "fine-grained"):
            source(respond(), token="t0ken").fetch(timeout=5)
        op = respond(headers={"X-OAuth-Scopes": ""})
        source(op, token="t0ken").fetch(timeout=5)
        self.assertEqual(op.calls[0].get_header("Authorization"), "Bearer t0ken")
        self.assertNotIn("t0ken", repr(source(op, token="t0ken")))
