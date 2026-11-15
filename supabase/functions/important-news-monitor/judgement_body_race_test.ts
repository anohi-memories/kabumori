// deno-lint-ignore-file require-await
// PR #129 R3 / H4-R2: the real index.ts handler (judge_pending path) against a mocked PostgREST and a mocked model, with
// the official body arriving through the real fillMissingCandidateBody WHILE the model is judging. No network.
import assert from "node:assert/strict";
import test from "node:test";
import { fillMissingCandidateBody } from "./candidate_body_fill.ts";

type Row = Record<string, unknown> & { id: string; status: string; body_summary: string | null };
const SECRET = "A".repeat(42) + "A";
const BODY = "【FOMC声明】3.75〜4%（据え置き）";
const BASE = "https://db.test";

function table(): Row[] {
  return [{
    id: "c1", source_type: "market_macro", source_url: "https://www.federalreserve.gov/newsevents/pressreleases/monetary20261009a.htm",
    source_name: "market_macro", title: "Federal Reserve issues FOMC statement", body_summary: null, company_name: null, company_code: null,
    entity_key: null, category: "frb", published_at: "2026-10-09T18:00:00Z", emergency_class: null, status: "pending_judgement",
    importance: "no_post", judgement_reason: null,
  }];
}

async function runJudgePending(rows: Row[], whileModelRuns: () => Promise<void>, extra: { saveFails?: boolean } = {}) {
  let handler: ((req: Request) => Promise<Response>) | null = null;
  const realServe = Deno.serve;
  const realFetch = globalThis.fetch;
  // deno-lint-ignore no-explicit-any
  (Deno as any).serve = (h: (req: Request) => Promise<Response>) => { handler = h; return { finished: Promise.resolve() }; };
  Deno.env.set("IMPORTANT_NEWS_CRON_SECRET", SECRET);
  Deno.env.set("SUPABASE_URL", BASE);
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-test");
  Deno.env.set("OPENAI_API_KEY", "sk-test-not-real");
  const requests: string[] = [];
  const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    requests.push(`${method} ${url.pathname}`);
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (url.hostname === "api.openai.com") {
      await whileModelRuns();
      return json({
        output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({
          importance: "no_post", category: "frb", affected_entities: [], japan_market_relevance: "low",
          reason: "見出しのみでは規模を確認できない", confidence: 0.9, needs_sol: false, fact_check_status: "passed",
        }) }] }],
        usage: { input_tokens: 100, output_tokens: 20 },
      });
    }
    if (url.pathname.endsWith("/important_news_monitor_settings")) return json([{ luna_enabled: true, sol_escalation_enabled: false }]);
    if (url.pathname.endsWith("/ai_usage_events")) return new Response(null, { status: 201 });
    if (url.pathname.endsWith("/important_news_candidates")) {
      const p = url.searchParams;
      const matches = (row: Row) =>
        (!p.get("id") || p.get("id") === `eq.${row.id}`) &&
        (!p.get("status") || p.get("status") === `eq.${row.status}`) &&
        (!p.get("source_name") || p.get("source_name") === `eq.${row.source_name}`) &&
        (p.get("or") !== "(body_summary.is.null,body_summary.eq.)" || row.body_summary === null || row.body_summary === "");
      if (method === "GET") return json(rows.filter(matches));
      if (method === "PATCH") {
        if (extra.saveFails && JSON.parse(String(init?.body)).judgement_model !== undefined) return new Response("x", { status: 500 });
        const hit = rows.filter(matches);
        for (const row of hit) Object.assign(row, JSON.parse(String(init?.body)));
        return json(hit);
      }
    }
    return json([]);
  }) as typeof fetch;
  globalThis.fetch = mockFetch;
  try {
    await import(`./index.ts?judgement-race-${crypto.randomUUID()}`);
    assert.ok(handler, "index.ts registered its handler");
    const response = await (handler as (req: Request) => Promise<Response>)(new Request("https://fn.test/", {
      method: "POST",
      headers: { "x-important-news-cron-secret": SECRET, "content-type": "application/json" },
      body: JSON.stringify({ mode: "judge_pending", limit: 5 }),
    }));
    return { body: await response.json() as { results: Array<Record<string, unknown>> }, requests };
  } finally {
    globalThis.fetch = realFetch;
    // deno-lint-ignore no-explicit-any
    (Deno as any).serve = realServe;
  }
}

test("H4-R2: the body arriving while the model judges blocks the stale no_post; the row stays pending and nothing is generated", async () => {
  const rows = table();
  const { body, requests } = await runJudgePending(rows, async () => {
    const result = await fillMissingCandidateBody(BASE, "k", "c1", BODY, globalThis.fetch);
    assert.equal(result, "filled");
  });
  assert.equal(rows[0].status, "pending_judgement");
  assert.equal(rows[0].importance, "no_post");
  assert.equal(rows[0].judgement_reason, null, "the headline-only reason is not saved onto the row that now has a body");
  assert.equal(rows[0].body_summary, BODY);
  assert.equal(body.results[0].error, "NEWS_JUDGEMENT_STALE_BODY_CHANGED");
  assert.equal(body.results[0].databaseUpdated, false);
  assert.equal(requests.some((entry) => entry.includes("generate") || entry.includes("published_posts")), false);
});

test("H4-R2: without a concurrent body the judgement is saved as before", async () => {
  const rows = table();
  const { body } = await runJudgePending(rows, async () => {});
  assert.equal(rows[0].status, "rejected");
  assert.equal(rows[0].judgement_reason, "見出しのみでは規模を確認できない");
  assert.equal(body.results[0].error, undefined);
});

test("H4-R2: a row that already had a body is judged and saved without the body condition", async () => {
  const rows = table();
  rows[0].body_summary = "元から本文あり";
  const { body, requests } = await runJudgePending(rows, async () => {});
  assert.equal(rows[0].status, "rejected");
  assert.equal(body.results[0].error, undefined);
  assert.equal(requests.filter((entry) => entry.startsWith("PATCH")).length, 1);
});

test("H4-R2: a row that moved on (not pending) is reported as changed, not as a stale body", async () => {
  const rows = table();
  const { body } = await runJudgePending(rows, async () => { rows[0].status = "published"; });
  assert.equal(body.results[0].error, "NEWS_JUDGEMENT_CANDIDATE_CHANGED");
  assert.equal(rows[0].status, "published");
});
