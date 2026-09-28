import assert from "node:assert/strict";
import test from "node:test";
import { decodeBody, fetchSource, gdeltQueryUrl, GDELT_DISCOVERY_QUERIES, HostRateGate } from "./fetcher.ts";
import { sourceById } from "./source_registry.ts";
import type { SourceDefinition } from "./types.ts";

const RSS = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>t</title>
<item><title>Federal Reserve issues FOMC statement</title><link>https://www.federalreserve.gov/newsevents/pressreleases/monetary20260917a.htm</link>
<pubDate>Wed, 17 Sep 2026 18:00:00 GMT</pubDate><description>The Committee decided...</description></item>
</channel></rss>`;

const fed = sourceById("us_fed_press")!;
const noGapGate = () => new HostRateGate(() => 0, () => Promise.resolve());

function fakeFetch(response: Response | (() => Promise<Response>)) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return typeof response === "function" ? response() : Promise.resolve(response.clone());
  };
  return { impl, calls };
}

test("successful fetch parses items and sends a declared User-Agent", async () => {
  const { impl, calls } = fakeFetch(new Response(RSS, { status: 200, headers: { "content-type": "application/rss+xml" } }));
  const result = await fetchSource(fed, { fetchImpl: impl, gate: noGapGate() });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].title, "Federal Reserve issues FOMC statement");
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.match(headers["User-Agent"], /contact@kabumori\.app/);
});

test("timeout is classified, not thrown", async () => {
  const { impl } = fakeFetch(() => Promise.reject(new DOMException("timed out", "TimeoutError")));
  const result = await fetchSource(fed, { fetchImpl: impl, gate: noGapGate() });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "TIMEOUT");
});

test("network error is classified", async () => {
  const { impl } = fakeFetch(() => Promise.reject(new TypeError("dns")));
  const result = await fetchSource(fed, { fetchImpl: impl, gate: noGapGate() });
  assert.equal(!result.ok && result.code, "NETWORK_ERROR");
});

test("HTTP errors and 429 are classified separately", async () => {
  const notFound = await fetchSource(fed, { fetchImpl: fakeFetch(new Response("no", { status: 404 })).impl, gate: noGapGate() });
  assert.deepEqual(!notFound.ok && [notFound.code, notFound.status], ["HTTP_ERROR", 404]);
  const limited = await fetchSource(fed, { fetchImpl: fakeFetch(new Response("slow down", { status: 429 })).impl, gate: noGapGate() });
  assert.equal(!limited.ok && limited.code, "RATE_LIMITED");
});

test("malformed and empty responses are classified", async () => {
  const html = await fetchSource(fed, { fetchImpl: fakeFetch(new Response("<html><body>maintenance</body></html>")).impl, gate: noGapGate() });
  assert.equal(!html.ok && html.code, "MALFORMED_RESPONSE");
  const truncated = await fetchSource(fed, { fetchImpl: fakeFetch(new Response(RSS.slice(0, 200))).impl, gate: noGapGate() });
  assert.equal(!truncated.ok && truncated.code, "MALFORMED_RESPONSE");
  const empty = await fetchSource(fed, { fetchImpl: fakeFetch(new Response("")).impl, gate: noGapGate() });
  assert.equal(!empty.ok && empty.code, "EMPTY_RESPONSE");
  const blank = await fetchSource(fed, { fetchImpl: fakeFetch(new Response("   \n")).impl, gate: noGapGate() });
  assert.equal(!blank.ok && blank.code, "EMPTY_RESPONSE");
});

test("a well-formed feed without items is ok with zero items", async () => {
  const body = `<?xml version="1.0"?><rss><channel><title>x</title></channel></rss>`;
  const result = await fetchSource(fed, { fetchImpl: fakeFetch(new Response(body)).impl, gate: noGapGate() });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.items.length, 0);
});

test("DISABLED, not-enabled and key-requiring sources are refused without any request", async () => {
  const { impl, calls } = fakeFetch(new Response(RSS));
  for (const id of ["al_jazeera", "nhk_news", "tdnet_list", "jp_edinet_documents"]) {
    const result = await fetchSource(sourceById(id)!, { fetchImpl: impl, gate: noGapGate() });
    assert.equal(result.ok, false, id);
  }
  assert.equal(calls.length, 0);
  const edinet = await fetchSource(sourceById("jp_edinet_documents")!, { fetchImpl: impl });
  assert.equal(!edinet.ok && edinet.code, "SOURCE_REQUIRES_API_KEY");
  const disabled = await fetchSource(sourceById("al_jazeera")!, { fetchImpl: impl });
  assert.equal(!disabled.ok && disabled.code, "SOURCE_DISABLED");
});

test("GDELT plain-text rate-limit notice is RATE_LIMITED, not parsed", async () => {
  const gdelt = sourceById("gdelt_doc")!;
  const body = "Please limit requests to one every 5 seconds or contact ...";
  const result = await fetchSource(gdelt, { fetchImpl: fakeFetch(new Response(body, { status: 200 })).impl, gate: noGapGate() });
  assert.equal(!result.ok && result.code, "RATE_LIMITED");
});

test("host gate spaces GDELT requests by min_request_gap_ms", async () => {
  let clock = 1_000;
  const sleeps: number[] = [];
  const gate = new HostRateGate(() => clock, (ms) => {
    sleeps.push(ms);
    clock += ms;
    return Promise.resolve();
  });
  const gdelt = sourceById("gdelt_doc")!;
  const url = gdeltQueryUrl(gdelt, GDELT_DISCOVERY_QUERIES[0]);
  await gate.wait(url, gdelt.min_request_gap_ms);
  clock += 1_000;
  await gate.wait(url, gdelt.min_request_gap_ms);
  assert.deepEqual(sleeps, [5_000]);
});

test("GDELT query URL asks for metadata list only", () => {
  const url = new URL(gdeltQueryUrl(sourceById("gdelt_doc")!, GDELT_DISCOVERY_QUERIES[0]));
  assert.equal(url.searchParams.get("mode"), "artlist");
  assert.equal(url.searchParams.get("format"), "json");
  assert.ok(Number(url.searchParams.get("maxrecords")) <= 75);
});

test("conditional GET sends validators and treats 304 as not modified", async () => {
  const validators = new Map([[fed.endpoint, { etag: '"abc"', lastModified: null }]]);
  const { impl, calls } = fakeFetch(new Response(null, { status: 304 }));
  const result = await fetchSource(fed as SourceDefinition, { fetchImpl: impl, gate: noGapGate(), validators });
  assert.equal(result.ok && result.not_modified, true);
  assert.equal((calls[0].init?.headers as Record<string, string>)["If-None-Match"], '"abc"');
});

test("Shift_JIS declared feeds are decoded", () => {
  // "日銀" in Shift_JIS
  const bytes = new Uint8Array([0x3c, 0x3f, 0x78, 0x6d, 0x6c, 0x20, 0x65, 0x6e, 0x63, 0x6f, 0x64, 0x69, 0x6e, 0x67, 0x3d, 0x22, 0x53,
    0x68, 0x69, 0x66, 0x74, 0x5f, 0x4a, 0x49, 0x53, 0x22, 0x3f, 0x3e, 0x93, 0xfa, 0x8b, 0xe2]);
  assert.match(decodeBody(bytes, null), /日銀$/);
});
