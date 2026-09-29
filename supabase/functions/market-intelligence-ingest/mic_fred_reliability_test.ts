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

test("defaults: fetch budget leaves >= 25 s of the ~150 s limit; attempts and concurrency bounded", () => {
  // ~2 s of non-fetch work was observed in Production; the rest is margin.
  assert.ok(FRED_FETCH_BUDGET_MS <= 150_000 - 25_000);
  assert.ok(FRED_FETCH_BUDGET_MS >= 108_000, "must not fail runs that succeeded sequentially (108-144 s) by default");
  assert.ok(FRED_MAX_ATTEMPTS >= 2 && FRED_MAX_ATTEMPTS <= 3);
  assert.ok(FRED_FETCH_CONCURRENCY >= 2 && FRED_FETCH_CONCURRENCY <= 5);
});

// ------------------------------------------------------------------ review additions
test("review: all 4 workers hang at once: every in-flight request is aborted by the deadline", async () => {
  const plan: Plan = Object.fromEntries(FRED_SERIES_MAPPINGS.map((m) => [m.seriesId, ["hang", "hang", "hang"]]));
  const fred = fakeFred(plan);
  const started = Date.now();
  await assert.rejects(
    fetchFredMetrics({ apiKey: "k", mappings: FRED_SERIES_MAPPINGS.slice(0, 4), timeoutMs: 60_000, budgetMs: 1_200, sleep: () => Promise.resolve() }, fred.impl),
    /FRED_FETCH_FAILED: DGS2: timeout/,
  );
  assert.ok(Date.now() - started < 1_700);
  assert.equal(fred.requests.length, 4, "no retry is started with < 1 s left");
});

test("review: a body that stalls after the headers is aborted by the attempt timeout and retried", async () => {
  // Mirrors real Deno fetch (verified locally): aborting the signal errors the
  // body stream with a TimeoutError DOMException.
  let calls = 0;
  const impl = ((_url: string, init?: RequestInit) => {
    calls += 1;
    if (calls > 1) return Promise.resolve(new Response(okBody(), { status: 200 }));
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"observations": ['));
        init?.signal?.addEventListener("abort", () => controller.error(init.signal!.reason));
      },
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  }) as unknown as typeof fetch;
  const metrics = await fetchFredMetrics(
    { apiKey: "k", mappings: FRED_SERIES_MAPPINGS.slice(0, 1), timeoutMs: 50, sleep: () => Promise.resolve() },
    impl,
  );
  assert.equal(metrics.length, 1);
  assert.equal(calls, 2);
});

test("review: several workers 502 at once: each retried independently, run succeeds", async () => {
  const fred = fakeFred({ DGS2: [502], DGS10: [502], DFEDTARL: [502], DFEDTARU: [502] });
  const metrics = await fetchFredMetrics({ apiKey: "k", now: fred.now, sleep: fred.sleep }, fred.impl);
  assert.equal(metrics.length, 25);
  for (const id of ["DGS2", "DGS10", "DFEDTARL", "DFEDTARU"]) assert.equal(count(fred.requests, id), 2, id);
});

test("review: a definitive failure stops other workers' retries and new series", async () => {
  // DGS2 fails definitively (400) while DGS10 keeps answering 502.
  const fred = fakeFred({ DGS2: [400], DGS10: [502, 502, 502] });
  // A real (short) backoff lets DGS2's definitive failure land during DGS10's wait.
  await assert.rejects(
    fetchFredMetrics({ apiKey: "k", sleep: () => new Promise((r) => setTimeout(r, 10)) }, fred.impl),
    /FRED_HTTP_ERROR: DGS2: status=400 \(attempts=1\)/,
  );
  assert.equal(count(fred.requests, "DGS10"), 1, "no retry after another series definitively failed");
  // Workers that finished a series in the same tick may already have started
  // their next one; after the failure is recorded no new series starts.
  assert.ok(fred.requests.length < 2 * FRED_FETCH_CONCURRENCY, `requests ${fred.requests.length}`);
});

test("review: multiple failures are reported in mapping order regardless of completion order", async () => {
  // VIXCLS (index 8) fails first in time; DGS10 (index 1) fails later but is reported first.
  const slowFail = ((url: string) => {
    const id = new URL(url).searchParams.get("series_id");
    if (id === "VIXCLS") return Promise.resolve(new Response("x", { status: 400 }));
    if (id === "DGS10") return new Promise<Response>((r) => setTimeout(() => r(new Response("x", { status: 404 })), 20));
    return Promise.resolve(new Response(okBody(), { status: 200 }));
  }) as unknown as typeof fetch;
  const mappings = [FRED_SERIES_MAPPINGS[1], FRED_SERIES_MAPPINGS[8]];
  await assert.rejects(
    fetchFredMetrics({ apiKey: "k", mappings, sleep: () => Promise.resolve() }, slowFail),
    /FRED_HTTP_ERROR: DGS10: status=404 \(attempts=1\); also failed: VIXCLS/,
  );
});

test("review: Retry-After HTTP-date, 0, malformed and negative values", async () => {
  const base = Date.parse("2026-09-29T21:00:00Z");
  const run = async (retryAfter: string) => {
    let clock = base;
    const sleeps: number[] = [];
    const fred = fakeFred({ SP500: [{ status: 503, retryAfter }] });
    await fetchFredMetrics({
      apiKey: "k", mappings: FRED_SERIES_MAPPINGS.slice(5, 6), now: () => clock,
      sleep: (ms) => { sleeps.push(ms); clock += ms; return Promise.resolve(); },
    }, fred.impl);
    return sleeps;
  };
  assert.deepEqual(await run(new Date(base + 3_000).toUTCString()), [3_000], "HTTP-date within the cap");
  assert.deepEqual(await run("0"), [500], "0 never goes below the backoff");
  assert.deepEqual(await run("soon"), [500], "malformed -> backoff");
  assert.deepEqual(await run("-5"), [500], "negative -> backoff");
  await assert.rejects(run(new Date(base + 60_000).toUTCString()), /status=503 \(attempts=1\)/, "HTTP-date beyond the cap -> fail");
});

test("review: 408/409/425 are not retried (only 429/500/502/503/504 are)", async () => {
  for (const status of [408, 409, 425]) {
    const fred = fakeFred({ DGS2: [status] });
    await assert.rejects(
      fetchFredMetrics({ apiKey: "k", mappings: FRED_SERIES_MAPPINGS.slice(0, 1), now: fred.now, sleep: fred.sleep }, fred.impl),
      new RegExp(`status=${status} \\(attempts=1\\)`),
    );
  }
});

test("review: same series under two mappings (units differ) are distinct requests, each exactly once", async () => {
  const fred = fakeFred();
  const cpi = FRED_SERIES_MAPPINGS.filter((m) => m.seriesId === "CPIAUCSL");
  assert.equal(cpi.length, 2);
  const metrics = await fetchFredMetrics({ apiKey: "k", mappings: cpi, now: fred.now, sleep: fred.sleep }, fred.impl);
  assert.deepEqual(metrics.map((m) => m.metricKey), ["US_CPI", "US_CPI_YOY"]);
  assert.equal(count(fred.requests, "CPIAUCSL"), 2);
});

test("review: concurrency 1 and 4, maxAttempts 1 and 3", async () => {
  const serial = fakeFred();
  await fetchFredMetrics({ apiKey: "k", concurrency: 1, now: serial.now, sleep: serial.sleep }, serial.impl);
  assert.equal(serial.maxInFlight(), 1);
  const parallel = fakeFred();
  await fetchFredMetrics({ apiKey: "k", concurrency: 4, now: parallel.now, sleep: parallel.sleep }, parallel.impl);
  assert.equal(parallel.maxInFlight(), 4);
  const once = fakeFred({ DGS2: [502] });
  await assert.rejects(
    fetchFredMetrics({ apiKey: "k", maxAttempts: 1, now: once.now, sleep: once.sleep }, once.impl),
    /DGS2: status=502 \(attempts=1\)/,
  );
});

test("review: empty mappings return an empty list without requests", async () => {
  const fred = fakeFred();
  assert.deepEqual(await fetchFredMetrics({ apiKey: "k", mappings: [], now: fred.now, sleep: fred.sleep }, fred.impl), []);
  assert.equal(fred.requests.length, 0);
});
