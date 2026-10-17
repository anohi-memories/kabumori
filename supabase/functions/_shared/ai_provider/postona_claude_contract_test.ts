// F6 POSTONA -> Claude interface preflight (2026-10-17). OFFLINE CONTRACT CHECKS ONLY: fake fetch, fake key, no
// network, nothing written. Nothing deployable imports this file and it wires nothing. It pins, against the real code
// on both sides, the facts the migration plan relies on (docs/ai-provider/F6_POSTONA_CLAUDE_INTERFACE_PREFLIGHT.md),
// so a change on either side shows up here first:
//   - the consult output schema is accepted by the shared provider as it is;
//   - the consult can run through the H5 bridge with its input sent as ONE JSON string, POSTONA's own sanitizer as
//     the bridge's mandatory output check, a verified user subject, one request, and the ledger settling it;
//   - a POSTONA brand id (a `u_...` slug) is not a ledger brand id: the bridge refuses it as a subject brand;
//   - a possibly billed failure (504) is sent once and settles unknown at the upper bound;
//   - the post generator's free text needs a `{ text }` JSON wrapper, with POSTONA's length rule as the output check.
// The feature registrations below are EXAMPLES for the contract, not the production configuration (roles, models,
// caps and prompts are decided with the POSTONA owners; see the doc).
import assert from "node:assert/strict";
import test from "node:test";
import { createConsumerBridge } from "../ai_consumer_bridge/bridge.ts";
import type { BridgeResult, CallClaim, CallIdentity, ConsumerCallStore, ConsumerFeature } from "../ai_consumer_bridge/types.ts";
import {
  CONSULT_LIMITS,
  CONSULT_OUTPUT_SCHEMA,
  CONSULT_SYSTEM_PROMPT,
  consultContextFor,
  sanitizeConsultModelOutput,
  type SavedConsultState,
} from "../../social-mobile-consult/logic.ts";
import { assertPostWithinLengthPolicy, type PostLengthPolicy } from "../brand/post_length_policy.ts";
import { SOCIAL_MOBILE_USER_DEFAULTS } from "../brand/social_mobile_content_settings.ts";
import { type BudgetCallContext, type BudgetReservation, type BudgetSettlement, InMemoryBudgetGuard } from "./budget.ts";
import { resolveModelName } from "./model_catalog.ts";
import { assertSchemaSupported, toProviderSchema } from "./schema.ts";
import { anthropicBody, anthropicError, jsonResponse, recordingFetch, type Responder } from "./test_support.ts";
import type { AiSubject, JsonSchema } from "./types.ts";

const USER_ID = "00000000-0000-4000-8000-0000000000aa";
/** A POSTONA workspace brand id as the onboarding migration makes it: 'u_' || substr(md5(user_id), 1, 24). */
const POSTONA_BRAND_ID = "u_ae343f5caedb67d4af33fc7a";
const SAVED: SavedConsultState = { settings: SOCIAL_MOBILE_USER_DEFAULTS, persona: null };

/** Process-local stand-in for the durable, atomic call store POSTONA must provide (OFFLINE ONLY). */
class MemoryCallStore implements ConsumerCallStore {
  private readonly entries = new Map<string, { identity: CallIdentity; owner: string; result?: BridgeResult }>();
  private next = 0;
  claim(identity: CallIdentity): Promise<CallClaim> {
    const entry = this.entries.get(identity.key);
    if (!entry) {
      this.next += 1;
      const owner = `owner_${this.next}`;
      this.entries.set(identity.key, { identity, owner });
      return Promise.resolve({ kind: "acquired", owner });
    }
    if (entry.identity.tenantTag !== identity.tenantTag || entry.identity.fingerprint !== identity.fingerprint) {
      return Promise.resolve({ kind: "conflict" });
    }
    if (!entry.result) return Promise.resolve({ kind: "busy" });
    return Promise.resolve({ kind: "complete", fingerprint: entry.identity.fingerprint, result: structuredClone(entry.result) });
  }
  complete(identity: CallIdentity, owner: string, result: BridgeResult): Promise<void> {
    const entry = this.entries.get(identity.key);
    if (!entry || entry.owner !== owner || entry.result) return Promise.reject(new Error("offline_store_refused"));
    entry.result = structuredClone(result);
    return Promise.resolve();
  }
}

/** The ledger's port (reserve -> markSent -> settle | release) over an in-memory budget, recording what it saw. */
class RecordingLedger {
  private readonly inner = new InMemoryBudgetGuard([
    { id: "postona-offline", scope: { provider: "anthropic", application: "postona" }, maxEstimatedUsd: 1, maxUsdPerCall: 0.2 },
  ]);
  readonly contexts: BudgetCallContext[] = [];
  readonly settlements: BudgetSettlement[] = [];
  private readonly sent = new Set<string>();
  async reserve(context: BudgetCallContext, upperBoundUsd: number) {
    this.contexts.push(context);
    return await this.inner.reserve(context, upperBoundUsd);
  }
  markSent(reservation: BudgetReservation): Promise<void> {
    this.sent.add(reservation.id);
    return Promise.resolve();
  }
  async settle(reservation: BudgetReservation, costUsd: number, settlement?: BudgetSettlement) {
    if (settlement) this.settlements.push(settlement);
    await this.inner.settle(reservation, costUsd);
  }
  release(reservation: BudgetReservation): Promise<void> {
    return this.sent.has(reservation.id) ? Promise.reject(new Error("offline_marked_sent")) : Promise.resolve();
  }
}

/** EXAMPLE consult registration: today's limits, the cheapest Claude tier, one request (no automatic resend). */
const CONSULT_FEATURE: ConsumerFeature = {
  id: "postona.consult",
  revision: "preflight-1",
  policy: {
    role: "postona.consult.reply",
    application: "postona",
    feature: "consult",
    allowedModels: ["anthropic.haiku@2026-10"],
    defaultModel: "anthropic.haiku@2026-10",
    allowedEfforts: ["low"],
    defaultEffort: "low",
    maxOutputTokens: CONSULT_LIMITS.maxOutputTokens,
    timeoutMs: CONSULT_LIMITS.modelTimeoutMs,
    maxTransportAttempts: 1,
  },
  systemInstructions: CONSULT_SYSTEM_PROMPT,
  schema: { name: "social_mobile_consult", schema: CONSULT_OUTPUT_SCHEMA as JsonSchema },
  maxInputBytes: 65_536,
  maxResultBytes: 16_384,
  maxTotalCostUsd: 0.05,
  deadlineMs: 30_000,
  // The bridge's mandatory output check: POSTONA's own sanitizer must accept the model's JSON. It sees only the
  // payload and the input, so it checks the shape with the default saved state; the consult handler re-runs the
  // sanitizer with the user's real saved state after the bridge returns (that result is authoritative).
  validateFacts: (payload, input) => {
    const message = (JSON.parse(input) as { message?: unknown }).message;
    return typeof message === "string" && sanitizeConsultModelOutput(JSON.stringify(payload), SAVED, message) !== null;
  },
};

/** EXAMPLE post registration: the generator's free text wrapped as `{ text }`, the 140-char live rule as the check. */
const LIVE_POST_LENGTH: PostLengthPolicy = { mode: "limited", maxChars: 140 };
const POST_FEATURE: ConsumerFeature = {
  id: "postona.brand_post",
  revision: "preflight-1",
  policy: {
    role: "postona.brand_post.draft",
    application: "postona",
    feature: "brand_post",
    allowedModels: ["anthropic.haiku@2026-10"],
    defaultModel: "anthropic.haiku@2026-10",
    allowedEfforts: ["low"],
    defaultEffort: "low",
    maxOutputTokens: 600,
    timeoutMs: 45_000,
    maxTransportAttempts: 1,
  },
  systemInstructions: "（POSTONA の投稿文の指示。本物は brand_post_generator.ts が組み立てる）JSON の text に投稿本文だけを入れてください。",
  schema: {
    name: "brand_post_text",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["text"],
      properties: { text: { type: "string", minLength: 1, maxLength: 4000 } },
    },
  },
  maxInputBytes: 16_384,
  maxResultBytes: 16_384,
  maxTotalCostUsd: 0.02,
  deadlineMs: 50_000,
  validateFacts: (payload) => {
    try {
      assertPostWithinLengthPolicy(LIVE_POST_LENGTH, (payload as { text: string }).text.trim());
      return true;
    } catch {
      return false;
    }
  },
};

function world(options: { respond: Responder; subject?: AiSubject }) {
  const store = new MemoryCallStore();
  const ledger = new RecordingLedger();
  const net = recordingFetch(options.respond);
  const subject = options.subject ?? { kind: "user", userId: USER_ID, brandId: null };
  const bridge = createConsumerBridge("postona-preflight-1", [CONSULT_FEATURE, POST_FEATURE], {
    store,
    // Stands in for POSTONA's verifier (JWT -> verified user; ownership of the workspace checked beforehand).
    authorize: (credential) =>
      Promise.resolve(credential === "verified" ? { subject, expiresAtMs: Date.now() + 60_000 } : null),
    provider: {
      fetch: net.fetch,
      readEnv: (name: string) => (name === "ANTHROPIC_API_KEY" ? "test-anthropic-key-NOT-REAL-000000" : undefined),
      budget: ledger,
      retryTiming: { baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 10, minAttemptMs: 1 },
      sleep: () => Promise.resolve(),
      random: () => 0,
    },
  });
  return { bridge, ledger, net };
}

function consultOutput(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "chat",
    reply: "いいですね。まずは最近いちばん手を動かしたことから書いてみませんか？",
    follow_up_questions: [],
    settings_delta: { preferredTone: null, themes: null, objective: null, frequencyTargetPerWeek: null, optionalNgWords: null, notes: null },
    persona_delta: {
      toneSignals: null,
      sentenceLength: null,
      punctuationEmoji: null,
      recurringVocabulary: null,
      topicSignals: null,
      hashtagHabits: null,
      ctaStyle: null,
      openingClosingPatterns: null,
    },
    confidence: "medium",
    uncertainty: [],
    history_learning_requested: false,
    ...over,
  };
}

/** The consult request as ONE JSON string: what the model sees today (saved context, history, message). */
function consultInput(message: string, history: Array<{ role: "user" | "assistant"; text: string }>): string {
  return JSON.stringify({ context: consultContextFor(SAVED), history, message });
}

test("POSTONA consult: today's strict output schema is accepted by the shared provider as it is", () => {
  assertSchemaSupported(CONSULT_OUTPUT_SCHEMA as JsonSchema);
  assert.doesNotThrow(() => toProviderSchema("anthropic", CONSULT_OUTPUT_SCHEMA as JsonSchema));
});

test("POSTONA consult through the H5 bridge (offline): one JSON input, POSTONA's sanitizer as the check, one request, settled", async () => {
  const output = consultOutput();
  const { bridge, ledger, net } = world({ respond: () => jsonResponse(200, anthropicBody(output, { model: resolveModelName("anthropic.haiku@2026-10") })) });
  const message = "投稿のテーマを一緒に決めたいです";
  // History may start with the app's greeting (assistant): it is data inside the JSON, not a chat turn.
  const input = consultInput(message, [{ role: "assistant", text: "こんにちは。何から決めましょうか？" }, { role: "user", text: "仕事のことを書きたい" }]);
  assert.ok(new TextEncoder().encode(input).length <= CONSULT_FEATURE.maxInputBytes);
  const result = await bridge.execute("verified", { feature: "postona.consult", operationId: "consult_req_1", input });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(net.calls.length, 1);
  const sent = net.calls[0].body as { model: string; system: unknown; messages: Array<{ role: string; content: unknown }> };
  assert.equal(sent.model, resolveModelName("anthropic.haiku@2026-10"));
  assert.equal(sent.messages.length, 1, "one user message carrying the JSON");
  // The consult handler re-runs its sanitizer with the real saved state: the bridge result is usable as is.
  const canonical = sanitizeConsultModelOutput(JSON.stringify(result.ok ? result.data : null), SAVED, message);
  assert.equal(canonical?.kind, "chat");
  // Ledger attribution: the POSTONA application / feature / role and the verified user, with no brand.
  assert.deepEqual(
    ledger.contexts.map((c) => [c.application, c.feature, c.logicalRole, JSON.stringify(c.subject), c.attempt]),
    [["postona", "consult", "postona.consult.reply", JSON.stringify({ kind: "user", userId: USER_ID, brandId: null }), 1]],
  );
  assert.deepEqual(ledger.settlements.map((s) => [s.outcome, s.costBasis]), [["succeeded", "measured"]]);
  // A double submit of the same operation does not call the provider again.
  const again = await bridge.execute("verified", { feature: "postona.consult", operationId: "consult_req_1", input });
  assert.equal(again.ok, true);
  assert.equal(net.calls.length, 1);
});

test("POSTONA consult: output outside the schema is refused; an unverified caller sends nothing", async () => {
  // The shared provider checks the schema itself (SCHEMA_VIOLATION), so the bridge reports PROVIDER_FAILED; it is
  // never passed on. (OUTPUT_REJECTED is for schema-valid output the feature's own check refuses: see the post test.)
  const bad = world({ respond: () => jsonResponse(200, anthropicBody(consultOutput({ publish_now: true }))) });
  const rejected = await bad.bridge.execute("verified", { feature: "postona.consult", operationId: "consult_req_2", input: consultInput("こんにちは", []) });
  assert.deepEqual([rejected.ok, !rejected.ok && rejected.code, bad.net.calls.length], [false, "PROVIDER_FAILED", 1]);

  const anonymous = world({ respond: () => jsonResponse(200, anthropicBody(consultOutput())) });
  const denied = await anonymous.bridge.execute("forged", { feature: "postona.consult", operationId: "consult_req_3", input: consultInput("こんにちは", []) });
  assert.deepEqual([denied.ok, !denied.ok && denied.code, anonymous.net.calls.length, anonymous.ledger.contexts.length], [false, "AUTHORITY_DENIED", 0, 0]);
});

test("a POSTONA brand id is a slug, not a ledger brand: the bridge refuses it as a subject brand (nothing sent)", async () => {
  const { bridge, ledger, net } = world({
    respond: () => jsonResponse(200, anthropicBody(consultOutput())),
    subject: { kind: "user", userId: USER_ID, brandId: POSTONA_BRAND_ID },
  });
  const result = await bridge.execute("verified", { feature: "postona.consult", operationId: "consult_req_4", input: consultInput("こんにちは", []) });
  assert.deepEqual([result.ok, !result.ok && result.code, net.calls.length, ledger.contexts.length], [false, "AUTHORITY_DENIED", 0, 0]);
});

test("a possibly billed failure (504) is sent once and settles unknown at the upper bound", async () => {
  const { bridge, ledger, net } = world({ respond: () => jsonResponse(504, anthropicError(504, "timeout_error", "late")) });
  const result = await bridge.execute("verified", { feature: "postona.consult", operationId: "consult_req_5", input: consultInput("こんにちは", []) });
  assert.deepEqual([result.ok, !result.ok && result.code, net.calls.length], [false, "UNKNOWN", 1]);
  assert.deepEqual(ledger.settlements.map((s) => [s.outcome, s.costBasis]), [["unknown", "upper_bound"]]);
});

test("POSTONA post: the free-text post needs a { text } JSON wrapper; POSTONA's length rule is the output check", async () => {
  const draft = "朝のコーヒーを淹れる間に、今日やることを三つだけ書き出す。それだけで一日の迷いが減りました。";
  const system: AiSubject = { kind: "system" };
  const ok = world({ respond: () => jsonResponse(200, anthropicBody({ text: draft })), subject: system });
  const result = await ok.bridge.execute("verified", { feature: "postona.brand_post", operationId: "post_req_1", input: "今日のテーマ: 日々の生活や仕事に役立つ小さな工夫" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.ok && (result.data as { text: string }).text, draft);
  assert.deepEqual(ok.ledger.contexts.map((c) => [c.application, c.feature, JSON.stringify(c.subject)]), [["postona", "brand_post", JSON.stringify(system)]]);

  const tooLong = world({ respond: () => jsonResponse(200, anthropicBody({ text: "あ".repeat(141) })), subject: system });
  const rejected = await tooLong.bridge.execute("verified", { feature: "postona.brand_post", operationId: "post_req_2", input: "今日のテーマ: 小さな工夫" });
  assert.deepEqual([rejected.ok, !rejected.ok && rejected.code, tooLong.net.calls.length], [false, "OUTPUT_REJECTED", 1]);

  const notJson = world({ respond: () => jsonResponse(200, anthropicBody(null, { text: draft })), subject: system });
  const malformed = await notJson.bridge.execute("verified", { feature: "postona.brand_post", operationId: "post_req_3", input: "今日のテーマ: 小さな工夫" });
  assert.deepEqual([malformed.ok, !malformed.ok && malformed.code], [false, "PROVIDER_FAILED"]);
});
