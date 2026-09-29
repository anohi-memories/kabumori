import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeUrl,
  isFuture,
  normalizeTitle,
  parseTimestamp,
  truncateHint,
  urlDedupeKey,
} from "./normalize.ts";
import { parseEdinetDocuments, parseFederalRegister, parseFeed, parseGdeltDoc } from "./parsers.ts";

test("canonical URL drops tracking params, fragments, default ports and trailing slash; sorts params", () => {
  assert.equal(
    canonicalizeUrl("https://WWW.Example.com:443/a/b/?utm_source=rss&b=2&a=1&at_medium=RSS&fbclid=x#top"),
    "https://www.example.com/a/b?a=1&b=2",
  );
  assert.equal(canonicalizeUrl("/pressroom/releases/press592.php", "https://www.eia.gov/rss/press_rss.xml"),
    "https://www.eia.gov/pressroom/releases/press592.php");
  assert.equal(canonicalizeUrl("javascript:alert(1)"), null);
  assert.equal(canonicalizeUrl("not a url"), null);
});

test("dedupe key ignores scheme and www", () => {
  assert.equal(
    urlDedupeKey(canonicalizeUrl("http://www.boj.or.jp/a.pdf")!),
    urlDedupeKey(canonicalizeUrl("https://boj.or.jp/a.pdf?utm_campaign=x")!),
  );
});

test("title normalization is width/punctuation insensitive and strips publisher suffixes", () => {
  assert.equal(normalizeTitle("日銀、利上げを決定"), normalizeTitle("日銀 利上げを決定"));
  assert.equal(normalizeTitle("ＦＲＢが利下げ（０．２５％）"), normalizeTitle("FRBが利下げ(0.25%)"));
  assert.equal(
    normalizeTitle("Oil jumps as Hormuz tensions rise - Example News"),
    normalizeTitle("Oil jumps as Hormuz tensions rise | Another Wire"),
  );
  assert.equal(normalizeTitle("Q&A - 2026"), "qa2026"); // short titles keep their suffix
});

test("timestamps are parsed without invention", () => {
  assert.deepEqual(parseTimestamp("Wed, 17 Sep 2026 18:00:00 GMT"), { iso: "2026-09-17T18:00:00.000Z", precision: "datetime" });
  assert.deepEqual(parseTimestamp("2026-09-28T14:13:00+09:00"), { iso: "2026-09-28T05:13:00.000Z", precision: "datetime" });
  assert.deepEqual(parseTimestamp("2026-09-24"), { iso: "2026-09-24", precision: "date" });
  assert.deepEqual(parseTimestamp("20260928T051500Z"), { iso: "2026-09-28T05:15:00.000Z", precision: "datetime" });
  assert.equal(parseTimestamp("2026-09-28T14:13:00"), null, "no zone -> refuse, do not assume UTC");
  assert.equal(parseTimestamp("yesterday"), null);
  // 金融庁 writes the zone as "JST" (live feed 2026-09-28).
  assert.deepEqual(parseTimestamp("Mon, 28 Sep 2026 16:00:00 JST"), { iso: "2026-09-28T07:00:00.000Z", precision: "datetime" });
  assert.equal(parseTimestamp(null), null);
  const now = new Date("2026-09-28T05:00:00Z");
  assert.equal(isFuture(parseTimestamp("2026-09-28T10:08:00Z"), now), true);
  assert.equal(isFuture(parseTimestamp("2026-09-28T05:30:00Z"), now), false);
});

test("summary hints are bounded and Unicode-safe", () => {
  const long = "株価".repeat(300);
  const hint = truncateHint(long)!;
  assert.equal([...hint].length, 280);
  assert.ok(hint.endsWith("…"));
  assert.equal(truncateHint("   "), null);
});

test("RSS 2.0 with published date, CDATA, entities and media thumbnail", () => {
  const body = `<?xml version="1.0"?><rss xmlns:media="http://search.yahoo.com/mrss/"><channel>
<item><title><![CDATA[財務省、国債発行計画を公表 &amp; 説明]]></title><link>https://www.mof.go.jp/a.html</link>
<guid isPermaLink="false">mof-1</guid><pubDate>Sun, 28 Sep 2026 03:00:00 +0000</pubDate>
<description>&lt;p&gt;令和8年度の&lt;b&gt;発行計画&lt;/b&gt;&lt;/p&gt;</description>
<media:thumbnail url="https://www.mof.go.jp/img/t.jpg"/></item></channel></rss>`;
  const [item] = parseFeed(body);
  assert.equal(item.title, "財務省、国債発行計画を公表 & 説明");
  assert.equal(item.external_id, "mof-1");
  assert.equal(item.summary, "令和8年度の 発行計画");
  assert.equal(item.published_raw, "Sun, 28 Sep 2026 03:00:00 +0000");
  assert.equal(item.image_url, "https://www.mof.go.jp/img/t.jpg");
});

test("RSS item without any date keeps published_raw null", () => {
  const body = `<rss><channel><item><title>No date item</title><link>https://example.gov/x</link></item></channel></rss>`;
  assert.equal(parseFeed(body)[0].published_raw, null);
});

test("RDF (RSS 1.0) uses dc:date and rdf:about", () => {
  const body = `<?xml version="1.0"?><rdf:RDF xmlns:rdf="x" xmlns:dc="y"><item rdf:about="https://www.kantei.go.jp/jp/news/1.html">
<title>総理の一日</title><dc:date>2026-09-27T15:30:00+09:00</dc:date></item></rdf:RDF>`;
  const [item] = parseFeed(body);
  assert.equal(item.link, "https://www.kantei.go.jp/jp/news/1.html");
  assert.equal(item.published_raw, "2026-09-27T15:30:00+09:00");
});

test("Atom prefers rel=alternate and keeps updated separately", () => {
  const body = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>震度速報</title>
<id>urn:uuid:1</id><updated>2026-09-28T05:00:41Z</updated>
<link rel="related" href="https://example.jp/related"/><link type="application/xml" href="https://www.data.jma.go.jp/developer/xml/data/1.xml"/>
<content type="text">【震度速報】</content></entry></feed>`;
  const [item] = parseFeed(body);
  assert.equal(item.link, "https://www.data.jma.go.jp/developer/xml/data/1.xml");
  assert.equal(item.published_raw, null);
  assert.equal(item.updated_raw, "2026-09-28T05:00:41Z");
});

test("Federal Register JSON keeps date-only publication and agencies", () => {
  const body = JSON.stringify({ results: [{ title: "Adjusting Imports of Steel", abstract: "Proclamation...", document_number: "2026-19537",
    html_url: "https://www.federalregister.gov/documents/2026/09/24/2026-19537/x", publication_date: "2026-09-24", type: "Presidential Document",
    agencies: [{ name: "Executive Office of the President" }] }] });
  const [item] = parseFederalRegister(body);
  assert.equal(item.published_raw, "2026-09-24");
  assert.equal(item.external_id, "2026-19537");
  assert.equal(item.publisher, "Executive Office of the President");
});

test("GDELT keeps metadata only: no image, no body, seendate is not a publication time", () => {
  const body = JSON.stringify({ articles: [{ url: "https://news.example/a", title: "Tanker hit near Hormuz", seendate: "20260928T051500Z",
    socialimage: "https://news.example/img.jpg", domain: "news.example", language: "English", sourcecountry: "United States" }] });
  const [item] = parseGdeltDoc(body);
  assert.equal(item.image_url, null);
  assert.equal(item.summary, null);
  assert.equal(item.published_raw, null);
  assert.equal(item.seen_raw, "20260928T051500Z");
  assert.equal(item.publisher, "news.example");
  assert.deepEqual(parseGdeltDoc("{}"), []);
});

test("EDINET documents carry a structured ticker from secCode and JST time", () => {
  const body = JSON.stringify({ results: [{ docID: "S100ABCD", secCode: "72030", filerName: "トヨタ自動車株式会社",
    docDescription: "臨時報告書", submitDateTime: "2026-09-25 15:00", docTypeCode: "180" }] });
  const [item] = parseEdinetDocuments(body);
  assert.equal(item.structured_ticker, "7203");
  assert.equal(item.published_raw, "2026-09-25T15:00:00+09:00");
});
