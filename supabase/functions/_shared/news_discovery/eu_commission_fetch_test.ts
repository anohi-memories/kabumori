// N5-D: eu_commission_press failed in production twice (N5-A, N5-C): "HTTP 200 -> body read failed".
// ec.europa.eu answers a gzip request with "Connection: close", no Content-Length / Transfer-Encoding and no
// TLS close_notify; the Edge Runtime's fetch fails the body read. Uncompressed it answers chunked.
// Fix under test: that one source asks for "Accept-Encoding: identity". Nothing else about fetching changes.
import assert from "node:assert/strict";
import test from "node:test";
import { fetchSource, HostRateGate } from "./fetcher.ts";
import { NEWS_SOURCE_REGISTRY, sourceById } from "./source_registry.ts";

const EU = sourceById("eu_commission_press")!;
const noGapGate = () => new HostRateGate(() => 0, () => Promise.resolve());

// Same tag structure as the live feed (title, link, description, category, pubDate, guid); own wording.
const item = (n: number) =>
  `<item><title>Commission statement ${n}</title><link>https://ec.europa.eu/commission/presscorner/detail/en/statement_26_${2000 + n}</link>` +
  `<description>European Commission Statement Brussels, 02 Oct 2026 Summary ${n}</description><category>POLICY_AREA=TEST</category>` +
  `<pubDate>Fri, 02 Oct 2026 1${n}:00:00 GMT</pubDate><guid>https://ec.europa.eu/commission/presscorner/detail/en/statement_26_${2000 + n}</guid></item>`;
const FEED = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Press releases - RSS</title>` +
  `<link>https://ec.europa.eu/commission/presscorner/api/rss?language=en</link><language>en</language>${[1, 2, 3].map(item).join("")}</channel></rss>`;

function fakeFetch(make: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    try {
      return Promise.resolve(make());
    } catch (error) {
      return Promise.reject(error);
    }
  };
  return { impl, calls };
}

/** A body that delivers `chunks` and then errors, like the runtime does when the connection ends without close_notify. */
function failingBody(chunks: string[], message = "error reading a body from connection") {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.error(new TypeError(message));
    },
  });
}

/** A chunked-style body: the feed delivered in several pieces. */
function chunkedBody(text: string, pieces = 4) {
  const size = Math.ceil(text.length / pieces);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < text.length; i += size) controller.enqueue(new TextEncoder().encode(text.slice(i, i + size)));
      controller.close();
    },
  });
}

const sentHeaders = (calls: Array<{ init?: RequestInit }>) => (calls[0].init?.headers ?? {}) as Record<string, string>;

test("registry: only eu_commission_press asks for an uncompressed body, and only as 'identity'", () => {
  const withIt = NEWS_SOURCE_REGISTRY.filter((s) => s.request_accept_encoding !== undefined);
  assert.deepEqual(withIt.map((s) => s.source_id), ["eu_commission_press"]);
  assert.equal(EU.request_accept_encoding, "identity");
  assert.equal(EU.endpoint, "https://ec.europa.eu/commission/presscorner/api/rss?language=en", "endpoint unchanged");
  assert.equal(EU.timeout_ms, 15_000, "timeout unchanged");
  assert.equal(EU.min_request_gap_ms, 1_000, "request gap unchanged");
  assert.equal(EU.policy, "DIRECT_SOURCE");
});

test("eu_commission_press sends Accept-Encoding: identity next to the unchanged User-Agent / Accept", async () => {
  const { impl, calls } = fakeFetch(() => new Response(chunkedBody(FEED), { status: 200, headers: { "content-type": "application/rss+xml;charset=UTF-8", "transfer-encoding": "chunked" } }));
  const result = await fetchSource(EU, { fetchImpl: impl, gate: noGapGate() });
  assert.equal(result.ok, true);
  assert.equal(calls[0].url, EU.endpoint);
  const headers = sentHeaders(calls);
  assert.equal(headers["Accept-Encoding"], "identity");
  assert.deepEqual(Object.keys(headers).sort(), ["Accept", "Accept-Encoding", "User-Agent"]);
  const other = fakeFetch(() => new Response(FEED));
  await fetchSource(sourceById("eu_ecb_press")!, { fetchImpl: other.impl, gate: noGapGate() });
  assert.equal(headers["User-Agent"], sentHeaders(other.calls)["User-Agent"]);
  assert.equal(headers.Accept, sentHeaders(other.calls).Accept);
});

test("every other source sends exactly the headers it sent before (no Accept-Encoding)", async () => {
  const others = NEWS_SOURCE_REGISTRY.filter((s) => s.source_id !== EU.source_id && s.policy !== "DISABLED" && !s.requires_api_key && s.enabled_for_n2);
  assert.ok(others.length >= 17, `expected the other fetchable sources, got ${others.length}`);
  for (const source of others) {
    const { impl, calls } = fakeFetch(() => new Response("<html></html>"));
    await fetchSource(source, { fetchImpl: impl, gate: noGapGate() });
    assert.deepEqual(Object.keys(sentHeaders(calls)).sort(), ["Accept", "User-Agent"], source.source_id);
  }
});

test("a chunked 200 response is parsed in full: every item is kept", async () => {
  const { impl } = fakeFetch(() => new Response(chunkedBody(FEED, 7), { status: 200, headers: { "content-type": "application/rss+xml;charset=UTF-8", "transfer-encoding": "chunked" } }));
  const result = await fetchSource(EU, { fetchImpl: impl, gate: noGapGate() });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.items.map((i) => i.title), ["Commission statement 1", "Commission statement 2", "Commission statement 3"]);
  assert.equal(result.items[0].link, "https://ec.europa.eu/commission/presscorner/detail/en/statement_26_2001");
  assert.ok(result.items.every((i) => i.published_raw));
});

test("HTTP 200 followed by a body read error is still NETWORK_ERROR: no truncation is ever accepted", async () => {
  for (const source of [EU, sourceById("us_fed_press")!]) {
    // The full feed was delivered, then the stream errored (what a missing close_notify looks like).
    const { impl } = fakeFetch(() => new Response(failingBody([FEED]), { status: 200 }));
    const result = await fetchSource(source, { fetchImpl: impl, gate: noGapGate() });
    assert.equal(result.ok, false, source.source_id);
    if (result.ok) continue;
    assert.deepEqual([result.code, result.status, result.detail], ["NETWORK_ERROR", 200, "body read failed"], source.source_id);
  }
});

test("a partial body that ends cleanly is rejected as malformed, not parsed", async () => {
  const cut = FEED.slice(0, FEED.indexOf("</item>") - 10);
  const { impl } = fakeFetch(() => new Response(chunkedBody(cut, 3), { status: 200 }));
  const result = await fetchSource(EU, { fetchImpl: impl, gate: noGapGate() });
  assert.equal(!result.ok && result.code, "MALFORMED_RESPONSE");
});

test("redirects are still followed, the per-source timeout signal is still attached and timeouts stay TIMEOUT", async () => {
  const { impl, calls } = fakeFetch(() => new Response(FEED));
  await fetchSource(EU, { fetchImpl: impl, gate: noGapGate() });
  assert.equal(calls[0].init?.redirect, "follow");
  assert.ok(calls[0].init?.signal instanceof AbortSignal);
  const timedOut = fakeFetch(() => Promise.reject(new DOMException("timed out", "TimeoutError")));
  const result = await fetchSource(EU, { fetchImpl: timedOut.impl, gate: noGapGate() });
  assert.equal(!result.ok && result.code, "TIMEOUT");
  const bodyTimeout = fakeFetch(() => new Response(new ReadableStream({ start(c) { c.error(new DOMException("timed out", "TimeoutError")); } }), { status: 200 }));
  const slow = await fetchSource(EU, { fetchImpl: bodyTimeout.impl, gate: noGapGate() });
  assert.equal(!slow.ok && slow.code, "TIMEOUT");
});

test("the body size cap is unchanged", async () => {
  const huge = "x".repeat(5_000_001);
  const { impl } = fakeFetch(() => new Response(huge, { status: 200 }));
  const result = await fetchSource(EU, { fetchImpl: impl, gate: noGapGate() });
  assert.deepEqual(!result.ok && [result.code, result.detail], ["MALFORMED_RESPONSE", "body too large"]);
});
