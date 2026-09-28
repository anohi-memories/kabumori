import assert from "node:assert/strict";
import test from "node:test";
import { signalUrlKey } from "./pipeline.ts";
import type { DuplicateLookup } from "./store.ts";
import {
  MAX_RPC_BATCH,
  NewsDiscoveryDbError,
  postgrestRpcClient,
  type RpcClient,
  type RpcFunction,
  signalToRow,
  SupabaseNewsSignalStore,
} from "./supabase_store.ts";
import type { NewsSignal } from "./types.ts";

function signal(overrides: Partial<NewsSignal> = {}): NewsSignal {
  const id = overrides.id ?? "a".repeat(64);
  return {
    id,
    source_id: "jp_mof_news",
    source_type: "rss",
    policy: "DIRECT_SOURCE",
    source_url: "https://www.mof.go.jp/a.html?utm_source=rss",
    canonical_url: "https://www.mof.go.jp/a.html",
    external_id: null,
    title: "財務省のお知らせ",
    title_display_allowed: true,
    summary_hint: "要約",
    published_at: "2026-09-28T03:00:00.000Z",
    published_at_precision: "datetime",
    updated_at: null,
    detected_at: null,
    fetched_at: "2026-09-28T06:00:00.000Z",
    language: "ja",
    country: "JP",
    publisher: "財務省",
    topics: ["fiscal"],
    entities: [{ kind: "institution", value: "Ministry of Finance Japan" }],
    ticker_candidates: [{
      ticker: "7203",
      company_name: "トヨタ自動車",
      status: "confirmed",
      confirmation_basis: "strong_match",
      match_types: ["EXACT_COMPANY_NAME"],
      matched_aliases: ["トヨタ自動車"],
      in_title: true,
      score: 1,
    }],
    image_url: null,
    image_source: null,
    image_usage_allowed: false,
    discovery_only: false,
    discovered_via: "feed:jp_mof_news",
    raw_reference: { feed_url: "https://www.mof.go.jp/news.rss", item_index: 0 },
    fingerprint: id,
    title_fingerprint: "b".repeat(32),
    same_event_group: null,
    needs_verification: [],
    ...overrides,
  };
}

class RecordingRpc implements RpcClient {
  calls: Array<{ fn: RpcFunction; payload: Record<string, unknown> }> = [];
  constructor(private readonly respond: (fn: RpcFunction, payload: Record<string, unknown>) => unknown) {}
  call(fn: RpcFunction, payload: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ fn, payload });
    return Promise.resolve(this.respond(fn, payload));
  }
}

const lookup = (i: number): DuplicateLookup => ({
  canonical_url: `https://x.example/${i}`,
  url_key: `x.example/${i}`,
  source_id: "jp_mof_news",
  external_id: null,
  title_fingerprint: null,
  title_fingerprint_any: "c".repeat(32),
  since_ms: Date.parse("2026-09-25T00:00:00Z"),
});

test("signalToRow carries tickers/entities separately and the URL key used for dedupe", () => {
  const row = signalToRow(signal());
  assert.equal(row.url_key, signalUrlKey(signal()));
  assert.deepEqual((row.tickers as Array<Record<string, unknown>>)[0].confirmation_basis, "strong_match");
  assert.deepEqual(row.entities, [{ kind: "institution", value: "Ministry of Finance Japan" }]);
});

test("signalToRow never sends a summary or an image for discovery-only signals", () => {
  const row = signalToRow(signal({
    policy: "DISCOVERY_ONLY",
    discovery_only: true,
    summary_hint: "should not be sent",
    image_url: "https://img.example/x.jpg",
    image_usage_allowed: true,
    title_display_allowed: false,
  }));
  assert.equal(row.summary_hint, null);
  assert.equal(row.image_url, null);
  assert.equal(row.image_usage_allowed, false);
  assert.equal(row.title_display_allowed, false);
});

test("findDuplicates batches lookups and realigns results by index across chunks", async () => {
  const rpc = new RecordingRpc((_fn, payload) =>
    (payload.lookups as Array<{ i: number }>).filter((l) => l.i % 100 === 1).map((l) => ({ i: l.i, reason: "canonical_url", signal_id: `s${l.i}` }))
  );
  const store = new SupabaseNewsSignalStore(rpc, "run", "v0");
  const lookups = Array.from({ length: MAX_RPC_BATCH + 5 }, (_, i) => lookup(i));
  const hits = await store.findDuplicates(lookups);
  assert.equal(rpc.calls.length, 2, "chunked");
  assert.deepEqual(hits.flatMap((hit, i) => hit ? [[i, hit.signal_id]] : []), [[1, "s1"], [101, "s101"], [201, "s201"]]);
  assert.equal((rpc.calls[0].payload.lookups as Array<{ since: string }>)[0].since, "2026-09-25T00:00:00.000Z");
});

test("save aggregates inserted and conflicted ids per chunk and passes the run id", async () => {
  const rpc = new RecordingRpc((_fn, payload) => {
    const ids = (payload.signals as Array<{ id: string }>).map((s) => s.id);
    return { inserted: ids.slice(1), conflicted: ids.slice(0, 1) };
  });
  const store = new SupabaseNewsSignalStore(rpc, "run-1", "alias-v0");
  const result = await store.save([signal({ id: "1".repeat(64) }), signal({ id: "2".repeat(64) })]);
  assert.deepEqual(result, { inserted: ["2".repeat(64)], conflicted: ["1".repeat(64)] });
  assert.equal(rpc.calls[0].payload.run_id, "run-1");
  assert.equal(rpc.calls[0].payload.alias_dictionary_version, "alias-v0");
});

test("malformed RPC responses throw a coded error", async () => {
  const store = new SupabaseNewsSignalStore(new RecordingRpc(() => ({ nope: true })), "run", "v0");
  await assert.rejects(() => store.save([signal()]), (error: unknown) => error instanceof NewsDiscoveryDbError);
  await assert.rejects(() => store.findDuplicates([lookup(0)]), /DB_RPC_BAD_RESPONSE/);
});

test("recent() maps confirmed tickers for same-event grouping", async () => {
  const rpc = new RecordingRpc(() => [{
    id: "d".repeat(64), source_id: "us_fed_press", title: "t", fetched_at: "2026-09-28T01:00:00+00:00",
    topics: ["rates"], same_event_group: null, confirmed_tickers: ["7203"],
  }]);
  const [row] = await new SupabaseNewsSignalStore(rpc, "run", "v0").recent(0);
  assert.deepEqual(row.ticker_candidates, [{ ticker: "7203", status: "confirmed" }]);
  assert.equal(row.fetched_at, "2026-09-28T01:00:00.000Z");
});

test("PostgREST client: posts {p}, retries once on 5xx, never retries 4xx, never leaks the key", async () => {
  const key = "service-role-key-should-never-appear";
  const seen: Array<{ url: string; init?: RequestInit }> = [];
  let status = 503;
  const client = postgrestRpcClient("https://proj.supabase.co/", key, {
    fetchImpl: (url, init) => {
      seen.push({ url, init });
      return Promise.resolve(new Response(JSON.stringify({ code: "XX000", message: `secret ${key}` }), { status }));
    },
  });
  await assert.rejects(() => client.call("news_discovery_begin_run", {}), (error: unknown) => {
    assert.ok(error instanceof NewsDiscoveryDbError);
    assert.ok(!error.message.includes(key));
    assert.equal(error.message, "DB_RPC_FAILED:news_discovery_begin_run:XX000:503");
    return true;
  });
  assert.equal(seen.length, 2, "one retry for 5xx");
  assert.equal(seen[0].url, "https://proj.supabase.co/rest/v1/rpc/news_discovery_begin_run");
  assert.deepEqual(JSON.parse(String(seen[0].init?.body)), { p: {} });
  seen.length = 0;
  status = 400;
  await assert.rejects(() => client.call("news_discovery_begin_run", {}));
  assert.equal(seen.length, 1, "no retry for 4xx");
});

test("PostgREST client: transport failure is retried then reported without detail", async () => {
  let calls = 0;
  const client = postgrestRpcClient("https://proj.supabase.co", "k", {
    fetchImpl: () => {
      calls += 1;
      return Promise.reject(new TypeError("connection reset"));
    },
  });
  await assert.rejects(() => client.call("news_discovery_finish_run", {}), /DB_RPC_TRANSPORT:news_discovery_finish_run/);
  assert.equal(calls, 2);
});
