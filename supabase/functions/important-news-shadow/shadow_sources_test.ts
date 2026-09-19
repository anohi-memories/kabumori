import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchSource,
  isSourceCooldown,
  parseGdelt,
  parseRss,
  type ShadowSource,
} from "./shadow_sources.ts";

const now = new Date("2026-09-20T12:00:00Z");
const rssSource: ShadowSource = {
  key: "fed",
  url: "https://example.gov/feed.xml",
  topic: "macro:fed",
  category: "frb",
  kind: "rss",
};

test("RSS parser records fresh entries but distinguishes a healthy empty feed", () => {
  const xml =
    `<rss><channel><item><title>Federal Reserve emergency statement</title><link>https://example.gov/release/1</link><description>Details</description><pubDate>Sun, 20 Sep 2026 11:00:00 GMT</pubDate></item></channel></rss>`;
  assert.equal(parseRss(rssSource, xml, now).length, 1);
  assert.deepEqual(
    parseRss(rssSource, "<rss><channel></channel></rss>", now),
    [],
  );
  const stale = xml.replace("20 Sep 2026", "10 Sep 2026");
  assert.deepEqual(parseRss(rssSource, stale, now), []);
});

test("GDELT compact timestamps normalize and stale/malformed rows are rejected", () => {
  const source: ShadowSource = {
    key: "gdelt",
    url: "https://api.gdeltproject.org",
    topic: "world:gdelt",
    category: "geopolitics",
    kind: "gdelt",
  };
  const rows = parseGdelt(source, {
    articles: [
      {
        title: "Ceasefire announced",
        url: "https://news.example/a",
        seendate: "20260920T110000Z",
      },
      {
        title: "Bad URL",
        url: "http://news.example/b",
        seendate: "20260920T110000Z",
      },
    ],
  }, now);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].publishedAt, "2026-09-20T11:00:00.000Z");
});

test("fetcher reports non-2xx separately from a healthy zero-result source", async () => {
  await assert.rejects(
    () =>
      fetchSource(
        rssSource,
        async () => new Response("down", { status: 503 }),
        now,
      ),
    /SOURCE_HTTP_503/,
  );
  assert.deepEqual(
    await fetchSource(
      rssSource,
      async () => new Response("<rss><channel/></rss>", { status: 200 }),
      now,
    ),
    [],
  );
});

test("GDELT has a deterministic one-hour polling cooldown", () => {
  const source: ShadowSource = {
    key: "gdelt",
    url: "https://api.gdeltproject.org",
    topic: "world:gdelt",
    category: "other_market_moving",
    kind: "gdelt",
  };
  const first = isSourceCooldown(source, new Date("2026-09-20T12:00:00Z"));
  const second = isSourceCooldown(source, new Date("2026-09-20T12:30:00Z"));
  assert.notEqual(first, second);
  assert.equal(isSourceCooldown(rssSource, now), false);
});
