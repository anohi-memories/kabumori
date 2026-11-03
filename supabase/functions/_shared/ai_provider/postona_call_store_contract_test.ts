// F6 POSTONA AI ledger / quota / idempotency design (2026-10-17). OFFLINE CONTRACT CHECKS ONLY: fake fetch, fake
// key, no network, nothing written. Nothing deployable imports this file and it wires nothing.
//
// The durable call store POSTONA needs (docs/ai-provider/F6_POSTONA_AI_LEDGER_QUOTA_IDEMPOTENCY_DESIGN.md, section 4)
// is a database table plus SECURITY DEFINER functions that do not exist yet. Its proposed semantics are modelled here
// by `ReferenceCallStore` and run against the REAL H5 bridge, so the SQL design is pinned to what the bridge accepts:
//   - one claim per (tenant, feature, operationId); a parallel claim is busy, a different input is a conflict;
//   - a claim whose completion was lost stays "acquired" (busy), and the operator / recovery step closes it with a
//     content-free UNKNOWN tombstone that keeps the original audit: a replay then answers UNKNOWN and never resends;
//   - after the content retention window the stored model output is replaced by the same kind of tombstone;
//   - another user with the same operationId is another call (tenant isolation).
// ReferenceCallStore is a test model of the proposal, not an implementation to ship.
import assert from "node:assert/strict";
import test from "node:test";
import { createConsumerBridge } from "../ai_consumer_bridge/bridge.ts";
import type { Audit, BridgeResult, CallClaim, CallIdentity, ConsumerCallStore, ConsumerFeature } from "../ai_consumer_bridge/types.ts";
import { type BudgetCallContext, type BudgetReservation, type BudgetSettlement, InMemoryBudgetGuard } from "./budget.ts";
import { anthropicBody, jsonResponse, recordingFetch, type Responder } from "./test_support.ts";
import type { AiSubject } from "./types.ts";

const USER_A = "00000000-0000-4000-8000-0000000000a1";
const USER_B = "00000000-0000-4000-8000-0000000000b2";

type Row = {
  readonly identity: CallIdentity;
  readonly owner: string;
  state: "acquired" | "complete" | "abandoned";
  result: BridgeResult | null;
  /** Content-free audit kept for tombstones (the bridge checks it on replay). */
  audit: Audit | null;
};

/**
 * Reference model of the proposed `ai_ledger.consumer_calls` semantics (section 4 of the design doc):
 * claim = insert or read under the key lock; complete = compare owner + identity, acquired -> complete, atomically;
 * abandon = operator / recovery closes a stuck acquired claim with an UNKNOWN tombstone (never reopens it);
 * purgeContent = after the retention window, replace a stored result by a content-free tombstone.
 */
class ReferenceCallStore implements ConsumerCallStore {
  readonly rows = new Map<string, Row>();
  private next = 0;
  /** Simulates a lost response from the complete RPC (the row may or may not be written). */
  loseNextComplete: "before_write" | "after_write" | null = null;

  claim(identity: CallIdentity): Promise<CallClaim> {
    const row = this.rows.get(identity.key);
    if (!row) {
      this.next += 1;
      const owner = `claim_${this.next}`;
      this.rows.set(identity.key, { identity, owner, state: "acquired", result: null, audit: null });
      return Promise.resolve({ kind: "acquired", owner });
    }
    if (row.identity.tenantTag !== identity.tenantTag || row.identity.fingerprint !== identity.fingerprint) {
      return Promise.resolve({ kind: "conflict" });
    }
    if (row.state === "acquired") return Promise.resolve({ kind: "busy" });
    return Promise.resolve({ kind: "complete", fingerprint: row.identity.fingerprint, result: structuredClone(row.result!) });
  }

  complete(identity: CallIdentity, owner: string, result: BridgeResult): Promise<void> {
    const row = this.rows.get(identity.key);
    if (this.loseNextComplete === "before_write") {
      this.loseNextComplete = null;
      return Promise.reject(new Error("response_lost"));
    }
    if (
      !row || row.state !== "acquired" || row.owner !== owner || row.identity.tenantTag !== identity.tenantTag ||
      row.identity.fingerprint !== identity.fingerprint
    ) return Promise.reject(new Error("complete_refused"));
    row.state = "complete";
    row.result = structuredClone(result);
    row.audit = result.audit ? structuredClone(result.audit) : null;
    if (this.loseNextComplete === "after_write") {
      this.loseNextComplete = null;
      return Promise.reject(new Error("response_lost"));
    }
    return Promise.resolve();
  }

  /** Recovery / operator: close a stuck claim. `audit` comes from the ledger rows of its callId (content-free). */
  abandon(key: string, audit: Audit): void {
    const row = this.rows.get(key);
    if (!row || row.state !== "acquired") throw new Error("not_acquired");
    row.state = "abandoned";
    row.audit = structuredClone(audit);
    row.result = { ok: false, code: "UNKNOWN", audit: structuredClone(audit) };
  }

  /** Retention: drop the model output, keep a content-free UNKNOWN tombstone with the original audit. */
  purgeContent(key: string): void {
    const row = this.rows.get(key);
    if (!row || row.state !== "complete" || !row.audit) throw new Error("not_complete");
    row.result = { ok: false, code: "UNKNOWN", audit: structuredClone(row.audit) };
  }
}

class Ledger {
  private readonly inner = new InMemoryBudgetGuard([
    { id: "postona-offline", scope: { provider: "anthropic", application: "postona" }, maxEstimatedUsd: 1, maxUsdPerCall: 0.2 },
  ]);
  readonly settlements: BudgetSettlement[] = [];
  private readonly sent = new Set<string>();
  reserve(context: BudgetCallContext, upperBoundUsd: number) {
    return this.inner.reserve(context, upperBoundUsd);
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
    return this.sent.has(reservation.id) ? Promise.reject(new Error("marked_sent")) : Promise.resolve();
  }
}

const FEATURE: ConsumerFeature = {
  id: "postona.consult",
  revision: "design-1",
  policy: {
    role: "postona.consult.reply",
    application: "postona",
    feature: "consult",
    allowedModels: ["anthropic.haiku@2026-10"],
    defaultModel: "anthropic.haiku@2026-10",
    allowedEfforts: ["low"],
    defaultEffort: "low",
    maxOutputTokens: 300,
    timeoutMs: 25_000,
    maxTransportAttempts: 1,
  },
  systemInstructions: "Reply with JSON { \"reply\": string }.",
  schema: {
    name: "consult_reply",
    schema: { type: "object", additionalProperties: false, required: ["reply"], properties: { reply: { type: "string", minLength: 1 } } },
  },
  maxInputBytes: 4096,
  maxResultBytes: 4096,
  maxTotalCostUsd: 0.05,
  deadlineMs: 30_000,
  validateFacts: () => true,
};

function world(store: ReferenceCallStore, respond: Responder = () => jsonResponse(200, anthropicBody({ reply: "どうぞ" }))) {
  const ledger = new Ledger();
  const net = recordingFetch(respond);
  const subjects: Record<string, AiSubject> = {
    user_a: { kind: "user", userId: USER_A, brandId: null },
    user_b: { kind: "user", userId: USER_B, brandId: null },
  };
  const bridge = createConsumerBridge("postona-design-1", [FEATURE], {
    store,
    authorize: (credential) => {
      const subject = subjects[String(credential)];
      return Promise.resolve(subject ? { subject, expiresAtMs: Date.now() + 60_000 } : null);
    },
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

const request = (operationId: string, input = "テーマを決めたい") => ({ feature: "postona.consult", operationId, input });

test("one claim per operation: a replay returns the stored result without a second request", async () => {
  const store = new ReferenceCallStore();
  const { bridge, net } = world(store);
  const first = await bridge.execute("user_a", request("op-1"));
  assert.equal(first.ok, true);
  const replay = await bridge.execute("user_a", request("op-1"));
  assert.deepEqual(replay, first);
  assert.equal(net.calls.length, 1);
});

test("parallel claims of one operation: exactly one request, the other is IN_PROGRESS", async () => {
  const store = new ReferenceCallStore();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => release = resolve);
  const { bridge, net } = world(store, async () => {
    await gate;
    return jsonResponse(200, anthropicBody({ reply: "どうぞ" }));
  });
  const first = bridge.execute("user_a", request("op-2"));
  await new Promise((resolve) => setTimeout(resolve, 10));
  const second = await bridge.execute("user_a", request("op-2"));
  release();
  assert.deepEqual([second.ok, !second.ok && second.code], [false, "IN_PROGRESS"]);
  assert.equal((await first).ok, true);
  assert.equal(net.calls.length, 1);
});

test("the same operationId with a different input is CONTENT_DRIFT, and another user's operationId is another call", async () => {
  const store = new ReferenceCallStore();
  const { bridge, net } = world(store);
  await bridge.execute("user_a", request("op-3"));
  const drift = await bridge.execute("user_a", request("op-3", "別の内容"));
  assert.deepEqual([drift.ok, !drift.ok && drift.code, net.calls.length], [false, "CONTENT_DRIFT", 1]);
  const other = await bridge.execute("user_b", request("op-3"));
  assert.equal(other.ok, true);
  assert.equal(net.calls.length, 2, "tenant isolation: user B's op-3 is its own call");
  assert.equal(store.rows.size, 2);
});

test("a lost completion leaves the claim busy; recovery closes it with an UNKNOWN tombstone that is never resent", async () => {
  for (const when of ["before_write", "after_write"] as const) {
    const store = new ReferenceCallStore();
    const { bridge, net, ledger } = world(store);
    store.loseNextComplete = when;
    const lost = await bridge.execute("user_a", request("op-4"));
    assert.deepEqual([lost.ok, !lost.ok && lost.code], [false, "UNKNOWN"], when);
    assert.equal(net.calls.length, 1);
    assert.deepEqual(ledger.settlements.map((s) => s.outcome), ["succeeded"], `${when}: the ledger already holds the cost`);
    const key = [...store.rows.keys()][0];
    if (when === "before_write") {
      const busy = await bridge.execute("user_a", request("op-4"));
      assert.deepEqual([busy.ok, !busy.ok && busy.code, net.calls.length], [false, "IN_PROGRESS", 1], when);
      // Recovery rebuilds the audit from the ledger rows of this callId (content-free) and closes the claim.
      store.abandon(key, {
        callId: key,
        tenantTag: store.rows.get(key)!.identity.tenantTag,
        feature: "postona.consult",
        role: "postona.consult.reply",
        model: lost.audit!.model,
        policyVersion: "postona-design-1",
        attempts: 1,
        estimatedCostUsd: lost.audit!.estimatedCostUsd,
        costBasis: "includes_upper_bound",
      });
    }
    const replay = await bridge.execute("user_a", request("op-4"));
    assert.equal(net.calls.length, 1, `${when}: never resent`);
    if (when === "before_write") {
      assert.deepEqual([replay.ok, !replay.ok && replay.code, replay.audit?.attempts], [false, "UNKNOWN", 1], "the tombstone is accepted");
    } else {
      assert.equal(replay.ok, true, "the row was written before the response was lost: the stored result is served");
    }
  }
});

test("content retention: the stored output becomes a content-free UNKNOWN tombstone the bridge accepts; no resend", async () => {
  const store = new ReferenceCallStore();
  const { bridge, net } = world(store);
  const first = await bridge.execute("user_a", request("op-5"));
  assert.equal(first.ok, true);
  store.purgeContent([...store.rows.keys()][0]);
  const replay = await bridge.execute("user_a", request("op-5"));
  assert.equal(net.calls.length, 1);
  assert.deepEqual([replay.ok, !replay.ok && replay.code], [false, "UNKNOWN"]);
  // Accepted as the stored tombstone (original audit), not rejected as malformed (which would carry a fresh audit).
  assert.deepEqual([replay.audit?.attempts, replay.audit?.costBasis], [first.audit.attempts, first.audit.costBasis]);
  assert.ok(!JSON.stringify(store.rows.get([...store.rows.keys()][0])).includes("どうぞ"), "no model output is kept");
});
