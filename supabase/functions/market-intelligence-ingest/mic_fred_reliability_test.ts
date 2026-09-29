// FRED fetch reliability: bounded concurrency, bounded retry of transient
// failures, and a hard deadline for the whole fetch phase. No real network.
import assert from "node:assert/strict";
import test from "node:test";
import {
  FRED_FETCH_BUDGET_MS,
  FRED_FETCH_CONCURRENCY,
  FRED_MAX_ATTEMPTS,
  FRED_SERIES_MAPPINGS,
  FredAdapterError,
  fetchFredMetrics,
} from "./mic_fred_adapter.ts";
import { computeDataConfidence } from "../market-intelligence-state-evaluator/mic_state_decision_logic.ts";

const okBody = (value = "1.5") =>
  JSON.stringify({ observations: [{ date: "2026-09-28", value }, { date: "2026-09-27", value: "1.4" }] });

type Plan = Record<string, Array<number | "network" | "hang" | { status: number; retryAfter?: string }>>;

// Fake FRED: per series, a queue of outcomes (status code, network error or
// hang); anything not planned answers 200. A virtual clock only advances on
// sleep(), so backoff decisions are deterministic.
function fakeFred(plan: Plan = {}) {
  let clock = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const requests: string[] = [];
  const sleeps: number[] = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const seriesId = new URL(String(input)).searchParams.get("series_id")!;
    requests.push(seriesId);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await Promise.resolve();
      const next = plan[seriesId]?.shift();
      if (next === "network") throw new TypeError("connection reset");
      if (next === "hang") {
        return await new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        });
      }
      if (typeof next === "number") return new Response("bad gateway", { status: next });
      if (next && typeof next === "object") {
        return new Response("busy", { status: next.status, headers: next.retryAfter ? { "retry-after": next.retryAfter } : {} });
      }
      return new Response(okBody(), { status: 200 });
    } finally {
      inFlight -= 1;
    }
  }) as unknown as typeof fetch;
  return {
    impl,
    requests,
    sleeps,
    maxInFlight: () => maxInFlight,
    now: () => clock,
    sleep: (ms: number) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    },
  };
}

const count = (list: string[], id: string) => list.filter((x) => x === id).length;

test("[A] all 25 series succeed: one request each, mapping order kept, bounded concurrency", async () => {
  const fred = fakeFred();
  const metrics = await fetchFredMetrics({ apiKey: "k", now: fred.now, sleep: fred.sleep }, fred.impl);
  assert.equal(metrics.length, FRED_SERIES_MAPPINGS.length);
  assert.equal(FRED_SERIES_MAPPINGS.length, 25);
  assert.deepEqual(metrics.map((m) => m.metricKey), FRED_SERIES_MAPPINGS.map((m) => m.metricKey));
  assert.equal(fred.requests.length, 25);
  assert.ok(fred.maxInFlight() <= FRED_FETCH_CONCURRENCY && fred.maxInFlight() > 1, `in flight ${fred.maxInFlight()}`);
  assert.deepEqual(fred.sleeps, []);
});

test("[B] NIKKEI225 502 once, then success: retried after bounded backoff, run succeeds", async () => {
  const fred = fakeFred({ NIKKEI225: [502] });
  const metrics = await fetchFredMetrics({ apiKey: "k", now: fred.now, sleep: fred.sleep }, fred.impl);
  assert.equal(metrics.length, 25);
  assert.equal(count(fred.requests, "NIKKEI225"), 2);
  assert.deepEqual(fred.sleeps, [500]);
});

test("[C] 502 on every attempt: bounded to maxAttempts, then the run fails with the series named", async () => {
  const fred = fakeFred({ NIKKEI225: [502, 502, 502, 502] });
  await assert.rejects(
    fetchFredMetrics({ apiKey: "k", now: fred.now, sleep: fred.sleep }, fred.impl),
    (error: unknown) =>
      error instanceof FredAdapterError && error.code === "FRED_HTTP_ERROR" &&
      /NIKKEI225: status=502 \(attempts=3\)/.test(error.message),
  );
  assert.equal(count(fred.requests, "NIKKEI225"), FRED_MAX_ATTEMPTS);
  assert.deepEqual(fred.sleeps, [500, 1000]);
  assert.ok(fred.requests.length < 25 + FRED_MAX_ATTEMPTS, "no new series are started after a definitive failure");
});

for (const status of [429, 500, 503, 504]) {
  test(`[C] ${status} is transient and retried`, async () => {
    const fred = fakeFred({ DGS2: [status] });
    const metrics = await fetchFredMetrics({ apiKey: "k", now: fred.now, sleep: fred.sleep }, fred.impl);
    assert.equal(metrics.length, 25);
    assert.equal(count(fred.requests, "DGS2"), 2);
  });
}

test("[D] network error is retried", async () => {
  const fred = fakeFred({ DGS10: ["network"] });
  const metrics = await fetchFredMetrics({ apiKey: "k", now: fred.now, sleep: fred.sleep }, fred.impl);
  assert.equal(metrics.length, 25);
  assert.equal(count(fred.requests, "DGS10"), 2);
});

test("[E] a hanging request is aborted by the per-attempt timeout and retried", async () => {
  const fred = fakeFred({ VIXCLS: ["hang"] });
  const started = Date.now();
  const metrics = await fetchFredMetrics(
    { apiKey: "k", mappings: FRED_SERIES_MAPPINGS.slice(0, 9), timeoutMs: 50, sleep: () => Promise.resolve() },
    fred.impl,
  );
  assert.equal(metrics.length, 9);
  assert.equal(count(fred.requests, "VIXCLS"), 2);
  assert.ok(Date.now() - started < 2_000);
});

test("[F] requests that always hang cannot outlive the fetch budget: the phase rejects, it never hangs", async () => {
  const plan: Plan = Object.fromEntries(FRED_SERIES_MAPPINGS.map((m) => [m.seriesId, ["hang", "hang", "hang", "hang"]]));
  const fred = fakeFred(plan);
  const started = Date.now();
  await assert.rejects(
    fetchFredMetrics({ apiKey: "k", timeoutMs: 10_000, budgetMs: 1_300, sleep: () => Promise.resolve() }, fred.impl),
    (error: unknown) => error instanceof FredAdapterError && error.code === "FRED_FETCH_FAILED" && /timeout/.test(error.message),
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1_300 + 500, `settled after ${elapsed}ms`);
});

test("[F] no attempt starts with less than the minimum time left: FRED_DEADLINE_EXCEEDED", async () => {
  const fred = fakeFred();
  await assert.rejects(
    fetchFredMetrics({ apiKey: "k", budgetMs: 500, now: fred.now, sleep: fred.sleep }, fred.impl),
    (error: unknown) => error instanceof FredAdapterError && error.code === "FRED_DEADLINE_EXCEEDED",
  );
  assert.equal(fred.requests.length, 0);
});

test("[F] retry backoff never crosses the deadline", async () => {
  const fred = fakeFred({ DGS2: [502, 502, 502] });
  await assert.rejects(
    fetchFredMetrics({ apiKey: "k", mappings: FRED_SERIES_MAPPINGS.slice(0, 1), budgetMs: 1_200, now: fred.now, sleep: fred.sleep }, fred.impl),
    /FRED_HTTP_ERROR: DGS2: status=502 \(attempts=1\)/,
  );
  assert.deepEqual(fred.sleeps, [], "500ms backoff + 1s minimum attempt would exceed the 1.2s budget");
});

test("Retry-After within the cap is honored; a longer one is not waited out", async () => {
  const short = fakeFred({ SP500: [{ status: 429, retryAfter: "2" }] });
  await fetchFredMetrics({ apiKey: "k", now: short.now, sleep: short.sleep }, short.impl);
  assert.deepEqual(short.sleeps, [2_000]);
  const long = fakeFred({ SP500: [{ status: 429, retryAfter: "60" }] });
  await assert.rejects(fetchFredMetrics({ apiKey: "k", now: long.now, sleep: long.sleep }, long.impl), /SP500: status=429 \(attempts=1\)/);
  assert.deepEqual(long.sleeps, []);
});

test("[G] retries never duplicate: every metric exactly once, in mapping order", async () => {
  const fred = fakeFred({ DGS2: [502], NIKKEI225: ["network"], CPIAUCSL: [503, 504], PAYEMS: [429] });
  const metrics = await fetchFredMetrics({ apiKey: "k", now: fred.now, sleep: fred.sleep }, fred.impl);
  const keys = metrics.map((m) => m.metricKey);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual(keys, FRED_SERIES_MAPPINGS.map((m) => m.metricKey));
  // CPIAUCSL backs two mappings (raw + pc1); each is its own request and retried independently.
  assert.ok(count(fred.requests, "CPIAUCSL") >= 3);
});

test("[H] non-transient failures (4xx, malformed JSON) are not retried and fail the run (current spec)", async () => {
  const fred = fakeFred({ UNRATE: [400] });
  await assert.rejects(
    fetchFredMetrics({ apiKey: "k", now: fred.now, sleep: fred.sleep }, fred.impl),
    /FRED_HTTP_ERROR: UNRATE: status=400 \(attempts=1\)/,
  );
  assert.equal(count(fred.requests, "UNRATE"), 1);
  const malformed = (() => Promise.resolve(new Response("{not json", { status: 200 }))) as unknown as typeof fetch;
  await assert.rejects(
    fetchFredMetrics({ apiKey: "k", mappings: FRED_SERIES_MAPPINGS.slice(0, 1), sleep: () => Promise.resolve() }, malformed),
    /FRED_MALFORMED_RESPONSE: DGS2: invalid JSON \(attempts=1\)/,
  );
});

test("[I] partial success is NOT adopted: one definitive failure returns no metrics at all", async () => {
  const fred = fakeFred({ JPNRGDPEXP: [502, 502, 502] });
  let returned: unknown = "none";
  try {
    returned = await fetchFredMetrics({ apiKey: "k", concurrency: 1, now: fred.now, sleep: fred.sleep }, fred.impl);
  } catch (error) {
    assert.ok(error instanceof FredAdapterError);
  }
  assert.equal(returned, "none", "all-or-nothing: the successful 24 series are not returned for writing");
});

test("[J] State quality impact (existing model, unchanged): any failed FRED run means 0.2 for every FRED domain", () => {
  // v_mic_source_fetch_status takes the source's latest terminal run; a failed
  // run -> fetch_status 'failed' -> computeDataConfidence short-circuits.
  assert.equal(computeDataConfidence("full", "failed", "fresh"), 0.2);
  assert.equal(computeDataConfidence("full", "failed", "stale"), 0.2);
  assert.equal(computeDataConfidence("full", "fresh", "stale"), 0.6);
  assert.equal(computeDataConfidence("full", "fresh", "delayed_expected"), 0.9);
  // Retries are what keep a transient 502 from ever reaching this path.
});

test("defaults: budget fits the 150s platform limit with margin; attempts bounded", () => {
  assert.ok(FRED_FETCH_BUDGET_MS <= 90_000);
  assert.ok(FRED_MAX_ATTEMPTS >= 2 && FRED_MAX_ATTEMPTS <= 3);
  assert.ok(FRED_FETCH_CONCURRENCY >= 2 && FRED_FETCH_CONCURRENCY <= 5);
});
