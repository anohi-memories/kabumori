// OFFLINE tests of the POSTONA consult seam (no network, fake key): fake Supabase Auth / REST, fake OpenAI, the
// real shared provider (executeAiRequest), an in-memory budget guard and an in-memory call store with the durable
// store's semantics. Run:
//   deno test --cached-only --frozen --config supabase/functions/_shared/ai_consumer_bridge/deno.json --deny-net \
//     --deny-write --allow-env=ANTHROPIC_CUSTOM_HEADERS supabase/tests/postona_consult_shared_provider_seam_test.ts
import assert from "node:assert/strict";
import { CONSULT_SYSTEM_PROMPT, handleSocialMobileConsult } from "../functions/social-mobile-consult/logic.ts";
import {
  type BudgetCallContext,
  type BudgetGuard,
  type BudgetReservation,
  type BudgetSettlement,
  InMemoryBudgetGuard,
} from "../functions/_shared/ai_provider/budget.ts";
import { jsonResponse, openAiBody, recordingFetch, type Responder } from "../functions/_shared/ai_provider/test_support.ts";
import type { BridgeResult, CallClaim, CallIdentity, ConsumerCallStore } from "../functions/_shared/ai_consumer_bridge/types.ts";
import { createConsultSeam, SEAM_VERSION } from "./postona_consult_shared_provider_seam.ts";

const SUPABASE = "https://example.supabase.co";
const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const BRAND_A = "u_ae343f5caedb67d4af33fc7a";
const BRAND_B = "u_0b1c2d3e4f5061728394a5b6";
const TOKENS: Record<string, string> = { "jwt-user-a": USER_A, "jwt-user-b": USER_B };
const OWNED: Record<string, string> = { [USER_A]: BRAND_A, [USER_B]: BRAND_B };
const FAKE_OPENAI_KEY = "test-openai-key-NOT-REAL-0000000000";

const empty = { preferredTone: null, themes: null, objective: null, frequencyTargetPerWeek: null, optionalNgWords: null, notes: null };
const emptyPersona = { toneSignals: null, sentenceLength: null, punctuationEmoji: null, recurringVocabulary: null, topicSignals: null, hashtagHabits: null, ctaStyle: null, openingClosingPatterns: null };
const modelOutput = (over: Record<string, unknown> = {}) => ({
  kind: "chat",
  reply: "今日は『個人開発の小さな失敗談』はどうでしょう。",
  follow_up_questions: [],
  settings_delta: { ...empty },
  persona_delta: { ...emptyPersona },
  confidence: "medium",
  uncertainty: [],
  history_learning_requested: false,
  ...over,
});

type World = {
  account: string | null;
  service: string | null;
  entitlementReadFails: boolean;
  supabaseCalls: string[];
};
function supabaseFetch(world: World): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const token = (new Headers(init?.headers).get("Authorization") ?? "").replace(/^Bearer /u, "");
    world.supabaseCalls.push(url.pathname);
    const user = TOKENS[token];
    if (url.pathname === "/auth/v1/user") return Promise.resolve(user ? jsonResponse(200, { id: user, email: "jane@example.com" }) : jsonResponse(401, { msg: "invalid" }));
    if (!user) return Promise.resolve(jsonResponse(401, {}));
    const q = url.searchParams;
    switch (url.pathname) {
      case "/rest/v1/common_accounts":
        if (world.entitlementReadFails) return Promise.resolve(jsonResponse(500, {}));
        return Promise.resolve(jsonResponse(200, world.account === null ? [] : [{ status: world.account }]));
      case "/rest/v1/service_entitlements":
        if (q.get("service_key") !== "eq.x_autopost") return Promise.resolve(jsonResponse(200, []));
        return Promise.resolve(jsonResponse(200, world.service === null ? [] : [{ status: world.service }]));
      case "/rest/v1/brand_memberships": {
        const brand = q.get("brand_id")?.replace(/^eq\./u, "");
        return Promise.resolve(jsonResponse(200, OWNED[user] === brand ? [{ brand_id: brand, role: "owner", user_id: user }] : []));
      }
      case "/rest/v1/brands": {
        const brand = q.get("id")?.replace(/^eq\./u, "");
        return Promise.resolve(jsonResponse(200, [{ id: brand, code_profile_key: "social_mobile_user_v1" }]));
      }
      case "/rest/v1/social_mobile_content_settings":
        return Promise.resolve(jsonResponse(200, []));
      default:
        return Promise.resolve(jsonResponse(404, {}));
    }
  }) as typeof fetch;
}

/** The durable call store's semantics (ai_calls): claim once, busy while acquired, conflict on drift, replay. */
class ReferenceStore implements ConsumerCallStore {
  readonly rows = new Map<string, { identity: CallIdentity; owner: string; state: "acquired" | "complete"; result: BridgeResult | null }>();
  failNextComplete = false;
  private n = 0;
  claim(identity: CallIdentity): Promise<CallClaim> {
    const row = this.rows.get(identity.key);
    if (!row) {
      const owner = `00000000-0000-4000-8000-${String(++this.n).padStart(12, "0")}`;
      this.rows.set(identity.key, { identity, owner, state: "acquired", result: null });
      return Promise.resolve({ kind: "acquired", owner });
    }
    if (row.identity.tenantTag !== identity.tenantTag || row.identity.fingerprint !== identity.fingerprint) return Promise.resolve({ kind: "conflict" });
    if (row.state === "acquired") return Promise.resolve({ kind: "busy" });
    return Promise.resolve({ kind: "complete", fingerprint: row.identity.fingerprint, result: structuredClone(row.result!) });
  }
  complete(identity: CallIdentity, owner: string, result: BridgeResult): Promise<void> {
    if (this.failNextComplete) {
      this.failNextComplete = false;
      return Promise.reject(new Error("response_lost"));
    }
    const row = this.rows.get(identity.key);
    if (!row || row.owner !== owner || row.state !== "acquired") return Promise.reject(new Error("fenced"));
    row.state = "complete";
    row.result = structuredClone(result);
    return Promise.resolve();
  }
}

/** The in-memory guard, recording what the ledger would see. */
class RecordingBudget implements BudgetGuard {
  readonly inner: InMemoryBudgetGuard;
  readonly reserved: BudgetCallContext[] = [];
  readonly settled: Array<{ cost: number; settlement?: BudgetSettlement }> = [];
  constructor(maxCalls = 100) {
    this.inner = new InMemoryBudgetGuard([{ id: "postona-consult", scope: { provider: "openai", application: "postona", feature: "consult" }, maxCalls, maxUsdPerCall: 0.05 }]);
  }
  async reserve(context: BudgetCallContext, upper: number) {
    const decision = await this.inner.reserve(context, upper);
    if (decision.allowed) this.reserved.push(context);
    return decision;
  }
  markSent(_r: BudgetReservation): Promise<void> {
    return Promise.resolve();
  }
  async settle(r: BudgetReservation, cost: number, settlement?: BudgetSettlement) {
    this.settled.push({ cost, settlement });
    await this.inner.settle(r, cost);
  }
  release(_r: BudgetReservation): Promise<void> {
    return Promise.resolve();
  }
}

function setup(options: { respond?: Responder; maxCalls?: number; world?: Partial<World> } = {}) {
  const world: World = { account: "active", service: "active", entitlementReadFails: false, supabaseCalls: [], ...options.world };
  const openai = recordingFetch(options.respond ?? (() => jsonResponse(200, openAiBody(modelOutput(), { model: "gpt-6-luna-2026-09-01" }))));
  const budget = new RecordingBudget(options.maxCalls);
  const store = new ReferenceStore();
  const logs: Array<Record<string, unknown>> = [];
  const contexts: Array<Record<string, unknown>> = [];
  const seam = createConsultSeam({
    supabaseUrl: SUPABASE,
    publishableKey: "publishable-fixture",
    fetchImpl: supabaseFetch(world),
    provider: {
      readEnv: (name: string) => (name === "OPENAI_API_KEY" ? FAKE_OPENAI_KEY : undefined),
      fetch: openai.fetch,
      retryTiming: { baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 10, minAttemptMs: 1 },
      sleep: () => Promise.resolve(),
      random: () => 0,
    },
    budget,
    storeFor: (context) => {
      contexts.push(context);
      return store;
    },
    log: (entry) => logs.push(entry),
  });
  return { seam, world, openai, budget, store, logs, contexts };
}

const consult = (
  body: Record<string, unknown> = { brand_id: BRAND_A, message: "今日何投稿しようかな" },
  headers: Record<string, string> = { Authorization: "Bearer jwt-user-a", "Idempotency-Key": "op-0000000001" },
) => new Request(`${SUPABASE}/functions/v1/social-mobile-consult`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });

Deno.test("one consultation: identity -> active service -> owned workspace -> shared provider (OpenAI) -> the existing result shape", async () => {
  const w = setup();
  const answer = await json(await w.seam(consult()));
  assert.equal(answer.status, 200);
  assert.deepEqual(Object.keys(answer.body).sort(), ["persona_saved", "publish_attempted", "result", "scheduled_post_created", "settings_saved", "success", "x_api_called"]);
  assert.equal(answer.body.success, true);
  assert.equal(answer.body.result.kind, "chat");
  // The same model output through the live handler (its own OpenAI call) gives the same result object.
  const live = await handleSocialMobileConsult(consult(), {
    supabaseUrl: SUPABASE,
    publishableKey: "publishable-fixture",
    openAiApiKey: FAKE_OPENAI_KEY,
    fetchImpl: supabaseFetch({ account: "active", service: "active", entitlementReadFails: false, supabaseCalls: [] }),
    callModel: () => Promise.resolve({ outputText: JSON.stringify(modelOutput()), usage: { model: "gpt-6-luna", inputTokens: 1, outputTokens: 1 } }),
    log: () => {},
  });
  assert.deepEqual(answer.body, await live.json());

  // Exactly one provider request: the existing model / store:false / strict schema / output cap; no identity sent.
  assert.equal(w.openai.calls.length, 1);
  const call = w.openai.calls[0];
  assert.equal(call.url, "https://api.openai.com/v1/responses");
  const sent = call.body as Record<string, unknown>;
  assert.equal(sent.model, "gpt-6-luna");
  assert.equal(sent.store, false);
  assert.equal(sent.max_output_tokens, 900);
  assert.equal((sent.reasoning as Record<string, unknown>).effort, "low");
  assert.equal(((sent.text as Record<string, unknown>).format as Record<string, unknown>).strict, true);
  assert.equal(sent.instructions, CONSULT_SYSTEM_PROMPT);
  const text = JSON.stringify(sent);
  for (const secret of [USER_A, BRAND_A, "jwt-user-a", "jane@example.com", FAKE_OPENAI_KEY]) assert.ok(!text.includes(secret), `not sent: ${secret}`);
  assert.equal(call.headers.get("authorization"), `Bearer ${FAKE_OPENAI_KEY}`);

  // The ledger saw one user-subject attempt of postona / consult, settled from measured usage.
  assert.equal(w.budget.reserved.length, 1);
  const ctx = w.budget.reserved[0];
  assert.deepEqual([ctx.provider, ctx.model, ctx.application, ctx.feature, ctx.logicalRole], ["openai", "gpt-6-luna", "postona", "consult", "postona.consult.reply"]);
  assert.deepEqual(ctx.subject, { kind: "user", userId: USER_A, brandId: null });
  assert.match(ctx.callId ?? "", /^h5m2_[0-9a-f]{64}$/);
  assert.equal(w.budget.settled.length, 1);
  assert.equal(w.budget.settled[0].settlement?.costBasis ?? "measured", "measured");
  // The call store holds one complete row for this operation, with the seam's audit.
  assert.equal(w.store.rows.size, 1);
  const row = [...w.store.rows.values()][0];
  assert.equal(row.state, "complete");
  assert.equal(row.result?.ok, true);
  assert.deepEqual([row.result?.audit?.policyVersion, row.result?.audit?.callId], [SEAM_VERSION, ctx.callId]);
  // The store was bound to the verified subject and the bridge-style feature id.
  assert.deepEqual(w.contexts, [{ application: "postona", feature: "postona.consult", subject: { kind: "user", userId: USER_A, brandId: null } }]);
  // Logs are metadata only.
  assert.ok(!JSON.stringify(w.logs).includes("今日何投稿") && !JSON.stringify(w.logs).includes(USER_A));
});

Deno.test("P0: nothing reaches the provider, the ledger or the store unless identity, operation id, account and POSTONA service all pass", async () => {
  const cases: Array<[string, Partial<World>, Record<string, string>, Record<string, unknown> | undefined, number, string]> = [
    ["no bearer", {}, { "Idempotency-Key": "op-0000000001" }, undefined, 401, "AUTH_REQUIRED"],
    ["unknown token", {}, { Authorization: "Bearer forged", "Idempotency-Key": "op-0000000001" }, undefined, 401, "AUTH_REQUIRED"],
    ["no operation id", {}, { Authorization: "Bearer jwt-user-a" }, undefined, 400, "CONSULT_OPERATION_ID_REQUIRED"],
    ["short operation id", {}, { Authorization: "Bearer jwt-user-a", "Idempotency-Key": "op1" }, undefined, 400, "CONSULT_OPERATION_ID_REQUIRED"],
    ["account deleting", { account: "deleting" }, {}, undefined, 403, "CONSULT_NOT_ENTITLED"],
    ["account locked", { account: "locked" }, {}, undefined, 403, "CONSULT_NOT_ENTITLED"],
    ["no common account", { account: null }, {}, undefined, 403, "CONSULT_NOT_ENTITLED"],
    ["POSTONA ended", { service: "ended" }, {}, undefined, 403, "CONSULT_NOT_ENTITLED"],
    ["POSTONA deleting", { service: "deleting" }, {}, undefined, 403, "CONSULT_NOT_ENTITLED"],
    ["POSTONA suspended", { service: "suspended" }, {}, undefined, 403, "CONSULT_NOT_ENTITLED"],
    ["POSTONA provisioning", { service: "provisioning" }, {}, undefined, 403, "CONSULT_NOT_ENTITLED"],
    ["POSTONA never started", { service: null }, {}, undefined, 403, "CONSULT_NOT_ENTITLED"],
    ["entitlement unreadable", { entitlementReadFails: true }, {}, undefined, 503, "ENTITLEMENT_READ_UNAVAILABLE"],
    ["another user's workspace", {}, {}, { brand_id: BRAND_B, message: "見せて" }, 404, "OWNED_WORKSPACE_NOT_FOUND"],
    ["unknown body key", {}, {}, { brand_id: BRAND_A, message: "x", user_id: USER_B }, 400, "REQUEST_BODY_INVALID"],
  ];
  for (const [label, world, headers, body, status, error] of cases) {
    const w = setup({ world });
    const h = Object.keys(headers).length ? headers : { Authorization: "Bearer jwt-user-a", "Idempotency-Key": "op-0000000001" };
    const answer = await json(await w.seam(consult(body, h)));
    assert.deepEqual([answer.status, answer.body.success, answer.body.error], [status, false, error], label);
    assert.equal(w.openai.calls.length, 0, `${label}: no provider request`);
    assert.equal(w.budget.reserved.length, 0, `${label}: no ledger reservation`);
    assert.equal(w.store.rows.size, 0, `${label}: no claim`);
  }
});

Deno.test("quota: a denied reservation sends nothing and answers CONSULT_QUOTA_EXCEEDED; the same operation replays it without asking again", async () => {
  const w = setup({ maxCalls: 0 });
  const first = await json(await w.seam(consult()));
  assert.deepEqual([first.status, first.body.error, first.body.retryable], [429, "CONSULT_QUOTA_EXCEEDED", false]);
  assert.equal(w.openai.calls.length, 0);
  const again = await json(await w.seam(consult()));
  assert.deepEqual(again, first);
  assert.equal(w.openai.calls.length, 0);
});

Deno.test("duplicates: the same operation replays the stored answer (one request, one reservation); another user's same operation id is its own call", async () => {
  const w = setup();
  const first = await json(await w.seam(consult()));
  const second = await json(await w.seam(consult()));
  assert.deepEqual(second, first);
  assert.equal(w.openai.calls.length, 1);
  assert.equal(w.budget.reserved.length, 1);
  const other = await json(await w.seam(consult({ brand_id: BRAND_B, message: "今日何投稿しようかな" }, { Authorization: "Bearer jwt-user-b", "Idempotency-Key": "op-0000000001" })));
  assert.equal(other.status, 200);
  assert.equal(w.openai.calls.length, 2);
  assert.equal(w.store.rows.size, 2);
});

Deno.test("the same operation id with another message is refused (CONSULT_OPERATION_REUSED), nothing sent", async () => {
  const w = setup();
  await w.seam(consult());
  const drift = await json(await w.seam(consult({ brand_id: BRAND_A, message: "やっぱり別の相談" })));
  assert.deepEqual([drift.status, drift.body.error, drift.body.retryable], [409, "CONSULT_OPERATION_REUSED", false]);
  assert.equal(w.openai.calls.length, 1);
});

Deno.test("concurrent duplicates: exactly one provider request; the other answers CONSULT_IN_PROGRESS", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => release = resolve);
  const w = setup({
    respond: async () => {
      await gate;
      return jsonResponse(200, openAiBody(modelOutput(), { model: "gpt-6-luna" }));
    },
  });
  const first = w.seam(consult());
  await new Promise((resolve) => setTimeout(resolve, 20));
  const second = await json(await w.seam(consult()));
  release();
  assert.deepEqual([second.status, second.body.error, second.body.retryable], [409, "CONSULT_IN_PROGRESS", true]);
  assert.equal((await first).status, 200);
  assert.equal(w.openai.calls.length, 1);
});

Deno.test("outcome unknown (connection lost after sending): charged at the upper bound, stored UNKNOWN, never resent", async () => {
  const w = setup({ respond: () => Promise.reject(new TypeError("connection reset")) });
  const first = await json(await w.seam(consult()));
  assert.equal(w.openai.calls.length, 1);
  assert.deepEqual([first.status, first.body.error, first.body.retryable], [502, "CONSULT_AI_UNKNOWN", false]);
  assert.equal(w.budget.settled.length, 1);
  assert.equal(w.budget.settled[0].settlement?.costBasis, "upper_bound");
  const again = await json(await w.seam(consult()));
  assert.deepEqual(again, first);
  assert.equal(w.openai.calls.length, 1, "never resent");
});

Deno.test("provider failure and malformed output are final for that operation (no resend); a schema-valid but disallowed answer is refused by the existing allowlist", async () => {
  let w = setup({ respond: () => jsonResponse(400, { error: { type: "invalid_request_error", message: "bad" } }) });
  let first = await json(await w.seam(consult()));
  assert.deepEqual([first.status, first.body.error], [502, "CONSULT_AI_FAILED"]);
  assert.deepEqual(await json(await w.seam(consult())), first);
  assert.equal(w.openai.calls.length, 1);

  w = setup({ respond: () => jsonResponse(200, openAiBody({ kind: "chat" }, { model: "gpt-6-luna" })) });
  first = await json(await w.seam(consult()));
  assert.deepEqual([first.status, first.body.error], [502, "CONSULT_AI_MALFORMED"]);
  assert.deepEqual(await json(await w.seam(consult())), first);
  assert.equal(w.openai.calls.length, 1);

  w = setup({ respond: () => jsonResponse(200, openAiBody(modelOutput({ kind: "proposal", settings_delta: { ...empty, frequencyTargetPerWeek: 99 } }), { model: "gpt-6-luna" })) });
  first = await json(await w.seam(consult()));
  assert.deepEqual([first.status, first.body.error], [502, "CONSULT_AI_MALFORMED"]);
  assert.deepEqual(await json(await w.seam(consult())), first);
  assert.equal(w.openai.calls.length, 1);
});

Deno.test("a lost completion: CONSULT_AI_UNKNOWN now, CONSULT_IN_PROGRESS for the same operation until recovery; never resent", async () => {
  const w = setup();
  w.store.failNextComplete = true;
  const first = await json(await w.seam(consult()));
  assert.deepEqual([first.status, first.body.error], [502, "CONSULT_AI_UNKNOWN"]);
  const again = await json(await w.seam(consult()));
  assert.deepEqual([again.status, again.body.error], [409, "CONSULT_IN_PROGRESS"]);
  assert.equal(w.openai.calls.length, 1);
});
