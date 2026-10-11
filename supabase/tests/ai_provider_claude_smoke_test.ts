// Offline tests of the one-call Claude connection smoke (no real API: every provider response is a fake fetch).
//   deno test --no-config --allow-read --allow-env=ANTHROPIC_CUSTOM_HEADERS,ANTHROPIC_WEBHOOK_SIGNING_KEY,ANTHROPIC_LOG,ANTHROPIC_BASE_URL,ANTHROPIC_AUTH_TOKEN,ANTHROPIC_API_KEY \
//     supabase/tests/ai_provider_claude_smoke_test.ts
// (the Anthropic SDK reads ANTHROPIC_CUSTOM_HEADERS etc. at construction; without the permission it fails before sending.)
import assert from "node:assert/strict";
import { validateAiRequest } from "../functions/_shared/ai_provider/mod.ts";
import { anthropicBody, anthropicError, jsonResponse } from "../functions/_shared/ai_provider/test_support.ts";
import {
  buildSmokeRequest,
  EXPECTED_PAYLOAD,
  formatReport,
  independentCostUsd,
  jstMonth,
  parseArgs,
  reconcile,
  runSmoke,
  SMOKE_CONFIRM,
  SMOKE_LOGICAL_ROLE,
  SMOKE_MAX_OUTPUT_TOKENS,
  SMOKE_MAX_USD,
  type SmokeOptions,
} from "./ai_provider_claude_smoke.ts";

const KEY = "test-anthropic-key-NOT-REAL-smoke-0000";
const LIVE: SmokeOptions = { mode: "live", ledger: "memory", confirm: SMOKE_CONFIRM };
const PLAN: SmokeOptions = { mode: "plan", ledger: "memory", confirm: null };

function env(values: Record<string, string | undefined> = { ANTHROPIC_API_KEY: KEY }) {
  return (name: string) => values[name];
}

type Seen = { url: string; headers: Headers; body: Record<string, unknown> | null };

/** A fake network: Anthropic answers with `anthropic`; any other host is a test failure. */
function network(anthropic: () => Response) {
  const seen: Seen[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    const raw = input instanceof Request ? await input.clone().text() : typeof init?.body === "string" ? init.body : null;
    seen.push({ url, headers, body: raw ? JSON.parse(raw) : null });
    if (new URL(url).hostname !== "api.anthropic.com") throw new Error(`unexpected host ${url}`);
    return anthropic();
  };
  return { fetch: fetchImpl, seen };
}

const noNetwork = network(() => {
  throw new Error("no request may be sent");
});

const okResponse = () =>
  jsonResponse(200, anthropicBody(EXPECTED_PAYLOAD), {
    "request-id": "req_smoke_test",
    "anthropic-organization-id": "org-test",
    "anthropic-workspace-id": "wrkspc_test",
  });

Deno.test("arguments: plan + memory by default; anything unknown is a usage error", () => {
  assert.deepEqual(parseArgs([]), { mode: "plan", ledger: "memory", confirm: null });
  assert.deepEqual(parseArgs(["--mode=live", "--ledger=supabase", `--confirm=${SMOKE_CONFIRM}`]), { mode: "live", ledger: "supabase", confirm: SMOKE_CONFIRM });
  assert.equal(typeof parseArgs(["--mode=paid"]), "string");
  assert.equal(typeof parseArgs(["--model=claude-sonnet-5-5"]), "string", "the model cannot be changed from the command line");
  assert.equal(typeof parseArgs(["--prompt=hello"]), "string", "there is no way to pass content");
});

Deno.test("the request is fixed: Opus 5.5, system subject, allowlist identity, one attempt, no retry, under the cap", () => {
  const request = buildSmokeRequest("smoke-test-1");
  assert.ok(!("code" in validateAiRequest(request)));
  assert.equal(request.provider, "anthropic");
  assert.equal(request.model, "claude-opus-5-5");
  assert.deepEqual(request.usageContext, { application: "kabumori", feature: "market_report", subject: { kind: "system" } });
  assert.equal(request.logicalRole, SMOKE_LOGICAL_ROLE);
  assert.deepEqual(request.transport, { maxAttempts: 1, retryOnTimeout: false });
  assert.equal(request.maxOutputTokens, SMOKE_MAX_OUTPUT_TOKENS);
  assert.equal(request.reasoningEffort, "low");
  // Fixed synthetic text only: no digits beyond the arithmetic, no names, no tickers, no ids.
  assert.equal(buildSmokeRequest("smoke-test-2").userContent, request.userContent);
  assert.doesNotMatch(request.systemInstructions + request.userContent, /@|\d{3,}|銘柄|保有|user_id|brand/u);
});

Deno.test("plan sends nothing and passes with a usable key", async () => {
  const report = await runSmoke(PLAN, { readEnv: env(), fetch: noNetwork.fetch });
  assert.equal(report.verdict, "PASS");
  assert.equal(report.exitCode, 0);
  assert.equal(report.providerRequests, 0);
  assert.equal(noNetwork.seen.length, 0);
  assert.ok(report.upperBoundUsd > 0 && report.upperBoundUsd <= SMOKE_MAX_USD, `${report.upperBoundUsd}`);
});

Deno.test("refused before sending: SDK-read headers env, missing key, Admin key, no confirmation", async () => {
  const cases: Array<[string, SmokeOptions, Record<string, string | undefined>]> = [
    ["custom headers set", LIVE, { ANTHROPIC_API_KEY: KEY, ANTHROPIC_CUSTOM_HEADERS: "x-extra: 1" }],
    ["base url set", LIVE, { ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: "https://proxy.example" }],
    ["auth token set", LIVE, { ANTHROPIC_API_KEY: KEY, ANTHROPIC_AUTH_TOKEN: "t" }],
    ["no key", LIVE, {}],
    ["admin key", LIVE, { ANTHROPIC_API_KEY: "sk-ant-admin01-NOT-REAL-000000000000" }],
    ["no confirmation", { mode: "live", ledger: "memory", confirm: null }, { ANTHROPIC_API_KEY: KEY }],
    ["wrong confirmation", { mode: "live", ledger: "memory", confirm: "yes" }, { ANTHROPIC_API_KEY: KEY }],
    ["ledger url not a project", { mode: "live", ledger: "supabase", confirm: SMOKE_CONFIRM },
      { ANTHROPIC_API_KEY: KEY, SUPABASE_URL: "https://evil.example.com", AI_LEDGER_SERVICE_KEY: "service-key-NOT-REAL-000000" }],
    ["ledger key missing", { mode: "live", ledger: "supabase", confirm: SMOKE_CONFIRM },
      { ANTHROPIC_API_KEY: KEY, SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co" }],
  ];
  for (const [label, options, values] of cases) {
    const net = network(okResponse);
    const report = await runSmoke(options, { readEnv: env(values), fetch: net.fetch });
    assert.equal(report.verdict, "REFUSED", label);
    assert.equal(report.exitCode, 2, label);
    assert.equal(net.seen.length, 0, `${label}: nothing sent`);
  }
});

Deno.test("live: exactly one request, reconciled tokens and cost, provider ids reported", async () => {
  const net = network(okResponse);
  const report = await runSmoke(LIVE, { readEnv: env(), fetch: net.fetch, callId: "smoke-live-1" });
  assert.equal(report.verdict, "PASS", formatReport(report));
  assert.equal(report.exitCode, 0);
  assert.equal(net.seen.length, 1);
  const sent = net.seen[0];
  assert.equal(new URL(sent.url).hostname, "api.anthropic.com");
  assert.equal(sent.headers.get("x-api-key"), KEY);
  assert.equal(sent.body?.model, "claude-opus-5-5");
  assert.equal(sent.body?.max_tokens, SMOKE_MAX_OUTPUT_TOKENS);
  assert.ok(report.checks.every((check) => check.ok), formatReport(report));
  const call = report.call!;
  assert.equal(call.provider_request_id, "req_smoke_test");
  assert.equal(call.workspace_id, "wrkspc_test");
  assert.equal(call.input_tokens, 800);
  assert.equal(call.output_tokens, 400);
  assert.equal(call.estimated_cost_usd, 0.0112, "800 x $4/M + 400 x $20/M");
  assert.equal(call.payload_matches_expected, true);
});

Deno.test("live provider errors: one request, no retry, FAIL, key never printed", async () => {
  const errors: Array<[number, string, string]> = [
    [529, "overloaded_error", "Overloaded"],
    [429, "rate_limit_error", "Number of request tokens has exceeded your per-minute rate limit"],
    [400, "invalid_request_error", "You have reached your specified workspace API usage limits"],
    [400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API."],
    [401, "authentication_error", "invalid x-api-key"],
  ];
  for (const [status, type, message] of errors) {
    const net = network(() => jsonResponse(status, anthropicError(status, type, `${message} ${KEY}`)));
    const report = await runSmoke(LIVE, { readEnv: env(), fetch: net.fetch });
    assert.equal(net.seen.length, 1, `${status} ${type}: no retry`);
    assert.equal(report.verdict, "FAIL", `${status}`);
    assert.equal(report.exitCode, 1);
    assert.ok(!formatReport(report).includes(KEY), "the key never appears in the report");
  }
});

Deno.test("reconcile catches provider-vs-layer usage, catalog cost and ledger mismatches", async () => {
  const net = network(okResponse);
  const report = await runSmoke(LIVE, { readEnv: env(), fetch: net.fetch });
  assert.equal(report.verdict, "PASS");
  // Rebuild a result to feed the pure function with tampered evidence.
  const { executeAiRequest, InMemoryBudgetGuard } = await import("../functions/_shared/ai_provider/mod.ts");
  const result = await executeAiRequest(buildSmokeRequest("smoke-reconcile"), {
    readEnv: env(),
    budget: new InMemoryBudgetGuard([{ id: "t", scope: {}, maxCalls: 1, maxEstimatedUsd: 1 }]),
    fetch: network(okResponse).fetch,
  });
  const observed = { status: 200, requestId: "r", organizationId: null, workspaceId: null, model: "claude-opus-5-5", stopReason: "end_turn",
    usage: { input_tokens: 801, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 400 } };
  const before = { attempts: 3, succeeded: 3, input_tokens: 10, output_tokens: 10, estimated_cost_usd: 0.1 };
  const checks = reconcile({
    result, upperBoundUsd: 0.04, anthropicRequests: 1, observed, ledgerBefore: before,
    ledgerAfter: { attempts: 5, succeeded: 5, input_tokens: 810, output_tokens: 410, estimated_cost_usd: 0.1112 },
  });
  const failed = checks.filter((check) => !check.ok).map((check) => check.name).sort();
  assert.deepEqual(failed, ["cost_matches_catalog", "ledger_one_attempt", "usage_matches_provider"]);
  const good = reconcile({
    result, upperBoundUsd: 0.04, anthropicRequests: 1, observed: { ...observed, usage: { ...observed.usage, input_tokens: 800 } },
    ledgerBefore: before, ledgerAfter: { attempts: 4, succeeded: 4, input_tokens: 810, output_tokens: 410, estimated_cost_usd: 0.1112 },
  });
  assert.ok(good.every((check) => check.ok), JSON.stringify(good));
  const twoRequests = reconcile({ result, upperBoundUsd: 0.04, anthropicRequests: 2, observed, ledgerBefore: null, ledgerAfter: null });
  assert.equal(twoRequests.find((check) => check.name === "one_provider_request")?.ok, false);
});

Deno.test("independent catalog price and JST month", () => {
  assert.equal(independentCostUsd({ input_tokens: 1_000_000, output_tokens: 0 }), 4);
  assert.equal(independentCostUsd({ input_tokens: 0, output_tokens: 1_000_000 }), 20);
  assert.equal(independentCostUsd({ input_tokens: 0, cache_read_input_tokens: 1_000_000, output_tokens: 0 }), 0.2);
  assert.equal(jstMonth(Date.UTC(2026, 9, 31, 15, 0, 0)), "2026-11-01", "15:00 UTC on 31 Oct is 1 Nov in JST");
  assert.equal(jstMonth(Date.UTC(2026, 9, 31, 14, 59, 59)), "2026-10-01");
});

Deno.test("the smoke imports only the shared provider (no market report, registry or delivery code)", async () => {
  const source = await Deno.readTextFile(new URL("./ai_provider_claude_smoke.ts", import.meta.url));
  const imports = [...source.matchAll(/^\s*(?:import|export)[^;]*?from\s+"([^"]+)"/gmu)].map((m) => m[1]);
  assert.deepEqual([...new Set(imports)], ["../functions/_shared/ai_provider/mod.ts"]);
  assert.doesNotMatch(source, /market-report-analysis|personalized-reports|x-test-post|send-push|model_registry/u);
});
