// Opus primary handler E2E (offline; F6 V0 patch + F2): the shared report handler with KABUMORI_MARKET_REPORT_AI_MODE
// set to a primary value. Real handleRequest, repository fixtures (morning and close), fake DB / OpenAI / Anthropic /
// ledger; any other host fails the test. No network, no real key.
import assert from "node:assert/strict";
import test from "node:test";
import { ANALYSIS_MODEL } from "./analysis_logic.ts";
import { buildAnalysisInput } from "./analysis_input.ts";
import { type Deps, handleRequest } from "./handler.ts";
import { rich0917, richMorning1001 } from "./test_support.ts";

const directory = new URL("./fixtures/", import.meta.url);
const load = async (name: string) => JSON.parse(await Deno.readTextFile(new URL(name, directory)));
const FIXTURES = {
  close: { data: await load("close_2026-09-17_data_packet.json"), news: await load("close_2026-09-17_news_rows.json"), make: rich0917, now: "2026-09-17T07:20:00Z" },
  morning: { data: await load("morning_2026-10-01_data_packet.json"), news: await load("morning_2026-10-01_news_rows.json"), make: richMorning1001, now: "2026-09-30T22:55:20Z" },
};
const SUPABASE = "https://project-ref.supabase.co";
const SECRET = "cron-secret-for-tests";
const SERVICE_KEY = "service-secret-NOT-REAL";
const OPENAI_KEY = "openai-test-key-NOT-REAL";
const ANTHROPIC_KEY = "sk-ant-api03-NOT-REAL-handler-0000000000";
const PRIMARY = "claude-opus-5-5";
const CYCLE = "11111111-1111-4111-8111-111111111111";

type Call = { url: string; body: Record<string, unknown> | null; headers: string };
type ReportType = "close" | "morning";

function harness(options: {
  reportType: ReportType;
  env?: Record<string, string | undefined>;
  /** Anthropic: a normal answer, overloaded, or a request that only ends when the caller's timeout aborts it. */
  claude?: "ok" | 529 | "hang";
  /** The ledger's answer to the n-th reservation (1-based); default allowed. A number is an HTTP failure status. */
  reserve?: (n: number) => { allowed: false; reason: string } | number | null;
  claimAttempt?: number;
  claimOutcome?: string;
  /** Milliseconds the clock moves when the data packet is read, and on every Anthropic request. */
  advance?: { onDataPacket?: number; onClaude?: number };
}) {
  const fixture = FIXTURES[options.reportType];
  const analysis = fixture.make(buildAnalysisInput({
    dataPacket: fixture.data.payload, dataPacketId: fixture.data.id, dataContentHash: fixture.data.content_hash, newsRows: fixture.news,
  }));
  const calls: Call[] = [];
  let reservations = 0;
  let offset = 0;
  const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });
  const fetchMock: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const raw = input instanceof Request ? await input.clone().text() : typeof init?.body === "string" ? init.body : "";
    const body = raw ? JSON.parse(raw) : null;
    const headers = JSON.stringify([...new Headers(input instanceof Request ? input.headers : init?.headers).entries()]);
    calls.push({ url, body, headers });
    if (url === "https://api.openai.com/v1/responses") {
      const isFact = String(body?.instructions).includes("Factチェッカー");
      const payload = isFact ? { passed: true, issues: [], objective_issues: [] } : analysis;
      return json({ output: [{ content: [{ type: "output_text", text: JSON.stringify(payload) }] }], usage: { input_tokens: 900, output_tokens: 300 } });
    }
    if (url.startsWith("https://api.anthropic.com/")) {
      offset += options.advance?.onClaude ?? 0;
      if (options.claude === 529) return json({ type: "error", error: { type: "overloaded_error", message: "fake" } }, 529);
      if (options.claude === "hang") {
        const signal = input instanceof Request ? input.signal : init?.signal;
        return await new Promise<Response>((_, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason ?? new DOMException("aborted", "AbortError")), { once: true });
        });
      }
      const system = typeof body.system === "string" ? body.system : (body.system as Array<{ text: string }>).map((part) => part.text).join("");
      const payload = system.includes("Factチェッカー") ? { passed: true, issues: [], objective_issues: [] } : analysis;
      return json({
        id: "msg_fake", type: "message", role: "assistant", model: PRIMARY, stop_reason: "end_turn", stop_sequence: null,
        content: [{ type: "text", text: JSON.stringify(payload) }],
        usage: { input_tokens: 20_000, output_tokens: 9_000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      }, 200, { "request-id": "req_handler_e2e" });
    }
    if (!url.startsWith(`${SUPABASE}/rest/v1/`)) throw new Error(`UNEXPECTED_HOST:${url}`);
    const path = url.slice(`${SUPABASE}/rest/v1/`.length);
    if (path === "rpc/ai_ledger_reserve") {
      const n = ++reservations;
      const answer = options.reserve?.(n) ?? null;
      if (typeof answer === "number") return json({ code: "XX000" }, answer);
      if (answer) return json({ ...answer, policy_key: "system:market_report:opus" });
      return json({ allowed: true, reservation_id: `00000000-0000-4000-8000-00000000000${n}`, status: "reserved" });
    }
    if (path === "rpc/ai_ledger_mark_sent") return json({ status: "sent", may_send: true });
    if (path === "rpc/ai_ledger_settle") return json({ status: "settled", duplicate: false });
    if (path === "rpc/ai_ledger_release") return json({ status: "released" });
    if (path.startsWith("market_holidays")) return json([{ holiday_date: "2026-09-21" }]);
    if (path === "rpc/claim_market_report_analysis") {
      return json([{
        cycle_id: CYCLE, claim_token: "22222222-2222-4222-8222-222222222222", attempt: options.claimAttempt ?? 1,
        outcome: options.claimOutcome ?? "claimed", data_packet_id: fixture.data.id,
      }]);
    }
    if (path.startsWith("market_data_packets")) {
      offset += options.advance?.onDataPacket ?? 0;
      return json([{ id: fixture.data.id, content_hash: fixture.data.content_hash, payload: fixture.data.payload, data_quality_status: "partial" }]);
    }
    if (path.startsWith("important_news_candidates")) return json(fixture.news);
    if (path === "rpc/complete_market_report_analysis") return json("33333333-3333-4333-8333-333333333333");
    if (path === "rpc/fail_market_report_analysis") return json("failed");
    if (path.startsWith("market_report_generation_traces")) return new Response(null, { status: 201 });
    throw new Error(`UNEXPECTED_PATH:${path}`);
  };
  const env: Record<string, string | undefined> = {
    SUPABASE_URL: SUPABASE,
    SUPABASE_SECRET_KEYS: JSON.stringify({ default: SERVICE_KEY }), KABUMORI_MARKET_REPORT_NEWS_SELECTION: "all",
    SEND_PUSH_NOTIFICATIONS_CRON_SECRET: SECRET,
    OPENAI_API_KEY: OPENAI_KEY,
    ANTHROPIC_API_KEY: ANTHROPIC_KEY,
    KABUMORI_MARKET_REPORT_AI_MODE: "primary_close",
    KABUMORI_MARKET_REPORT_PRIMARY_MODEL: PRIMARY,
    ...options.env,
  };
  const base = new Date(fixture.now).getTime();
  const deps: Deps = { env: (name) => env[name], fetch: fetchMock, now: () => new Date(base + offset), sleep: () => Promise.resolve() };
  const req = new Request("https://functions.local/market-report-analysis", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Cron-Secret": SECRET }, body: JSON.stringify({ mode: options.reportType }),
  });
  const of = (prefix: string) => calls.filter((call) => call.url.startsWith(prefix));
  return {
    calls, deps, req,
    openai: () => of("https://api.openai.com/"),
    claude: () => of("https://api.anthropic.com/"),
    ledger: () => of(`${SUPABASE}/rest/v1/rpc/ai_ledger_`),
    reserves: () => of(`${SUPABASE}/rest/v1/rpc/ai_ledger_reserve`).map((call) => (call.body as { p: Record<string, unknown> }).p),
    rpc: (name: string) => calls.find((call) => call.url === `${SUPABASE}/rest/v1/rpc/${name}`)?.body ?? null,
  };
}

async function withLogs<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    return { value: await fn(), lines };
  } finally {
    console.log = original;
  }
}

const primaryEvents = (lines: string[]) =>
  lines.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter((line) => line?.event === "market_report_primary");

/** The Anthropic key reaches only Anthropic's host; no row, log or other request carries any key value. */
function assertNoKeyLeak(h: ReturnType<typeof harness>, lines: string[]) {
  for (const call of h.calls) {
    const text = call.url + JSON.stringify(call.body);
    for (const secret of [ANTHROPIC_KEY, OPENAI_KEY, SERVICE_KEY]) assert.ok(!text.includes(secret), `key in a request body: ${call.url}`);
    if (!call.url.startsWith("https://api.anthropic.com/")) assert.ok(!call.headers.includes(ANTHROPIC_KEY), `Anthropic key sent to ${call.url}`);
  }
  for (const secret of [ANTHROPIC_KEY, OPENAI_KEY, SERVICE_KEY]) assert.ok(!lines.join("\n").includes(secret), "no key in logs");
}

// ---- primary_close (F6 V0) -----------------------------------------------------------------------------------------

test("close + primary_close: Claude writes the stored report; model, audit and cost say so; no OpenAI call", async () => {
  const h = harness({ reportType: "close" });
  const { value: res, lines } = await withLogs(() => handleRequest(h.req, h.deps));
  const body = await res.json();
  assert.equal(body.status, "completed", JSON.stringify(body));
  assert.equal(h.openai().length, 0);
  assert.equal(h.claude().length, 2);
  assert.equal(h.ledger().length, 6);
  const complete = h.rpc("complete_market_report_analysis")!;
  assert.equal(complete.p_model, PRIMARY);
  assert.equal((complete.p_payload as { model: string }).model, PRIMARY);
  assert.equal((complete.p_payload as { schema_version: string }).schema_version, "market_report_packet.v1");
  const diagnostics = complete.p_diagnostics as Record<string, string>;
  assert.equal(diagnostics.model, PRIMARY);
  assert.equal(diagnostics.ai_generate_model, PRIMARY);
  assert.equal(diagnostics.ai_fact_model, PRIMARY);
  assert.equal(diagnostics.ai_primary, `anthropic:${PRIMARY}`);
  assert.equal(diagnostics.primary_calls, "2");
  assert.equal(diagnostics.primary_last_error, undefined);
  assert.equal(Number(diagnostics.cost_usd), complete.p_api_cost_usd);
  assert.ok((complete.p_api_cost_usd as number) > 0.26, "Claude's settled cost, not OpenAI prices");
  assert.equal(body.costUsd, complete.p_api_cost_usd);
  // The ledger sees one system market report call per step, keyed by cycle, claim attempt, step and sequence.
  assert.deepEqual(h.reserves().map((p) => [p.request_id, p.provider, p.model, p.application, p.feature, p.subject_kind]), [
    [`mrp:${CYCLE}:a1:generate:1`, "anthropic", PRIMARY, "kabumori", "market_report", "system"],
    [`mrp:${CYCLE}:a1:fact:1`, "anthropic", PRIMARY, "kabumori", "market_report", "system"],
  ]);
  // Logs: one line per Claude call, identifiers and numbers only.
  assert.deepEqual(primaryEvents(lines).map((e) => [e.step, e.ok, e.callId]), [
    ["generate", true, `mrp:${CYCLE}:a1:generate:1`],
    ["fact", true, `mrp:${CYCLE}:a1:fact:1`],
  ]);
  assertNoKeyLeak(h, lines);
  assert.ok(!lines.join("\n").includes("あなたは日本株の市場レポート編集者です"), "no prompt in logs");
});

test("morning + primary_close: the morning report stays on OpenAI", async () => {
  const h = harness({ reportType: "morning" });
  const body = await (await handleRequest(h.req, h.deps)).json();
  assert.equal(body.status, "completed", JSON.stringify(body));
  assert.deepEqual([h.openai().length, h.claude().length, h.ledger().length], [2, 0, 0]);
  assert.equal(h.rpc("complete_market_report_analysis")!.p_model, ANALYSIS_MODEL);
});

// ---- OFF and other values: today's OpenAI path, unchanged -----------------------------------------------------------

for (const reportType of ["close", "morning"] as const) {
  for (const mode of [undefined, "", "off", "shadow", "PRIMARY_CLOSE", "primary_close ", "primary-both", "Primary_Both"]) {
    test(`${reportType} + mode ${JSON.stringify(mode)}: exactly today's OpenAI path (model, audit, cost, calls)`, async () => {
      const h = harness({ reportType, env: { KABUMORI_MARKET_REPORT_AI_MODE: mode } });
      const { value: res, lines } = await withLogs(() => handleRequest(h.req, h.deps));
      const body = await res.json();
      assert.equal(body.status, "completed", JSON.stringify(body));
      assert.deepEqual([h.openai().length, h.claude().length, h.ledger().length], [2, 0, 0]);
      const complete = h.rpc("complete_market_report_analysis")!;
      assert.equal(complete.p_model, ANALYSIS_MODEL);
      assert.equal((complete.p_payload as { model: string }).model, ANALYSIS_MODEL);
      const diagnostics = complete.p_diagnostics as Record<string, string>;
      assert.equal(diagnostics.ai_generate_model, ANALYSIS_MODEL);
      for (const key of ["ai_primary", "primary_calls", "primary_last_error"]) assert.equal(diagnostics[key], undefined, key);
      assert.equal(Number(diagnostics.cost_usd), complete.p_api_cost_usd);
      assert.equal(primaryEvents(lines).length, 0);
    });
  }
}

test("OFF with no Anthropic key, model or ledger configured at all: unchanged OpenAI path", async () => {
  const h = harness({
    reportType: "close",
    env: { KABUMORI_MARKET_REPORT_AI_MODE: undefined, ANTHROPIC_API_KEY: undefined, KABUMORI_MARKET_REPORT_PRIMARY_MODEL: undefined },
  });
  const body = await (await handleRequest(h.req, h.deps)).json();
  assert.equal(body.status, "completed");
  assert.deepEqual([h.openai().length, h.claude().length, h.ledger().length], [2, 0, 0]);
});

// ---- primary_both: the morning and the close report on Claude ---------------------------------------------------------

for (const reportType of ["close", "morning"] as const) {
  test(`${reportType} + primary_both: Claude writes the stored report; model, audit and cost say so; no OpenAI call`, async () => {
    const h = harness({ reportType, env: { KABUMORI_MARKET_REPORT_AI_MODE: "primary_both" } });
    const { value: res, lines } = await withLogs(() => handleRequest(h.req, h.deps));
    const body = await res.json();
    assert.equal(body.status, "completed", JSON.stringify(body));
    assert.deepEqual([h.openai().length, h.claude().length, h.ledger().length], [0, 2, 6]);
    const complete = h.rpc("complete_market_report_analysis")!;
    assert.equal(complete.p_model, PRIMARY);
    assert.equal((complete.p_payload as { model: string }).model, PRIMARY);
    assert.equal((complete.p_payload as { report_type: string }).report_type, reportType);
    const diagnostics = complete.p_diagnostics as Record<string, string>;
    assert.deepEqual([diagnostics.ai_generate_model, diagnostics.ai_fact_model, diagnostics.ai_primary], [PRIMARY, PRIMARY, `anthropic:${PRIMARY}`]);
    assert.equal(Number(diagnostics.cost_usd), complete.p_api_cost_usd);
    assert.ok((complete.p_api_cost_usd as number) > 0.26, "Claude's settled cost, not OpenAI prices");
    assert.deepEqual([diagnostics.primary_calls, diagnostics.primary_last_error], ["2", undefined]);
    // Generate then Fact, each through the ledger under its own primary role; the second call is the Fact check.
    assert.deepEqual(h.reserves().map((p) => [p.request_id, p.logical_role, p.provider, p.model, p.subject_kind]), [
      [`mrp:${CYCLE}:a1:generate:1`, "kabumori.market_report.generate.primary", "anthropic", PRIMARY, "system"],
      [`mrp:${CYCLE}:a1:fact:1`, "kabumori.market_report.fact.primary", "anthropic", PRIMARY, "system"],
    ]);
    const systems = h.claude().map((call) => {
      const system = call.body?.system;
      return typeof system === "string" ? system : (system as Array<{ text: string }>).map((part) => part.text).join("");
    });
    assert.deepEqual(systems.map((text) => text.includes("Factチェッカー")), [false, true]);
    assert.deepEqual(primaryEvents(lines).map((e) => [e.step, e.ok]), [["generate", true], ["fact", true]]);
    assertNoKeyLeak(h, lines);
  });
}

test("morning + primary_both without the Anthropic key: fails closed (KEY_MISSING), no OpenAI fallback", async () => {
  const h = harness({ reportType: "morning", env: { KABUMORI_MARKET_REPORT_AI_MODE: "primary_both", ANTHROPIC_API_KEY: undefined } });
  const res = await handleRequest(h.req, h.deps);
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, "ANALYSIS_PRIMARY_CONFIG:KEY_MISSING");
  assert.deepEqual([h.openai().length, h.claude().length, h.ledger().length], [0, 0, 0]);
});

test("morning + primary_both, Claude overloaded: the cycle fails, one request, no OpenAI fallback", async () => {
  const h = harness({ reportType: "morning", env: { KABUMORI_MARKET_REPORT_AI_MODE: "primary_both" }, claude: 529 });
  const { value: res, lines } = await withLogs(() => handleRequest(h.req, h.deps));
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, "ANALYSIS_PRIMARY_GENERATE_FAILED:OVERLOADED");
  assert.deepEqual([h.openai().length, h.claude().length], [0, 1]);
  assert.equal(h.rpc("complete_market_report_analysis"), null);
  assert.match((h.rpc("fail_market_report_analysis")!.p_diagnostics as Record<string, string>).primary_last_error, /^OVERLOADED:/u);
  assertNoKeyLeak(h, lines);
});

test("morning + primary_both, the day's cap already reached: nothing is sent, BUDGET_DENIED:CALL_LIMIT, no OpenAI", async () => {
  const h = harness({ reportType: "morning", env: { KABUMORI_MARKET_REPORT_AI_MODE: "primary_both" }, reserve: () => ({ allowed: false, reason: "CALL_LIMIT" }) });
  const res = await handleRequest(h.req, h.deps);
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, "ANALYSIS_PRIMARY_GENERATE_FAILED:BUDGET_DENIED");
  assert.deepEqual([h.openai().length, h.claude().length, h.reserves().length], [0, 0, 1]);
  assert.equal((h.rpc("fail_market_report_analysis")!.p_diagnostics as Record<string, string>).primary_last_error, "BUDGET_DENIED:CALL_LIMIT");
});

// ---- configuration gaps: fail closed -------------------------------------------------------------------------------

for (const [label, env, reason] of [
  ["no Anthropic key", { ANTHROPIC_API_KEY: undefined }, "KEY_MISSING"],
  ["no primary model", { KABUMORI_MARKET_REPORT_PRIMARY_MODEL: undefined }, "MODEL_INVALID"],
  ["an OpenAI model as primary", { KABUMORI_MARKET_REPORT_PRIMARY_MODEL: ANALYSIS_MODEL }, "MODEL_INVALID"],
] as const) {
  test(`primary_close with ${label}: ANALYSIS_PRIMARY_CONFIG:${reason}, no model call, no OpenAI fallback`, async () => {
    const h = harness({ reportType: "close", env });
    const res = await handleRequest(h.req, h.deps);
    const body = await res.json();
    assert.equal(res.status, 500);
    assert.equal(body.error, `ANALYSIS_PRIMARY_CONFIG:${reason}`);
    assert.deepEqual([h.openai().length, h.claude().length, h.ledger().length], [0, 0, 0]);
    assert.equal(h.rpc("fail_market_report_analysis")!.p_error, `ANALYSIS_PRIMARY_CONFIG:${reason}`);
    assert.equal(h.rpc("complete_market_report_analysis"), null);
  });
}

// ---- provider failures, limits and timeouts ------------------------------------------------------------------------

test("Claude overloaded: the cycle fails (next cron run retries), one request, no OpenAI fallback, cost recorded", async () => {
  const h = harness({ reportType: "close", claude: 529 });
  const { value: res, lines } = await withLogs(() => handleRequest(h.req, h.deps));
  const body = await res.json();
  assert.equal(res.status, 500);
  assert.equal(body.error, "ANALYSIS_PRIMARY_GENERATE_FAILED:OVERLOADED");
  assert.deepEqual([h.openai().length, h.claude().length], [0, 1]);
  const failed = h.rpc("fail_market_report_analysis")!;
  assert.equal(failed.p_error, "ANALYSIS_PRIMARY_GENERATE_FAILED:OVERLOADED");
  const diagnostics = failed.p_diagnostics as Record<string, string>;
  assert.equal(diagnostics.primary_calls, "1");
  assert.match(diagnostics.primary_last_error, /^OVERLOADED:/u);
  assert.equal(diagnostics.ai_generate_model, PRIMARY);
  assert.equal(h.rpc("complete_market_report_analysis"), null);
  assertNoKeyLeak(h, lines);
});

for (const reason of ["CALL_LIMIT", "COST_LIMIT", "PER_CALL_LIMIT"]) {
  test(`ledger refuses the generate call (${reason}): nothing is sent, the cycle fails with the limit named`, async () => {
    const h = harness({ reportType: "close", reserve: () => ({ allowed: false, reason }) });
    const res = await handleRequest(h.req, h.deps);
    const body = await res.json();
    assert.equal(res.status, 500);
    assert.equal(body.error, "ANALYSIS_PRIMARY_GENERATE_FAILED:BUDGET_DENIED");
    assert.deepEqual([h.openai().length, h.claude().length, h.reserves().length], [0, 0, 1]);
    const diagnostics = h.rpc("fail_market_report_analysis")!.p_diagnostics as Record<string, string>;
    assert.equal(diagnostics.primary_last_error, `BUDGET_DENIED:${reason}`);
    assert.equal(diagnostics.primary_calls, "1");
    assert.equal(Number(diagnostics.cost_usd), 0, "a refused call costs nothing");
  });
}

test("ledger unreachable: GUARD_UNAVAILABLE, nothing is sent (fail closed, never an unmetered call)", async () => {
  const h = harness({ reportType: "close", reserve: () => 503 });
  const res = await handleRequest(h.req, h.deps);
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, "ANALYSIS_PRIMARY_GENERATE_FAILED:BUDGET_DENIED");
  assert.deepEqual([h.openai().length, h.claude().length], [0, 0]);
  assert.equal((h.rpc("fail_market_report_analysis")!.p_diagnostics as Record<string, string>).primary_last_error, "BUDGET_DENIED:GUARD_UNAVAILABLE");
});

test("the day's cap is reached at the Fact call: the generated report is delivered with Fact not run (existing contract)", async () => {
  const h = harness({ reportType: "close", reserve: (n) => n === 2 ? { allowed: false, reason: "CALL_LIMIT" } : null });
  const body = await (await handleRequest(h.req, h.deps)).json();
  assert.equal(body.status, "completed", JSON.stringify(body));
  assert.deepEqual([h.openai().length, h.claude().length, h.reserves().length], [0, 1, 2]);
  const complete = h.rpc("complete_market_report_analysis")!;
  assert.equal(complete.p_model, PRIMARY);
  const diagnostics = complete.p_diagnostics as Record<string, string>;
  assert.equal(diagnostics.primary_last_error, "BUDGET_DENIED:CALL_LIMIT");
  assert.equal((complete.p_payload as { fact?: { ai_status?: string } }).fact?.ai_status, "not_run");
});

test("run budget already spent before the first call (slow data reads): nothing is sent, DEADLINE_EXCEEDED", async () => {
  const h = harness({ reportType: "close", advance: { onDataPacket: 126_000 } });
  const res = await handleRequest(h.req, h.deps);
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, "ANALYSIS_PRIMARY_GENERATE_FAILED:DEADLINE_EXCEEDED");
  assert.deepEqual([h.openai().length, h.claude().length, h.ledger().length], [0, 0, 0]);
  assert.equal((h.rpc("fail_market_report_analysis")!.p_diagnostics as Record<string, string>).primary_last_error, "DEADLINE_EXCEEDED:run_budget");
});

test("a slow generation leaves no time for Fact: the Fact call is not started; the report is delivered with Fact not run", async () => {
  const h = harness({ reportType: "close", advance: { onClaude: 126_000 } });
  const body = await (await handleRequest(h.req, h.deps)).json();
  assert.equal(body.status, "completed", JSON.stringify(body));
  assert.deepEqual([h.openai().length, h.claude().length, h.reserves().length], [0, 1, 1]);
  const complete = h.rpc("complete_market_report_analysis")!;
  assert.equal((complete.p_diagnostics as Record<string, string>).primary_last_error, "DEADLINE_EXCEEDED:run_budget");
  assert.equal((complete.p_payload as { fact?: { ai_status?: string } }).fact?.ai_status, "not_run");
});

test("Claude does not answer: the call is aborted at the time left (bounded), one request, the cycle fails", async () => {
  // 7 s left of the run budget: the request's own timeout is those 7 s, not 90 s (real timer, so kept short).
  const h = harness({ reportType: "close", claude: "hang", advance: { onDataPacket: 123_000 } });
  const started = Date.now();
  const res = await handleRequest(h.req, h.deps);
  const elapsed = Date.now() - started;
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, "ANALYSIS_PRIMARY_GENERATE_FAILED:TIMEOUT");
  assert.ok(elapsed < 15_000, `bounded by the run budget, took ${elapsed} ms`);
  assert.deepEqual([h.openai().length, h.claude().length], [0, 1]);
  assert.equal((h.rpc("fail_market_report_analysis")!.p_diagnostics as Record<string, string>).primary_last_error?.split(":")[0], "TIMEOUT");
});

// ---- idempotency -----------------------------------------------------------------------------------------------------

test("the retry run (claim attempt 2) uses new call ids, so the ledger meters it as a new attempt", async () => {
  const h = harness({ reportType: "close", claimAttempt: 2 });
  const body = await (await handleRequest(h.req, h.deps)).json();
  assert.equal(body.status, "completed", JSON.stringify(body));
  assert.deepEqual(h.reserves().map((p) => p.request_id), [`mrp:${CYCLE}:a2:generate:1`, `mrp:${CYCLE}:a2:fact:1`]);
});

test("a replay of a finished attempt is refused by the ledger before any send (no double charge)", async () => {
  const h = harness({ reportType: "close", reserve: () => ({ allowed: false, reason: "ATTEMPT_FINALIZED" }) });
  const res = await handleRequest(h.req, h.deps);
  assert.equal(res.status, 500);
  assert.deepEqual([h.openai().length, h.claude().length], [0, 0]);
  assert.equal((h.rpc("fail_market_report_analysis")!.p_diagnostics as Record<string, string>).primary_last_error, "BUDGET_DENIED:ATTEMPT_FINALIZED");
});

for (const outcome of ["already_completed", "in_progress", "max_attempts"]) {
  test(`claim not granted (${outcome}): skipped before any model or ledger call`, async () => {
    const h = harness({ reportType: "close", claimOutcome: outcome });
    const body = await (await handleRequest(h.req, h.deps)).json();
    assert.equal(body.status, "skipped");
    assert.deepEqual([h.openai().length, h.claude().length, h.ledger().length], [0, 0, 0]);
  });
}
