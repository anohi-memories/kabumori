import assert from "node:assert/strict";
import { createConsumerBridge } from "./bridge.ts";
import type { BridgeResult } from "./types.ts";
import {
  classifier,
  FakeLedger,
  FakeStore,
  request,
  summarizer,
  world,
} from "./offline_samples_test.ts";
import {
  anthropicBody,
  hangUntilAborted,
  jsonResponse,
} from "../ai_provider/test_support.ts";
for (
  const [name, change, code] of [
    ["feature", { feature: "live.news.unapproved" }, "FEATURE_DENIED"],
    ["untrusted subject", { subject: { kind: "system" } }, "REQUEST_INVALID"],
    ["untrusted user", { userId: "other" }, "REQUEST_INVALID"],
    [
      "unknown role",
      { selection: { role: "administrator" } },
      "REQUEST_INVALID",
    ],
    [
      "model override",
      { selection: { model: "anthropic.sonnet@2026-10" } },
      "POLICY_DENIED",
    ],
    [
      "output override",
      { selection: { maxOutputTokens: 10000 } },
      "POLICY_DENIED",
    ],
    ["effort override", { selection: { effort: "max" } }, "POLICY_DENIED"],
    [
      "timeout override",
      { selection: { timeoutMs: 100000 } },
      "REQUEST_INVALID",
    ],
    ["input cap", { input: "a".repeat(4097) }, "REQUEST_INVALID"],
  ] as const
) {
  Deno.test("refuse before budget/key/network: " + name, async () => {
    const w = world(),
      r = await w.bridge.execute("offline_user", { ...request, ...change });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, code);
    assert.equal(w.keyReads(), 0);
    assert.equal(w.ledger.contexts.length, 0);
    assert.equal(w.net.calls.length, 0);
  });
}
Deno.test("expired/foreign/anonymous authority never reaches ledger", async () => {
  for (
    const authority of [null, {
      subject: { kind: "user", userId: "not-verified" },
      expiresAtMs: Date.now() + 60000,
    }, { subject: { kind: "system" }, expiresAtMs: 1 }]
  ) {
    const w = world({ authorize: () => Promise.resolve(authority as never) }),
      r = await w.bridge.execute("forged", request);
    assert.equal(r.ok, false);
    assert.equal(w.net.calls.length, 0);
    assert.equal(w.ledger.contexts.length, 0);
  }
});
Deno.test("budget denial before transport; upper cost cap before key/reservation", async () => {
  const denied = world({ ledger: new FakeLedger(0) }),
    a = await denied.bridge.execute("offline_user", request);
  assert.equal(a.ok, false);
  if (!a.ok) assert.equal(a.code, "BUDGET_DENIED");
  assert.equal(denied.net.calls.length, 0);
  const cost = world({ features: [{ ...classifier, maxTotalCostUsd: 1e-9 }] }),
    b = await cost.bridge.execute("offline_user", request);
  assert.equal(b.ok, false);
  if (!b.ok) assert.equal(b.code, "COST_DENIED");
  assert.equal(cost.net.calls.length, 0);
  assert.equal(cost.keyReads(), 0);
});
Deno.test("bounded narrowing uses F6 allowed model/effort/output without widening", async () => {
  const w = world(),
    r = await w.bridge.execute("offline_user", {
      ...request,
      selection: { maxOutputTokens: 64, effort: "low" },
    });
  assert.equal(r.ok, true);
  assert.equal((w.net.calls[0].body as { max_tokens: number }).max_tokens, 64);
});
Deno.test("deterministic key, duplicate result re-read without another network request", async () => {
  const w = world(),
    a = await w.bridge.execute("offline_user", request),
    b = await w.bridge.execute("offline_user", request);
  assert.deepEqual(a, b);
  assert.equal(w.net.calls.length, 1);
  assert.equal(w.ledger.contexts.length, 1);
  const c = await w.bridge.execute("offline_user", {
    ...request,
    input: "Different synthetic claim.",
  });
  assert.equal(c.ok, false);
  if (!c.ok) assert.equal(c.code, "CONTENT_DRIFT");
  assert.equal(w.net.calls.length, 1);
});
Deno.test("same operation across distinct tenant/user/brand cannot reuse cache or key", async () => {
  const store = new FakeStore();
  const a = world({ store }),
    b = world({
      store,
      authorize: () =>
        Promise.resolve({
          subject: {
            kind: "user",
            userId: "00000000-0000-4000-8000-000000000003",
            brandId: "00000000-0000-4000-8000-000000000004",
          },
          expiresAtMs: Date.now() + 60000,
        }),
    });
  const ra = await a.bridge.execute("offline_user", request),
    rb = await b.bridge.execute("offline_user", request);
  assert.equal(ra.ok, true);
  assert.equal(rb.ok, true);
  assert.notEqual(ra.audit?.callId, rb.audit?.callId);
  assert.equal(a.net.calls.length + b.net.calls.length, 2);
});
Deno.test("two bridge instances share atomic claim and do not send same logical call twice", async () => {
  let ready: () => void = () => {}, release: () => void = () => {};
  const entered = new Promise<void>((r) => {
      ready = r;
    }),
    go = new Promise<void>((r) => {
      release = r;
    });
  const store = new FakeStore(),
    a = world({
      store,
      respond: async (c) => {
        ready();
        await go;
        return jsonResponse(
          200,
          anthropicBody({ severity: "high", evidence: "synthetic-1" }, {
            model: (c.body as { model: string }).model,
            usage: { input_tokens: 50, output_tokens: 30 },
          }),
        );
      },
    }),
    b = world({ store });
  const first = a.bridge.execute("offline_user", request);
  await entered;
  const second = await b.bridge.execute("offline_user", request);
  release();
  const results = [await first, second];
  assert.equal(a.net.calls.length + b.net.calls.length, 1);
  assert.ok(results.some((r) => r.ok));
  assert.ok(results.some((r) => !r.ok && r.code === "IN_PROGRESS"));
});
Deno.test("transient retry under same key/model is bounded by F6 policy; no fallback", async () => {
  const w = world({
    respond: (c, i) =>
      i === 0
        ? jsonResponse(529, {
          type: "error",
          error: { type: "overloaded_error", message: "offline_dummy_secret" },
        })
        : jsonResponse(
          200,
          anthropicBody({ severity: "high", evidence: "synthetic-1" }, {
            model: (c.body as { model: string }).model,
            usage: { input_tokens: 50, output_tokens: 30 },
          }),
        ),
  });
  const r = await w.bridge.execute("offline_user", request);
  assert.equal(r.ok, true);
  assert.equal(w.net.calls.length, 2);
  assert.equal(w.ledger.contexts[0].callId, w.ledger.contexts[1].callId);
  assert.equal(w.ledger.contexts[0].model, w.ledger.contexts[1].model);
});
Deno.test("schema/Fact failures never trigger business regeneration", async () => {
  for (const factReject of [false, true]) {
    const w = world({
      features: factReject
        ? [{ ...classifier, validateFacts: () => false }]
        : undefined,
      respond: (c) =>
        jsonResponse(
          200,
          anthropicBody(
            factReject
              ? { severity: "high", evidence: "synthetic-1" }
              : { severity: 99, evidence: "synthetic-1" },
            {
              model: (c.body as { model: string }).model,
              usage: { input_tokens: 50, output_tokens: 30 },
            },
          ),
        ),
    });
    const r = await w.bridge.execute("offline_user", request);
    assert.equal(r.ok, false);
    assert.equal(w.net.calls.length, 1);
    await w.bridge.execute("offline_user", request);
    assert.equal(w.net.calls.length, 1);
  }
});
Deno.test("provider unavailable is fixed failure, never alternate model", async () => {
  const w = world({
      respond: () =>
        jsonResponse(404, {
          type: "error",
          error: { type: "not_found_error", message: "offline_dummy_secret" },
        }),
    }),
    r = await w.bridge.execute("offline_user", request);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "MODEL_UNAVAILABLE");
  assert.equal(w.net.calls.length, 1);
  assert.ok(!JSON.stringify(r).includes("offline_dummy_secret"));
});
Deno.test("total deadline burns in-progress call and never retries timed-out transport", async () => {
  const w = world({
      features: [{ ...classifier, deadlineMs: 1000 }],
      respond: (_c, _i, init) => hangUntilAborted(init),
    }),
    r = await w.bridge.execute("offline_user", request);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "UNKNOWN");
  assert.equal(r.audit?.costBasis, "includes_upper_bound");
  assert.ok((r.audit?.estimatedCostUsd ?? 0) > 0);
  assert.equal(w.net.calls.length, 1);
  const retry = await w.bridge.execute("offline_user", request);
  assert.equal(retry.ok, false);
  assert.equal(w.net.calls.length, 1);
});
Deno.test("corrupt cached scope/error/payload cannot leak another tenant or raw error", async () => {
  const w = world();
  await w.bridge.execute("offline_user", request);
  const e = [...w.store.entries.values()][0];
  assert.ok(e.result?.audit);
  const original = JSON.parse(JSON.stringify(e.result)) as BridgeResult;
  for (
    const value of [
      { ...original, audit: { ...original.audit!, tenantTag: "other_tenant" } },
      { ok: false, code: "offline_dummy_secret", audit: original.audit },
      { ...original, providerBody: "offline_dummy_secret" },
    ]
  ) {
    e.result = value as BridgeResult;
    const r = await w.bridge.execute("offline_user", request);
    assert.equal(r.ok, false);
    assert.ok(!JSON.stringify(r).includes("offline_dummy_secret"));
  }
  assert.equal(w.net.calls.length, 1);
});
Deno.test("missing durable budget capabilities and invalid registration fail closed", () => {
  const w = world();
  assert.throws(
    () =>
      createConsumerBridge("v1", [classifier], {
        ...w.deps,
        provider: {
          ...w.deps.provider,
          budget: {
            reserve: w.deps.provider.budget.reserve,
            settle: w.deps.provider.budget.settle,
          },
        },
      }),
    /CONSUMER_BRIDGE_CONFIG_INVALID/,
  );
  assert.throws(
    () =>
      createConsumerBridge(
        "v1",
        [{ ...classifier, maxInputBytes: Infinity }],
        w.deps,
      ),
    /CONSUMER_BRIDGE_CONFIG_INVALID/,
  );
});
Deno.test("changed schema/policy revision is drift, not a second billable call", async () => {
  const w = world();
  await w.bridge.execute("offline_user", request);
  const bridge = createConsumerBridge("v2", [classifier], w.deps);
  const r = await bridge.execute("offline_user", request);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.code, "CONTENT_DRIFT");
  assert.equal(w.net.calls.length, 1);
});
Deno.test("store completion lost, Fact hook throw, audit throw are redacted and never replay", async () => {
  const s = new FakeStore();
  s.complete = () => Promise.reject(new Error("offline_dummy_secret"));
  const w = world({ store: s }),
    r = await w.bridge.execute("offline_user", request);
  assert.equal(r.ok, false);
  assert.ok(!JSON.stringify(r).includes("offline_dummy_secret"));
  await w.bridge.execute("offline_user", request);
  assert.equal(w.net.calls.length, 1);
  const bad = world({
      features: [{
        ...classifier,
        validateFacts: () => {
          throw new Error("offline_dummy_secret");
        },
      }],
    }),
    f = await bad.bridge.execute("offline_user", request);
  assert.equal(f.ok, false);
  assert.ok(!JSON.stringify(f).includes("offline_dummy_secret"));
  const good = world();
  const bridge = createConsumerBridge("v1", [classifier, summarizer], {
    ...good.deps,
    audit: () => {
      throw new Error("offline_dummy_secret");
    },
  });
  assert.equal((await bridge.execute("offline_user", request)).ok, true);
});
