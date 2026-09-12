import assert from "node:assert/strict";
import test from "node:test";
import { upsertMarketMetric, writeMarketEvent } from "./mic_writer_logic.ts";
import type { FinalizedMarketEvent, NormalizedMarketMetric } from "./mic_normalize_logic.ts";
import type { RestContext } from "./mic_writer_logic.ts";

const ctx: RestContext = { supabaseUrl: "https://example.supabase.co", secretKey: "secret-key" };

function sampleEvent(): FinalizedMarketEvent {
  return {
    occurredAt: null,
    publishedAt: "2026-09-12T00:00:00.000Z",
    eventType: "regulatory",
    category: "sec_filing",
    entityId: "AAPL",
    ticker: "AAPL",
    title: "Apple Inc. 8-K filing",
    summary: "Apple Inc. filed SEC Form 8-K.",
    sourceName: "SEC EDGAR",
    sourceUrl: "https://www.sec.gov/Archives/edgar/data/320193/0001/doc.htm",
    sourceKey: "sec_edgar",
    contentHash: "a".repeat(64),
    dedupeKey: "https://www.sec.gov/Archives/edgar/data/320193/0001/doc.htm",
  };
}

function sampleMetric(): NormalizedMarketMetric {
  return {
    metricKey: "US10Y",
    value: 4.05,
    unit: "percent",
    observedAt: "2026-09-11T21:00:00.000Z",
    fetchedAt: "2026-09-12T00:00:00.000Z",
    sourceKey: "fred",
    provider: "FRED",
    sourceUrl: "https://fred.stlouisfed.org/series/DGS10",
    isDelayed: true,
    delayMinutes: 1440,
    qualityTier: "official",
    isOfficial: true,
    metadata: { seriesId: "DGS10" },
  };
}

test("writeMarketEvent inserts and returns the new row's id", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify([{ id: "new-id" }]), { status: 201 });
  };
  const result = await writeMarketEvent(ctx, sampleEvent(), fetchImpl as typeof fetch);
  assert.deepEqual(result, { outcome: "inserted", id: "new-id" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.method, "POST");
  assert.match(calls[0].url, /\/rest\/v1\/market_events$/);
  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(body.content_hash, "a".repeat(64));
  assert.equal(body.source_key, "sec_edgar");
});

test("writeMarketEvent reports a 409 content_hash conflict as a duplicate, not a new row", async () => {
  const calls: string[] = [];
  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    calls.push(String(url));
    if ((init?.method ?? "GET") === "POST") {
      return new Response("conflict", { status: 409 });
    }
    return new Response(JSON.stringify([{ id: "existing-id" }]), { status: 200 });
  };
  const result = await writeMarketEvent(ctx, sampleEvent(), fetchImpl as typeof fetch);
  assert.deepEqual(result, { outcome: "duplicate", id: "existing-id" });
  assert.equal(calls.length, 2);
  assert.match(calls[1], /content_hash=eq\.a{64}/);
});

test("writeMarketEvent throws on an unexpected non-2xx, non-409 status", async () => {
  const fetchImpl = async () => new Response("server error", { status: 500 });
  await assert.rejects(
    () => writeMarketEvent(ctx, sampleEvent(), fetchImpl as typeof fetch),
    /MARKET_EVENT_INSERT_FAILED:500/,
  );
});

test("upsertMarketMetric posts with on_conflict + merge-duplicates", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(null, { status: 201 });
  };
  const result = await upsertMarketMetric(ctx, sampleMetric(), fetchImpl as typeof fetch);
  assert.deepEqual(result, { outcome: "upserted" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /on_conflict=metric_key,observed_at,source_key/);
  const prefer = (calls[0].init?.headers as Record<string, string>)?.Prefer;
  assert.match(prefer, /resolution=merge-duplicates/);
  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(body.metric_key, "US10Y");
  assert.equal(body.is_delayed, true);
});

test("upsertMarketMetric throws on a non-2xx status", async () => {
  const fetchImpl = async () => new Response("bad request", { status: 400 });
  await assert.rejects(
    () => upsertMarketMetric(ctx, sampleMetric(), fetchImpl as typeof fetch),
    /MARKET_METRIC_UPSERT_FAILED:400/,
  );
});
