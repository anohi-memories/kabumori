// Synthetic-only examples. No news source text, no native fetch/env/credentials.
import assert from "node:assert/strict";
import { createConsumerBridge } from "./bridge.ts";
import type {
  BridgeResult,
  CallClaim,
  CallIdentity,
  ConsumerCallStore,
  ConsumerDeps,
  ConsumerFeature,
} from "./types.ts";
import {
  type BudgetCallContext,
  type BudgetGuard,
  type BudgetReservation,
  type BudgetSettlement,
  InMemoryBudgetGuard,
} from "../ai_provider/mod.ts";
import {
  anthropicBody,
  jsonResponse,
  recordingFetch,
} from "../ai_provider/test_support.ts";
export const classifier: ConsumerFeature = {
  id: "offline.news.severity",
  revision: "v1",
  policy: {
    role: "offline.classifier.haiku",
    application: "offline_examples",
    feature: "news_severity",
    allowedModels: ["anthropic.haiku@2026-10"],
    defaultModel: "anthropic.haiku@2026-10",
    allowedEfforts: ["low"],
    defaultEffort: "low",
    maxOutputTokens: 192,
    timeoutMs: 1000,
    maxTransportAttempts: 2,
  },
  systemInstructions:
    "Classify this synthetic example only. Do not infer facts. Return the severity and evidence identifier.",
  schema: {
    name: "synthetic_severity",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["severity", "evidence"],
      properties: {
        severity: { type: "string", enum: ["low", "high"] },
        evidence: { type: "string", enum: ["synthetic-1"] },
      },
    },
  },
  maxInputBytes: 4096,
  maxResultBytes: 1024,
  maxTotalCostUsd: 0.02,
  deadlineMs: 5000,
  validateFacts: (p) =>
    typeof p === "object" && p !== null &&
    (p as { evidence: unknown }).evidence === "synthetic-1",
};
export const summarizer: ConsumerFeature = {
  ...classifier,
  id: "offline.news.summary",
  policy: {
    ...classifier.policy,
    role: "offline.summary.sonnet",
    feature: "news_summary",
    allowedModels: ["anthropic.sonnet@2026-10"],
    defaultModel: "anthropic.sonnet@2026-10",
    maxOutputTokens: 512,
    maxTransportAttempts: 1,
  },
  systemInstructions:
    "Summarize ONLY the synthetic statement supplied. Preserve its evidence identifier.",
  schema: {
    name: "synthetic_summary",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["summary", "evidence"],
      properties: {
        summary: { type: "string", minLength: 1, maxLength: 160 },
        evidence: { type: "string", enum: ["synthetic-1"] },
      },
    },
  },
  maxTotalCostUsd: 0.05,
};
const uid = "00000000-0000-4000-8000-000000000001",
  brand = "00000000-0000-4000-8000-000000000002";
/** OFFLINE ONLY. Live requires durable atomic caller-owned storage, never this process-local fake. */
export class FakeStore implements ConsumerCallStore {
  readonly entries = new Map<
    string,
    { identity: CallIdentity; owner: string; result?: BridgeResult }
  >();
  calls = 0;
  claim(i: CallIdentity): Promise<CallClaim> {
    this.calls++;
    const e = this.entries.get(i.key);
    if (e) {
      if (
        e.identity.tenantTag !== i.tenantTag ||
        e.identity.fingerprint !== i.fingerprint
      ) return Promise.resolve({ kind: "conflict" });
      if (e.result) {
        return Promise.resolve({
          kind: "complete",
          fingerprint: e.identity.fingerprint,
          result: JSON.parse(JSON.stringify(e.result)),
        });
      }
      return Promise.resolve({ kind: "busy" });
    }
    const owner = "owner_" + this.calls;
    this.entries.set(i.key, { identity: i, owner });
    return Promise.resolve({ kind: "acquired", owner });
  }
  complete(i: CallIdentity, owner: string, r: BridgeResult): Promise<void> {
    const e = this.entries.get(i.key);
    if (
      !e || e.owner !== owner || e.identity.fingerprint !== i.fingerprint ||
      e.identity.tenantTag !== i.tenantTag || e.result
    ) throw new Error("offline_store_refused");
    e.result = JSON.parse(JSON.stringify(r));
    return Promise.resolve();
  }
}
export class FakeLedger implements BudgetGuard {
  readonly inner: InMemoryBudgetGuard;
  readonly contexts: BudgetCallContext[] = [];
  readonly settlements: BudgetSettlement[] = [];
  readonly holds = new Set<string>();
  readonly sent = new Set<string>();
  constructor(maxCalls = 100) {
    this.inner = new InMemoryBudgetGuard([{
      id: "offline_only",
      scope: { provider: "anthropic", application: "offline_examples" },
      maxCalls,
      maxEstimatedUsd: 1,
      maxUsdPerCall: 0.1,
    }]);
  }
  async reserve(c: BudgetCallContext, u: number) {
    this.contexts.push(c);
    const r = await this.inner.reserve(c, u);
    if (r.allowed) this.holds.add(r.reservation.id);
    return r;
  }
  markSent(r: BudgetReservation): Promise<void> {
    if (!this.holds.has(r.id) || this.sent.has(r.id)) {
      throw new Error("offline_ledger_refused");
    }
    this.sent.add(r.id);
    return Promise.resolve();
  }
  async settle(r: BudgetReservation, c: number, s?: BudgetSettlement) {
    if (s) this.settlements.push(s);
    await this.inner.settle(r, c);
  }
  release(r: BudgetReservation): Promise<void> {
    if (this.sent.has(r.id)) throw new Error("offline_marked_sent");
    this.holds.delete(r.id);
    return Promise.resolve();
  }
}
export function world(
  options: {
    features?: ConsumerFeature[];
    ledger?: FakeLedger;
    store?: FakeStore;
    respond?: Parameters<typeof recordingFetch>[0];
    authorize?: ConsumerDeps["authorize"];
  } = {},
) {
  const store = options.store ?? new FakeStore(),
    ledger = options.ledger ?? new FakeLedger(),
    events: unknown[] = [];
  let keyReads = 0;
  const net = recordingFetch(
    options.respond ?? ((c) => {
      const req = c.body as { model: string };
      return jsonResponse(
        200,
        anthropicBody(
          req.model.includes("haiku")
            ? { severity: "high", evidence: "synthetic-1" }
            : {
              summary: "Synthetic outage drill completed.",
              evidence: "synthetic-1",
            },
          {
            model: req.model,
            usage: {
              input_tokens: 50,
              output_tokens: 30,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        ),
      );
    }),
  );
  const deps: ConsumerDeps = {
    store,
    authorize: options.authorize ?? ((proof) =>
      Promise.resolve(
        proof === "offline_system"
          ? { subject: { kind: "system" }, expiresAtMs: Date.now() + 60000 }
          : proof === "offline_user"
          ? {
            subject: { kind: "user", userId: uid, brandId: brand },
            expiresAtMs: Date.now() + 60000,
          }
          : null,
      )),
    audit: (e) => events.push(e),
    provider: {
      fetch: net.fetch,
      readEnv: () => {
        keyReads++;
        return "test-anthropic-key-NOT-REAL-000000";
      },
      budget: ledger,
      retryTiming: {
        baseDelayMs: 1,
        maxDelayMs: 1,
        maxRetryAfterMs: 10,
        minAttemptMs: 1,
      },
      sleep: () => Promise.resolve(),
      random: () => 0,
    },
  };
  const bridge = createConsumerBridge(
    "h5_m2_offline_v1",
    options.features ?? [classifier, summarizer],
    deps,
  );
  return { bridge, deps, store, ledger, net, events, keyReads: () => keyReads };
}
export const request = {
  feature: classifier.id,
  operationId: "synthetic_run_1",
  input:
    "Synthetic outage drill: two imaginary lights disabled. Evidence synthetic-1.",
};
Deno.test("offline Haiku severity integration calls registered F6 role/ledger, not live news", async () => {
  const w = world(), r = await w.bridge.execute("offline_system", request);
  assert.equal(r.ok, true);
  assert.equal(w.net.calls.length, 1);
  assert.ok(r.audit?.model.includes("haiku"));
  assert.equal(w.ledger.contexts[0].logicalRole, classifier.policy.role);
  assert.deepEqual(w.ledger.contexts[0].subject, { kind: "system" });
});
Deno.test("offline Sonnet summary integration with verified user/brand attribution", async () => {
  const w = world(),
    r = await w.bridge.execute("offline_user", {
      ...request,
      feature: summarizer.id,
    });
  assert.equal(r.ok, true);
  assert.ok(r.audit?.model.includes("sonnet"));
  assert.deepEqual(w.ledger.contexts[0].subject, {
    kind: "user",
    userId: uid,
    brandId: brand,
  });
  assert.ok(!JSON.stringify(w.events).includes(uid));
  assert.ok(!JSON.stringify(w.events).includes(request.input));
});
