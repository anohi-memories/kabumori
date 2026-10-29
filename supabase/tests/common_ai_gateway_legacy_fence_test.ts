// G6-22 (2026-10-29): H2 #329 PR #553 P2 F1. The unsafe legacy ledger mode ("legacy_busy_check_unsafe", kept for the
// older LOCAL suites) must not be selectable by a production-shaped composition: createAiGateway refuses it for any
// non-loopback Supabase URL, before anything is asked or sent. The default (owner_held) is unchanged. The A -> B -> A
// stale claimant with the same production-shaped URL is in common_ai_gateway_busy_aba_offline_test.ts.
// No network, no DB, fake URLs and keys, no real AI.
//   deno test --cached-only --frozen --config supabase/functions/_shared/ai_consumer_bridge/deno.json --deny-net \
//     --deny-write --allow-env=ANTHROPIC_CUSTOM_HEADERS,ANTHROPIC_WEBHOOK_SIGNING_KEY --allow-read=supabase/functions/_shared/ai_gateway \
//     supabase/tests/common_ai_gateway_legacy_fence_test.ts
import assert from "node:assert/strict";
import { SecretValue } from "../functions/_shared/ai_provider/secrets.ts";
import { FAKE_ANTHROPIC_KEY, FAKE_OPENAI_KEY, jsonResponse, openAiBody, recordingFetch } from "../functions/_shared/ai_provider/test_support.ts";
import { buildAppPolicySet, type FeatureContent } from "../functions/_shared/ai_gateway/app_policies.ts";
import type { AuthorityPort, AuthVerdict } from "../functions/_shared/ai_gateway/gateway.ts";
import { AiGatewayConfigError, type AiGatewayOptions, createAiGateway } from "../functions/_shared/ai_gateway/runtime.ts";

const PROD_URL = "https://abcdefghijklmnopqrst.supabase.co";
const PROD_KEY = "sb_secret_" + "FAKE_0000000000";
const LOCAL_KEY = "local-g6-22-service-NOT-A-SECRET";
const USER = "11111111-1111-4111-8111-111111111111";
const BRAND = { app: "postona" as const, slug: "u_ae343f5caedb67d4af33fc7a" };
const content: FeatureContent = {
  systemInstructions: "Test instructions; answer JSON { reply }.",
  schema: { name: "reply", schema: { type: "object", additionalProperties: false, required: ["reply"], properties: { reply: { type: "string" } } } },
  validate: (p) => typeof (p as { reply?: unknown })?.reply === "string",
};
const SET = buildAppPolicySet({
  "postona:consult": {
    enabled: true, revision: "test-r1", provider: "openai", model: "gpt-6-luna", reasoningEffort: "low", maxOutputTokens: 300, timeoutMs: 20_000,
    maxAttempts: 1, maxCostUsdPerOperation: 0.05, maxInputBytes: 8_000, entitlements: ["postona:x_autopost"],
  },
}, { "postona:consult": content });
const ALLOW: AuthorityPort = {
  verdict: () => Promise.resolve({ decision: "allow", subject: { kind: "user", app: "postona", userId: USER, brand: BRAND }, generation: "g", expiresAtMs: Date.now() + 60_000 } as AuthVerdict),
  recheck: (prior) => Promise.resolve(prior),
};

/**
 * A Supabase that has only the plain ledger and call store (no owner-held candidate): every RPC the legacy mode needs
 * answers as a healthy deployment would; the *_held RPCs are 404. Records the RPC names in order.
 */
function plainSupabase() {
  const rpcs: string[] = [];
  let claims = 0;
  const fetch = (input: string | URL | Request, _init?: RequestInit) => {
    const name = new URL(String(input)).pathname.replace("/rest/v1/rpc/", "");
    rpcs.push(name);
    const ok = (v: unknown) => Promise.resolve(jsonResponse(200, v));
    switch (name) {
      case "ai_calls_claim":
        claims++;
        return ok(claims === 1 ? { kind: "acquired", owner: "00000000-0000-4000-8000-0000000000a1" } : { kind: "busy" });
      case "ai_ledger_reserve":
        return ok({ allowed: true, reservation_id: "00000000-0000-4000-8000-000000000001" });
      case "ai_ledger_mark_sent":
        return ok({ may_send: true, status: "sent" });
      case "ai_ledger_settle":
        return ok({ settled: true });
      case "ai_ledger_release":
        return ok({ released: true });
      case "ai_calls_complete":
        return ok({ state: "complete", duplicate: false });
      default:
        return Promise.resolve(jsonResponse(404, { code: "PGRST202", message: "not found" }));
    }
  };
  return { fetch, rpcs };
}

function compose(over: Partial<AiGatewayOptions>) {
  const supabase = plainSupabase();
  const provider = recordingFetch(() => jsonResponse(200, openAiBody({ reply: "ok" }, { model: "gpt-6-luna" })));
  const url = over.supabaseUrl ?? PROD_URL;
  const options: AiGatewayOptions = {
    supabaseUrl: url,
    serviceKey: new SecretValue("AI_GATEWAY_SERVICE_KEY", PROD_KEY),
    readEnv: (name) => (name === "OPENAI_API_KEY" ? FAKE_OPENAI_KEY : name === "ANTHROPIC_API_KEY" ? FAKE_ANTHROPIC_KEY : undefined),
    authority: ALLOW,
    policies: SET.registry,
    fetch: (input, init) => (String(input).startsWith(url) ? supabase.fetch(input, init) : provider.fetch(input, init)),
    retryTiming: { baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 10, minAttemptMs: 1 },
    sleep: () => Promise.resolve(),
    random: () => 0,
    ...over,
  };
  return { options, supabase, provider };
}

const run = (gateway: ReturnType<typeof createAiGateway>) =>
  gateway.execute("credential", { app: "postona", feature: "consult", operationId: "op-g6-22-0001", input: "相談", brand: BRAND });

Deno.test("H2 F1 negative 1: a production-shaped (non-loopback) composition cannot select the legacy mode: refused at createAiGateway, nothing asked or sent; the default owner-held mode on the same Supabase without the candidate is UNKNOWN with 0 sends (control)", async () => {
  const control = compose({});
  const r = await run(createAiGateway(control.options));
  assert.deepEqual([r.ok ? "OK" : r.code, control.provider.calls.length], ["UNKNOWN", 0], "control: owner-held, candidate absent");
  assert.ok(control.supabase.rpcs.includes("ai_calls_reserve_held") && !control.supabase.rpcs.includes("ai_ledger_reserve"), "control used the held RPC only");

  const legacy = compose({ ledgerMode: "legacy_busy_check_unsafe" });
  let sent: number | undefined;
  let refused: string | undefined;
  try {
    const out = await run(createAiGateway(legacy.options));
    sent = legacy.provider.calls.length;
    refused = out.ok ? "OK" : out.code;
  } catch (e) {
    assert.ok(e instanceof AiGatewayConfigError, String(e));
    refused = e.message;
    sent = legacy.provider.calls.length;
  }
  assert.deepEqual([refused, sent, legacy.supabase.rpcs], ["AI_GATEWAY_CONFIG_INVALID:ledger_mode_nonloopback", 0, []], "legacy on a non-loopback URL: send 0");
});

Deno.test("the legacy fence follows the existing loopback rule exactly: only http://127.0.0.1 / http://localhost (any port) may select it; every other allowed URL refuses it; owner_held is accepted everywhere", () => {
  for (const url of ["http://127.0.0.1:54321", "http://localhost:54321", "http://127.0.0.1"]) {
    const { options } = compose({ supabaseUrl: url, serviceKey: new SecretValue("k", LOCAL_KEY), ledgerMode: "legacy_busy_check_unsafe" });
    assert.doesNotThrow(() => createAiGateway(options), url);
  }
  for (const url of [PROD_URL, "https://127.0.0.1:54321", "https://localhost", "https://localhost.example.com", "https://kong:8000", "https://example.supabase.co"]) {
    const legacy = compose({ supabaseUrl: url, ledgerMode: "legacy_busy_check_unsafe" });
    assert.throws(() => createAiGateway(legacy.options), (e: unknown) => e instanceof AiGatewayConfigError && e.message === "AI_GATEWAY_CONFIG_INVALID:ledger_mode_nonloopback", url);
    assert.doesNotThrow(() => createAiGateway(compose({ supabaseUrl: url }).options), `${url}: owner_held`);
    assert.doesNotThrow(() => createAiGateway(compose({ supabaseUrl: url, ledgerMode: "owner_held" }).options), `${url}: explicit owner_held`);
  }
  // A plain-http URL that only looks local never reaches the fence: the existing URL rule refuses it first.
  for (const url of ["http://localhost.example.com", "http://127.0.0.1.example.com", "http://[::1]:54321"]) {
    const { options } = compose({ supabaseUrl: url, serviceKey: new SecretValue("k", LOCAL_KEY), ledgerMode: "legacy_busy_check_unsafe" });
    assert.throws(() => createAiGateway(options), (e: unknown) => e instanceof AiGatewayConfigError && e.message === "AI_GATEWAY_CONFIG_INVALID:supabase_url", url);
  }
  // Unknown modes stay a configuration error on every URL (unchanged).
  for (const url of [PROD_URL, "http://127.0.0.1:54321"]) {
    const { options } = compose({ supabaseUrl: url, serviceKey: new SecretValue("k", url === PROD_URL ? PROD_KEY : LOCAL_KEY), ledgerMode: "busy" as never });
    assert.throws(() => createAiGateway(options), (e: unknown) => e instanceof AiGatewayConfigError && e.message === "AI_GATEWAY_CONFIG_INVALID:ledger_mode", url);
  }
});

Deno.test("reachability: in supabase/functions/_shared/ai_gateway only runtime.ts composes gatewayExecute and only runtime.ts / gateway.ts name the legacy check, so no other product entry can build the legacy path", async () => {
  const dir = new URL("../functions/_shared/ai_gateway/", import.meta.url);
  for await (const e of Deno.readDir(dir)) {
    const text = await Deno.readTextFile(new URL(e.name, dir));
    const composes = /\bgatewayExecute\s*\(|legacyBusyHeldCheck\s*:\s*true|legacy_busy_check_unsafe/u.test(text);
    assert.equal(composes, e.name === "runtime.ts" || e.name === "gateway.ts", e.name);
  }
});
