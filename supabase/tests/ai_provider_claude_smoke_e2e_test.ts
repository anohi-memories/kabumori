// End-to-end of the Claude connection smoke with the database ledger: runSmoke(--ledger=supabase) -> PostgREST shim
// -> the real migration + the Phase 1d test-phase policies in a disposable PostgreSQL. Anthropic is a fake fetch
// (no real API). Run by ai_provider_budget_ledger_run.sh (part "phase1d"), twice: AIL_SMOKE_EXPECT=pass with the
// policies enabled, AIL_SMOKE_EXPECT=denied after the stop switch. Ignored when its environment is absent.
import assert from "node:assert/strict";
import { anthropicBody, jsonResponse } from "../functions/_shared/ai_provider/test_support.ts";
import { EXPECTED_PAYLOAD, formatReport, runSmoke, SMOKE_CONFIRM } from "./ai_provider_claude_smoke.ts";

const URL_BASE = Deno.env.get("AIL_E2E_URL");
const KEY = Deno.env.get("AIL_E2E_KEY");
const EXPECT = Deno.env.get("AIL_SMOKE_EXPECT");
const enabled = !!URL_BASE && !!KEY && (EXPECT === "pass" || EXPECT === "denied");
const ANTHROPIC_KEY = "test-anthropic-key-NOT-REAL-e2e-00000";

function deps(anthropicCalls: string[]) {
  const values: Record<string, string> = { ANTHROPIC_API_KEY: ANTHROPIC_KEY, SUPABASE_URL: URL_BASE ?? "", AI_LEDGER_SERVICE_KEY: KEY ?? "" };
  return {
    readEnv: (name: string) => values[name],
    allowLoopbackLedger: true,
    fetch: (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "api.anthropic.com") {
        anthropicCalls.push(url.pathname);
        return Promise.resolve(jsonResponse(200, anthropicBody(EXPECTED_PAYLOAD), { "request-id": "req_e2e_smoke", "anthropic-workspace-id": "wrkspc_e2e" }));
      }
      if (url.hostname !== "127.0.0.1") throw new Error(`unexpected host ${url.hostname}`);
      return fetch(input, init);
    },
  };
}

Deno.test({ name: "smoke e2e: one call reserved, sent, settled and reconciled against the ledger summary", ignore: !enabled || EXPECT !== "pass" }, async () => {
  const calls: string[] = [];
  const report = await runSmoke({ mode: "live", ledger: "supabase", confirm: SMOKE_CONFIRM }, { ...deps(calls), callId: "smoke-e2e-1" });
  assert.equal(report.verdict, "PASS", formatReport(report));
  assert.deepEqual(calls, ["/v1/messages"]);
  const names = report.checks.map((check) => check.name);
  for (const name of ["ledger_one_attempt", "ledger_tokens_match", "ledger_cost_matches", "usage_matches_provider", "cost_matches_catalog"]) {
    assert.ok(names.includes(name), `${name} was checked`);
  }
  assert.deepEqual(report.call?.ledger_after, { attempts: 1, succeeded: 1, input_tokens: 800, output_tokens: 400, estimated_cost_usd: 0.0112 });

  // A second smoke in the same month: the delta is still exactly this call.
  const again = await runSmoke({ mode: "live", ledger: "supabase", confirm: SMOKE_CONFIRM }, { ...deps(calls), callId: "smoke-e2e-2" });
  assert.equal(again.verdict, "PASS", formatReport(again));
  assert.equal(calls.length, 2);
});

Deno.test({ name: "smoke e2e: with every policy disabled the ledger refuses before anything is sent", ignore: !enabled || EXPECT !== "denied" }, async () => {
  const calls: string[] = [];
  const report = await runSmoke({ mode: "live", ledger: "supabase", confirm: SMOKE_CONFIRM }, { ...deps(calls), callId: "smoke-e2e-stopped" });
  assert.equal(report.verdict, "REFUSED", formatReport(report));
  assert.equal(report.exitCode, 2);
  assert.equal(calls.length, 0, "no provider request");
  assert.match(report.checks[0].detail, /BUDGET_DENIED/u);
});
