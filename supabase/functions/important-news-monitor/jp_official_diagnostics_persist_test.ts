// deno-lint-ignore-file require-await
// J1-a: the real index.ts handler persists the jp_official counters into important_news_monitor_runs.diagnostics, and a
// failing diagnostics write never stops the run. PostgREST and every outbound fetch are mocked; no network.
import assert from "node:assert/strict";
import test from "node:test";

const SECRET = "A".repeat(42) + "A";
const BASE = "https://db.test";
const FLAG = "IMPORTANT_NEWS_JP_OFFICIAL_LANE";

async function runCycle(flag: string | undefined, options: { failDiagnosticsWrite?: boolean; signals?: unknown[] } = {}) {
  let handler: ((req: Request) => Promise<Response>) | null = null;
  const realServe = Deno.serve;
  const realFetch = globalThis.fetch;
  // deno-lint-ignore no-explicit-any
  (Deno as any).serve = (h: (req: Request) => Promise<Response>) => { handler = h; return { finished: Promise.resolve() }; };
  Deno.env.set("IMPORTANT_NEWS_CRON_SECRET", SECRET);
  Deno.env.set("SUPABASE_URL", BASE);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-test");
  Deno.env.delete("OPENAI_API_KEY");
  const beforeFlag = Deno.env.get(FLAG);
  if (flag === undefined) Deno.env.delete(FLAG);
  else Deno.env.set(FLAG, flag);
  const runPatches: Array<Record<string, unknown>> = [];
  const outbound: string[] = [];
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (url.origin === BASE) {
      const table = url.pathname.split("/").pop();
      if (table === "important_news_monitor_runs") {
        if (method === "POST") return json([{ id: "run-1" }], 201);
        if (method === "PATCH") {
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          if ("diagnostics" in body && options.failDiagnosticsWrite) return new Response("boom", { status: 500 });
          runPatches.push(body);
          return new Response(null, { status: 204 });
        }
      }
      if (table === "news_discovery_signals") return json(options.signals ?? []);
      if (table === "important_news_candidates" && method === "POST") return json([{ id: "c1" }], 201);
      return json([]);
    }
    outbound.push(url.hostname);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  try {
    await import(`./index.ts?j1a-${crypto.randomUUID()}`);
    assert.ok(handler);
    const response = await (handler as (req: Request) => Promise<Response>)(new Request("https://fn.test/", {
      method: "POST",
      headers: { "x-important-news-cron-secret": SECRET, "content-type": "application/json" },
      body: JSON.stringify({ trigger: "manual", fetchSources: true }),
    }));
    return { status: response.status, body: await response.json() as Record<string, unknown>, runPatches, outbound };
  } finally {
    globalThis.fetch = realFetch;
    // deno-lint-ignore no-explicit-any
    (Deno as any).serve = realServe;
    if (beforeFlag === undefined) Deno.env.delete(FLAG);
    else Deno.env.set(FLAG, beforeFlag);
  }
}

const jpFrom = (patches: Array<Record<string, unknown>>) =>
  (patches.find((patch) => "diagnostics" in patch)?.diagnostics as { jpOfficial?: Record<string, unknown> } | undefined)?.jpOfficial;

test("J1-a: lane unset / not exactly 'enabled' is persisted as enabled=false with zero counters", async () => {
  for (const flag of [undefined, "", "true", "Enabled", "disabled"]) {
    const { status, runPatches } = await runCycle(flag);
    assert.equal(status, 200, String(flag));
    const jp = jpFrom(runPatches);
    assert.ok(jp, `diagnostics.jpOfficial present for ${String(flag)}`);
    assert.equal(jp.enabled, false);
    assert.deepEqual([jp.signalsRead, jp.selected, jp.inserted], [0, 0, 0]);
  }
});

test("J1-a: lane enabled is persisted as enabled=true with the read count", async () => {
  const { status, runPatches, body } = await runCycle("enabled", { signals: [] });
  assert.equal(status, 200);
  const jp = jpFrom(runPatches);
  assert.ok(jp);
  assert.equal(jp.enabled, true);
  assert.equal(jp.signalsRead, 0);
  // the HTTP response keeps its own jpOfficial block unchanged
  assert.equal((body.jpOfficial as { enabled: boolean }).enabled, true);
});

test("J1-a: a failing diagnostics write does not stop the run or change its outcome", async () => {
  const ok = await runCycle("enabled");
  const failed = await runCycle("enabled", { failDiagnosticsWrite: true });
  assert.equal(failed.status, 200);
  assert.equal(failed.body.status, ok.body.status);
  assert.equal((failed.body.jpOfficial as { enabled: boolean }).enabled, true);
  assert.equal(failed.runPatches.some((patch) => "diagnostics" in patch), false);
});

test("J1-a: persistence adds no outbound request (HTTP/AI) compared with the lane being unset", async () => {
  const off = await runCycle(undefined);
  const on = await runCycle("enabled");
  assert.deepEqual(on.outbound.sort(), off.outbound.sort());
});
