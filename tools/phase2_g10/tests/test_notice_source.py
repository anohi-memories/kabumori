"""notice_source（#639 コメントの匿名取得）の試験。応答は untrusted data として検証・フィルタする。"""
import json
import unittest

from g10runner import notice_source
from test_github_source import FakeResponse, ok_headers, NOW


def opener_for(raw, url):
    def opener(req, timeout):
        return FakeResponse(headers=ok_headers(raw), body=raw, url=url)
    return opener


class FetchComments(unittest.TestCase):
    def test_parses_and_filters_bad_entries(self):
        url = notice_source.comments_url()
        docs = [{"id": 5, "created_at": "2026-11-04T00:00:00Z", "body": "slot=G10 x=1"},
                {"id": "bad", "body": "x"},        # id が int でない → 除外
                {"created_at": "t", "body": "x"},  # id 無し → 除外
                "junk"]                            # dict でない → 除外
        raw = json.dumps(docs).encode("utf-8")
        cs = notice_source.fetch_comments(opener=opener_for(raw, url), now=NOW)
        self.assertEqual([c["id"] for c in cs], [5])
        self.assertEqual(cs[0]["body"], "slot=G10 x=1")

    def test_non_list_response_is_rejected(self):
        url = notice_source.comments_url()
        raw = json.dumps({"message": "Not Found"}).encode("utf-8")  # GitHub のエラーは dict
        with self.assertRaises(notice_source.NoticeSourceError):
            notice_source.fetch_comments(opener=opener_for(raw, url), now=NOW)

    def test_since_is_added_to_url(self):
        self.assertIn("since=2026-11-04T00%3A00%3A00Z", notice_source.comments_url(since="2026-11-04T00:00:00Z"))


if __name__ == "__main__":
    unittest.main()
