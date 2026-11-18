// Task54: the comparison runner stops the whole trial, never per provider.
// Every response below is a local mock; no request leaves the process.
import assert from "node:assert/strict";
import test from "node:test";
import {
  createAiLabTextStages,
} from "./ai_lab_post.ts";
import {
  checkLiveComparePlan,
  createLiveCompareGate,
  LIVE_COMPARE_PAID_URL,
  type LiveCompareRun,
  runLiveCompare,
} from "./ai_lab_live_compare.ts";
import type { FetchLike } from "./adapter.ts";
import {
  LIVE_COMPARE_CAP_KIND,
  type LiveCompareBudget,
  type LiveComparePriceCheck,
  planWorstCaseUsd,
  worstPricesPer1M,
} from "./ai_lab_live_compare_budget.ts";
import { AI_PROVIDER_CATALOG_VERSION, findModelSpec } from "./model_catalog.ts";
import {
  anthropicBody,
  FAKE_ANTHROPIC_KEY,
  FAKE_OPENAI_KEY,
  jsonResponse,
  openAiBody,
  type RecordedCall,
  recordingFetch,
} from "./test_support.ts";

const TWO_STAGE = { AI_LAB_CLAUDE_TWO_STAGE: "enabled" };
// Task53 plan: A = Opus→Opus, B = Sol→Sol, C = Luna→Sol, each on 10/09 and 10/10.
const A = (topic: string): LiveCompareRun => ({
  label: `A-${topic}`,
  provider: "anthropic",
  generateModel: "claude-opus-5-5",
  rewriteModel: "claude-opus-5-5",
  env: { ...TWO_STAGE },
});
const B = (topic: string): LiveCompareRun => ({
  label: `B-${topic}`,
  provider: "openai",
  generateModel: "gpt-6.1-sol",
  rewriteModel: "gpt-6.1-sol",
  env: { ...TWO_STAGE, AI_LAB_TEXT_PROVIDER: "openai" },
});
const C = (topic: string): LiveCompareRun => ({
  label: `C-${topic}`,
  provider: "openai",
  generateModel: "gpt-6-luna",
  rewriteModel: "gpt-6.1-sol",
  env: { ...TWO_STAGE, AI_LAB_TEXT_PROVIDER: "openai", AI_LAB_TEXT_MODE: "luna_sol" },
});
const PLAN = [A("1009"), A("1010"), B("1009"), B("1010"), C("1009"), C("1010")];

const KEYS: Record<string, string> = {
  AI_LAB_TEXT_API_KEY: FAKE_ANTHROPIC_KEY,
  AI_LAB_OPENAI_TEXT_API_KEY: FAKE_OPENAI_KEY,
};
const readEnv = (name: string) => KEYS[name];

// Task55: every trial needs an explicit budget and a fresh price check. These
// numbers are test values only, not an approval.
const NOW = Date.parse("2026-11-18T03:00:00Z");
const PRICE_CHECK: LiveComparePriceCheck = {
  checkedAtMs: NOW - 60_000,
  catalogVersion: AI_PROVIDER_CATALOG_VERSION,
  prices: {
    "claude-opus-5-5": { inputPer1M: 4, outputPer1M: 20 },
    "gpt-6.1-sol": { inputPer1M: 2, outputPer1M: 10 },
    "gpt-6-luna": { inputPer1M: 0.1, outputPer1M: 0.5 },
  },
};
const budgetFor = (maxPaidCalls: number): LiveCompareBudget => ({
  approvalRef: "test-only",
  ceilingUsd: 100,
  maxPaidCalls,
  maxInputTokensPerCall: 30_000,
  maxOutputTokensPerCall: 3072,
});
const go = (maxPaidCalls: number) => ({
  budget: budgetFor(maxPaidCalls),
  priceCheck: PRICE_CHECK,
  now: () => NOW,
});

const isPaid = (call: RecordedCall) => call.method === "POST";
const paidTo = (calls: RecordedCall[], provider: "anthropic" | "openai") =>
  calls.filter((c) => isPaid(c) && c.url.startsWith(LIVE_COMPARE_PAID_URL[provider]))
    .length;

/** The model the free check asked about. */
const checkedModel = (call: RecordedCall) =>
  decodeURIComponent(call.url.split("/v1/models/")[1] ?? "");

const REWRITE_REPLY = { decision: "keep", text: "x", edits: [] };

/** A paid answer for the requested model, in that provider's wire format. */
function paidAnswer(call: RecordedCall, model?: string) {
  const requested = (call.body as { model: string }).model;
  const isRewrite = JSON.stringify(call.body).includes('"decision"');
  const payload = isRewrite ? REWRITE_REPLY : { text: "下書き" };
  return call.url.startsWith(LIVE_COMPARE_PAID_URL.anthropic)
    ? jsonResponse(200, anthropicBody(payload, { model: model ?? requested }))
    : jsonResponse(200, openAiBody(payload, { model: model ?? `${requested}-2026-09-01` }));
}

function modelCheck(call: RecordedCall, status = 200) {
  return jsonResponse(status, status === 200 ? { id: checkedModel(call) } : { error: {} });
}

/** Drives the real AI Lab stages (adapters, SDK, transport policy) with the gate's fetch. */
async function runOne(
  run: LiveCompareRun,
  deps: { fetch: FetchLike; readEnv: (name: string) => string | undefined },
) {
  const stages = createAiLabTextStages(deps);
  assert(stages.textProvider && stages.rewriteVoice);
  const request = {
    brandId: "ai_salaryman_lab",
    postType: "brand_post",
    instructions: "テスト",
    input: `題材 ${run.label}`,
  };
  await stages.textProvider({ ...request, maxOutputTokens: 1500 });
  await stages.rewriteVoice(request);
  return "DRAFT_AND_REWRITE_RETURNED";
}

test("plan: a run whose server setting picks other models is refused before any request", async () => {
  const { fetch, calls } = recordingFetch(() => {
    throw new Error("must not be called");
  });
  // C planned as Luna→Sol but its env forgets luna_sol: the server would run Sol→Sol.
  const wrongC = { ...C("1009"), env: { ...TWO_STAGE, AI_LAB_TEXT_PROVIDER: "openai" } };
  assert.deepEqual(checkLiveComparePlan([wrongC]), "PLAN_MODEL_MISMATCH");
  const result = await runLiveCompare([A("1009"), wrongC], {
    fetch,
    readEnv,
    ...go(12),
    runOne,
  });
  assert.deepEqual([result.stop, result.stoppedAt, result.paidCalls], [
    "PLAN_MODEL_MISMATCH",
    "plan",
    0,
  ]);
  assert.deepEqual(calls.length, 0);
});

test("Task53 regression: OpenAI 401 on the free check → Claude paid 0, whole trial stops", async () => {
  const { fetch, calls } = recordingFetch((call) => {
    if (isPaid(call)) return paidAnswer(call);
    return modelCheck(call, call.url.includes("api.openai.com") ? 401 : 200);
  });
  const result = await runLiveCompare(PLAN, { fetch, readEnv, ...go(12), runOne });
  assert.deepEqual(result.status, "stopped");
  assert.deepEqual(result.stop, "PREFLIGHT_AUTH_FAILED");
  assert.deepEqual(result.stoppedAt, "preflight");
  assert.deepEqual(result.paidCalls, 0);
  assert.deepEqual(paidTo(calls, "anthropic"), 0);
  assert.deepEqual(paidTo(calls, "openai"), 0);
  assert.deepEqual(result.runs, []);
  // The Claude check ran first (plan order) and passed; the stop still covers it.
  assert.deepEqual(calls.map(checkedModel), ["claude-opus-5-5", "gpt-6.1-sol"]);
});

test("Claude auth failure on the free check → OpenAI paid 0", async () => {
  const { fetch, calls } = recordingFetch((call) => {
    if (isPaid(call)) return paidAnswer(call);
    return modelCheck(call, call.url.includes("api.anthropic.com") ? 401 : 200);
  });
  // OpenAI runs first in the plan: its checks pass, Claude's fails, nobody is billed.
  const result = await runLiveCompare([B("1009"), C("1009"), A("1009")], {
    fetch,
    readEnv,
    ...go(12),
    runOne,
  });
  assert.deepEqual([result.stop, result.paidCalls], ["PREFLIGHT_AUTH_FAILED", 0]);
  assert.deepEqual(paidTo(calls, "openai"), 0);
  assert.deepEqual(paidTo(calls, "anthropic"), 0);
});

test("preflight: model not available, wrong id, network error or a missing key also stop with 0 paid", async () => {
  for (
    const [responder, expected] of [
      [(c: RecordedCall) => modelCheck(c, checkedModel(c) === "gpt-6-luna" ? 404 : 200), "PREFLIGHT_MODEL_UNAVAILABLE"],
      [() => jsonResponse(200, { id: "other-model" }), "PREFLIGHT_MODEL_UNAVAILABLE"],
      [(c: RecordedCall) => modelCheck(c, 500), "PREFLIGHT_UNEXPECTED"],
      [() => Promise.reject(new TypeError("network")), "PREFLIGHT_NETWORK"],
    ] as const
  ) {
    const { fetch, calls } = recordingFetch(responder);
    const result = await runLiveCompare(PLAN, { fetch, readEnv, ...go(12), runOne });
    assert.deepEqual([result.stop, result.paidCalls], [expected, 0]);
    assert.deepEqual(calls.filter(isPaid).length, 0);
  }
  const { fetch, calls } = recordingFetch(() => {
    throw new Error("must not be called");
  });
  const noOpenAiKey = (name: string) =>
    name === "AI_LAB_OPENAI_TEXT_API_KEY" ? undefined : KEYS[name];
  const result = await runLiveCompare(PLAN, {
    fetch,
    readEnv: noOpenAiKey,
    ...go(12),
    runOne,
  });
  assert.deepEqual([result.stop, result.paidCalls, calls.length], ["KEY_MISSING", 0, 0]);
});

test("all checks pass → the trial may start and every run goes through the gate", async () => {
  const { fetch, calls } = recordingFetch((call) =>
    isPaid(call) ? paidAnswer(call) : modelCheck(call)
  );
  const result = await runLiveCompare(PLAN, { fetch, readEnv, ...go(12), runOne });
  assert.deepEqual(result.status, "completed");
  assert.deepEqual(result.paidCalls, 12);
  assert.deepEqual(result.runs.map((r) => r.outcome), Array(6).fill("DRAFT_AND_REWRITE_RETURNED"));
  // Free checks: each planned model once, all before the first paid call.
  const firstPaid = calls.findIndex(isPaid);
  assert.deepEqual(calls.slice(0, firstPaid).map(checkedModel), [
    "claude-opus-5-5",
    "gpt-6.1-sol",
    "gpt-6-luna",
  ]);
  // C drafts with Luna and rewrites with Sol; nothing else is sent.
  const cModels = result.ledger.filter((e) => e.kind === "paid" && e.run?.startsWith("C"))
    .map((e) => e.model);
  assert.deepEqual(cModels, ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-luna", "gpt-6.1-sol"]);
});

test("paid 401 after a passing preflight stops every later run and provider", async () => {
  const { fetch, calls } = recordingFetch((call) => {
    if (!isPaid(call)) return modelCheck(call);
    return paidTo(calls, "anthropic") === 2
      ? jsonResponse(401, { type: "error", error: { type: "authentication_error", message: "x" } })
      : paidAnswer(call);
  });
  const result = await runLiveCompare(PLAN, { fetch, readEnv, ...go(12), runOne });
  assert.deepEqual([result.stop, result.stoppedAt], ["PAID_AUTH_FAILED", "A-1009"]);
  assert.deepEqual(result.paidCalls, 2);
  assert.deepEqual(paidTo(calls, "openai"), 0);
  assert.deepEqual(result.runs.map((r) => r.label), ["A-1009"]);
});

test("timeout / network error / unknown body after a paid send → retry 0, whole trial stops", async () => {
  for (
    const [fail, expected] of [
      [() => Promise.reject(new DOMException("aborted", "AbortError")), "PAID_UNKNOWN_OUTCOME"],
      [() => Promise.reject(new TypeError("connection reset")), "PAID_UNKNOWN_OUTCOME"],
      [() => new Response("<html>", { status: 200 }), "PAID_UNKNOWN_OUTCOME"],
      [() => jsonResponse(529, { type: "error", error: { type: "overloaded_error", message: "x" } }), "PAID_UNEXPECTED_RESPONSE"],
      [() => jsonResponse(500, { error: { message: "x" } }), "PAID_UNEXPECTED_RESPONSE"],
    ] as const
  ) {
    for (const plan of [[A("1009"), B("1009")], [B("1009"), A("1009")]]) {
      const { fetch, calls } = recordingFetch((call) =>
        isPaid(call) ? fail() : modelCheck(call)
      );
      const result = await runLiveCompare(plan, { fetch, readEnv, ...go(12), runOne });
      assert.deepEqual([result.stop, result.paidCalls], [expected, 1], String(fail));
      // The one send is never repeated, by the SDK, the transport or the runner.
      assert.deepEqual(calls.filter(isPaid).length, 1);
      assert.deepEqual(result.runs.length, 1);
    }
  }
});

test("an answer from another model is never accepted as a fallback", async () => {
  const { fetch, calls } = recordingFetch((call) =>
    isPaid(call) ? paidAnswer(call, "claude-sonnet-5-5") : modelCheck(call)
  );
  const result = await runLiveCompare(PLAN, { fetch, readEnv, ...go(12), runOne });
  assert.deepEqual([result.stop, result.paidCalls], ["PAID_MODEL_SUBSTITUTED", 1]);
  assert.deepEqual(result.ledger.at(-1)?.responseModel, "claude-sonnet-5-5");
  assert.deepEqual(paidTo(calls, "openai"), 0);

  // OpenAI: a dated snapshot of the requested alias is the same model; Sol for Luna is not.
  const luna = recordingFetch((call) =>
    isPaid(call) ? paidAnswer(call, "gpt-6.1-sol-2026-09-01") : modelCheck(call)
  );
  const stopped = await runLiveCompare([C("1009")], {
    fetch: luna.fetch,
    readEnv,
    ...go(12),
    runOne,
  });
  assert.deepEqual([stopped.stop, stopped.paidCalls], ["PAID_MODEL_SUBSTITUTED", 1]);
});

test("a run asking for an unplanned model, a re-sent body or a call over the cap is refused unsent", async () => {
  const sendOnce = (run: LiveCompareRun) => {
    const body = JSON.stringify({ model: run.generateModel, max_tokens: 100, input: "同じ" });
    return { body, run };
  };
  for (
    const [runOne2, expected, sent] of [
      [async (run: LiveCompareRun, d: { fetch: FetchLike }) => {
        await d.fetch(LIVE_COMPARE_PAID_URL[run.provider], {
          method: "POST",
          body: JSON.stringify({ model: "claude-sonnet-5-5", max_tokens: 100 }),
        });
        return "SENT";
      }, "REQUEST_MODEL_NOT_PLANNED", 0],
      [async (run: LiveCompareRun, d: { fetch: FetchLike }) => {
        const { body } = sendOnce(run);
        await d.fetch(LIVE_COMPARE_PAID_URL[run.provider], { method: "POST", body });
        await d.fetch(LIVE_COMPARE_PAID_URL[run.provider], { method: "POST", body });
        return "SENT";
      }, "RETRY_REFUSED", 1],
      [async (_run: LiveCompareRun, d: { fetch: FetchLike }) => {
        await d.fetch(LIVE_COMPARE_PAID_URL.anthropic.replace("messages", "complete"), { method: "POST", body: "{}" });
        return "SENT";
      }, "REQUEST_NOT_ALLOWED", 0],
      [async (run: LiveCompareRun, d: { fetch: FetchLike }) => {
        for (let i = 0; i < 5; i += 1) {
          await d.fetch(LIVE_COMPARE_PAID_URL[run.provider], {
            method: "POST",
            body: JSON.stringify({ model: run.generateModel, max_tokens: 100, n: i }),
          });
        }
        return "SENT";
      }, "PAID_CALL_CAP", 4],
    ] as const
  ) {
    const { fetch, calls } = recordingFetch((call) =>
      isPaid(call)
        ? jsonResponse(200, {
          model: (call.body as { model: string }).model,
          usage: { input_tokens: 10, output_tokens: 10 },
        })
        : modelCheck(call)
    );
    const result = await runLiveCompare([A("1009"), B("1009")], {
      fetch,
      readEnv,
      ...go(4),
      runOne: runOne2,
    });
    assert.deepEqual([result.stop, calls.filter(isPaid).length], [expected, sent]);
    assert.deepEqual(paidTo(calls, "openai"), 0);
  }
});

test("dry run: the Task53 plan with mocks only — 12 sends planned, no real host reached", async () => {
  // The mock fetch is the only transport; a real fetch would need --allow-net, which the test task never grants.
  const { fetch, calls } = recordingFetch((call) =>
    isPaid(call) ? paidAnswer(call) : modelCheck(call)
  );
  const result = await runLiveCompare(PLAN, { fetch, readEnv, ...go(12), runOne });
  assert.deepEqual(result.paidCalls, 12);
  assert.deepEqual(calls.length, 15);
  assert(calls.every((c) => c.url.startsWith("https://api.anthropic.com/") || c.url.startsWith("https://api.openai.com/")));
  // No key in the ledger.
  assert(!JSON.stringify(result).includes(FAKE_ANTHROPIC_KEY));
  assert(!JSON.stringify(result).includes(FAKE_OPENAI_KEY));
});

// ---- Task55: price confirmation and budget gates (mocks only) ----

const PLAN_MODELS = PLAN.flatMap((r) => [r.generateModel, r.rewriteModel]);
const noFetch = () =>
  recordingFetch(() => {
    throw new Error("must not be called");
  });

test("Task55: no approved budget → stop before any request (no default, Task53's $0.30 not reused)", async () => {
  const bad: (LiveCompareBudget | undefined)[] = [
    undefined,
    { ...budgetFor(12), approvalRef: " " },
    { ...budgetFor(12), ceilingUsd: 0 },
    { ...budgetFor(12), ceilingUsd: Number.NaN },
    { ...budgetFor(12), ceilingUsd: Number.POSITIVE_INFINITY },
    { ...budgetFor(12), maxPaidCalls: 0 },
    { ...budgetFor(12), maxInputTokensPerCall: 1.5 },
    { ...budgetFor(12), maxOutputTokensPerCall: -1 },
  ];
  for (const budget of bad) {
    const { fetch, calls } = noFetch();
    const result = await runLiveCompare(PLAN, { fetch, readEnv, ...go(12), budget, runOne });
    assert.deepEqual([result.stop, result.stoppedAt, result.paidCalls, calls.length], [
      "BUDGET_NOT_APPROVED",
      "plan",
      0,
      0,
    ]);
  }
});

test("Task55: a call cap below the planned calls is refused up front (no partial trial)", async () => {
  const { fetch, calls } = noFetch();
  const result = await runLiveCompare(PLAN, { fetch, readEnv, ...go(11), runOne });
  assert.deepEqual([result.stop, calls.length], ["PLAN_EXCEEDS_CALL_CAP", 0]);
});

test("Task55: unconfirmed, stale or changed prices stop before the free checks too", async () => {
  const hour = 60 * 60 * 1000;
  const cases: [LiveComparePriceCheck | undefined, string][] = [
    [undefined, "PRICE_UNCONFIRMED"],
    [{ ...PRICE_CHECK, prices: { ...PRICE_CHECK.prices, "gpt-6-luna": undefined! } }, "PRICE_UNCONFIRMED"],
    [{ ...PRICE_CHECK, prices: { "claude-opus-5-5": PRICE_CHECK.prices["claude-opus-5-5"] } }, "PRICE_UNCONFIRMED"],
    [{ ...PRICE_CHECK, checkedAtMs: NOW - 24 * hour - 1 }, "PRICE_CHECK_STALE"],
    [{ ...PRICE_CHECK, checkedAtMs: NOW + 1 }, "PRICE_CHECK_STALE"],
    [{ ...PRICE_CHECK, checkedAtMs: Number.NaN }, "PRICE_UNCONFIRMED"],
    [{ ...PRICE_CHECK, catalogVersion: "ai-provider-catalog/old" }, "PRICE_CHANGED"],
    [{
      ...PRICE_CHECK,
      prices: { ...PRICE_CHECK.prices, "gpt-6.1-sol": { inputPer1M: 2.5, outputPer1M: 10 } },
    }, "PRICE_CHANGED"],
    [{
      ...PRICE_CHECK,
      prices: { ...PRICE_CHECK.prices, "claude-opus-5-5": { inputPer1M: 4, outputPer1M: 25 } },
    }, "PRICE_CHANGED"],
  ];
  for (const [priceCheck, expected] of cases) {
    const { fetch, calls } = noFetch();
    const result = await runLiveCompare(PLAN, { fetch, readEnv, ...go(12), priceCheck, runOne });
    assert.deepEqual([result.stop, calls.length], [expected, 0], expected);
  }
  // Exactly 24 hours old still counts.
  const { fetch } = recordingFetch((call) => isPaid(call) ? paidAnswer(call) : modelCheck(call));
  const edge = await runLiveCompare(PLAN, {
    fetch,
    readEnv,
    ...go(12),
    priceCheck: { ...PRICE_CHECK, checkedAtMs: NOW - 24 * hour },
    runOne,
  });
  assert.deepEqual(edge.status, "completed");
});

test("Task55: worst-case prices take the dearest tier and cache rate", () => {
  assert.deepEqual(worstPricesPer1M(findModelSpec("claude-opus-5-5")!), { input: 8, output: 20 });
  assert.deepEqual(worstPricesPer1M(findModelSpec("gpt-6.1-sol")!), { input: 4, output: 15 });
  assert.deepEqual(worstPricesPer1M(findModelSpec("claude-haiku-5-5")!), { input: 1, output: 2.5 });
});

test("Task55: ceiling boundary — plan worst case equal passes, one unit below stops with 0 requests", async () => {
  const budget = budgetFor(12);
  const worst = planWorstCaseUsd(PLAN_MODELS, budget);
  // 6 runs × 2 calls at 30,000 in / 3,072 out, ×1.25: Opus 2×4 + Sol 2×4 + Luna 2×2 calls.
  const opus = (30_000 * 8 + 3072 * 20) / 1e6 * 1.25;
  const sol = (30_000 * 4 + 3072 * 15) / 1e6 * 1.25;
  const luna = (30_000 * 0.1 + 3072 * 0.5) / 1e6 * 1.25;
  assert(Math.abs(worst - (4 * opus + 6 * sol + 2 * luna)) < 1e-6, String(worst));

  const below = noFetch();
  const stopped = await runLiveCompare(PLAN, {
    fetch: below.fetch,
    readEnv,
    ...go(12),
    budget: { ...budget, ceilingUsd: worst - 1e-8 },
    runOne,
  });
  assert.deepEqual([stopped.stop, below.calls.length], ["BUDGET_INSUFFICIENT_FOR_PLAN", 0]);
  assert.deepEqual(stopped.budget.planWorstCaseUsd, worst);

  const { fetch } = recordingFetch((call) => isPaid(call) ? paidAnswer(call) : modelCheck(call));
  const ok = await runLiveCompare(PLAN, {
    fetch,
    readEnv,
    ...go(12),
    budget: { ...budget, ceilingUsd: worst },
    runOne,
  });
  assert.deepEqual([ok.status, ok.paidCalls], ["completed", 12]);
  assert(ok.budget.reservedUsd <= worst);

  // Spare calls under the cap are priced at the dearest planned model.
  assert(planWorstCaseUsd(PLAN_MODELS, budgetFor(13)) - worst - opus > -1e-6);
});

test("Task55: a body without an output limit, with tools or over the declared limits is refused unsent", async () => {
  const send = (body: Record<string, unknown>) =>
  async (run: LiveCompareRun, d: { fetch: FetchLike }) => {
    await d.fetch(LIVE_COMPARE_PAID_URL[run.provider], {
      method: "POST",
      body: JSON.stringify({ model: run.generateModel, ...body }),
    });
    return "SENT";
  };
  for (
    const [runOne2, expected] of [
      [send({}), "REQUEST_UNBOUNDED"],
      [send({ max_tokens: 0 }), "REQUEST_UNBOUNDED"],
      [send({ max_tokens: 100, tools: [{ type: "web_search_20250305" }] }), "REQUEST_UNBOUNDED"],
      [send({ max_tokens: 3073 }), "REQUEST_OVER_LIMITS"],
      [send({ max_tokens: 100, input: "あ".repeat(10_000) }), "REQUEST_OVER_LIMITS"],
    ] as const
  ) {
    const { fetch, calls } = recordingFetch((call) => isPaid(call) ? paidAnswer(call) : modelCheck(call));
    const result = await runLiveCompare([A("1009"), B("1009")], {
      fetch,
      readEnv,
      ...go(4),
      runOne: runOne2,
    });
    assert.deepEqual([result.stop, result.paidCalls, calls.filter(isPaid).length], [expected, 0, 0], expected);
    assert.deepEqual(result.runs.length, 1);
  }
  // The real stages: the rewrite asks for 3,072 output tokens; a 1,500 limit stops at that send.
  const { fetch, calls } = recordingFetch((call) => isPaid(call) ? paidAnswer(call) : modelCheck(call));
  const result = await runLiveCompare(PLAN, {
    fetch,
    readEnv,
    ...go(12),
    budget: { ...budgetFor(12), maxOutputTokensPerCall: 1500 },
    runOne,
  });
  assert.deepEqual([result.stop, result.paidCalls, calls.filter(isPaid).length], ["REQUEST_OVER_LIMITS", 1, 1]);
  assert.deepEqual(paidTo(calls, "openai"), 0);
});

test("Task55: 200 without usage, or usage above the reserved bound, stops the whole trial", async () => {
  for (
    const [usage, expected] of [
      [{}, "PAID_USAGE_MISSING"],
      [{ input_tokens: 10 }, "PAID_USAGE_MISSING"],
      [{ input_tokens: -1, output_tokens: 1 }, "PAID_USAGE_MISSING"],
      [{ input_tokens: 10, output_tokens: 3073 }, "PAID_COST_OVERRUN"],
      [{ input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 999_999 }, "PAID_COST_OVERRUN"],
    ] as const
  ) {
    const { fetch, calls } = recordingFetch((call) => {
      if (!isPaid(call)) return modelCheck(call);
      const body = anthropicBody({ text: "下書き" }, { usage });
      if (Object.keys(usage).length === 0) delete body.usage;
      return jsonResponse(200, body);
    });
    const result = await runLiveCompare(PLAN, { fetch, readEnv, ...go(12), runOne });
    assert.deepEqual([result.stop, result.stoppedAt, result.paidCalls], [expected, "A-1009", 1], expected);
    assert.deepEqual(paidTo(calls, "openai"), 0);
    // The reservation of the one send stays counted.
    assert(result.budget.reservedUsd > 0);
    assert.deepEqual(result.budget.reservedUsd, result.ledger.find((e) => e.kind === "paid")?.reservedUsd);
  }
});

test("Task55: OpenAI 401 after Claude runs finished → C never starts, nothing re-sent, reservations kept", async () => {
  const { fetch, calls } = recordingFetch((call) => {
    if (!isPaid(call)) return modelCheck(call);
    return call.url.startsWith(LIVE_COMPARE_PAID_URL.openai)
      ? jsonResponse(401, { error: { message: "x", type: "invalid_request_error", code: "invalid_api_key" } })
      : paidAnswer(call);
  });
  const result = await runLiveCompare(PLAN, { fetch, readEnv, ...go(12), runOne });
  assert.deepEqual([result.stop, result.stoppedAt, result.paidCalls], ["PAID_AUTH_FAILED", "B-1009", 5]);
  assert.deepEqual([paidTo(calls, "anthropic"), paidTo(calls, "openai")], [4, 1]);
  assert(!result.runs.some((r) => r.label.startsWith("C")));
  const reserved = result.ledger.filter((e) => e.kind === "paid").reduce((t, e) => t + e.reservedUsd!, 0);
  assert(Math.abs(result.budget.reservedUsd - reserved) < 1e-9);
});

test("Task55: the running ceiling refuses a send that would exceed it (gate alone)", async () => {
  const { fetch, calls } = recordingFetch((call) => paidAnswer(call));
  const gate = createLiveCompareGate({
    fetch,
    budget: { ...budgetFor(10), ceilingUsd: 0.0001 },
  });
  const body = JSON.stringify({ model: "claude-opus-5-5", max_tokens: 100 });
  await assert.rejects(
    gate.forRun(A("1009"))(LIVE_COMPARE_PAID_URL.anthropic, { method: "POST", body }),
    /BUDGET_EXCEEDED/,
  );
  assert.deepEqual([gate.paidCalls(), gate.reservedUsd(), calls.length], [0, 0, 0]);
});

test("Task55: the free check records key acceptance apart from model availability", async () => {
  for (
    const [status, auth, available, stop] of [
      [401, "rejected", null, "PREFLIGHT_AUTH_FAILED"],
      [403, "forbidden", null, "PREFLIGHT_AUTH_FAILED"],
      [404, "ok", false, "PREFLIGHT_MODEL_UNAVAILABLE"],
      [500, null, null, "PREFLIGHT_UNEXPECTED"],
    ] as const
  ) {
    const { fetch } = recordingFetch((c) => modelCheck(c, checkedModel(c) === "gpt-6.1-sol" ? status : 200));
    const result = await runLiveCompare(PLAN, { fetch, readEnv, ...go(12), runOne });
    assert.deepEqual(result.stop, stop);
    assert.deepEqual(
      result.ledger.map((e) => [e.model, e.auth, e.modelAvailable]),
      [["claude-opus-5-5", "ok", true], ["gpt-6.1-sol", auth, available]],
    );
  }
  const wrongId = recordingFetch(() => jsonResponse(200, { id: "other" }));
  const result = await runLiveCompare(PLAN, { fetch: wrongId.fetch, readEnv, ...go(12), runOne });
  assert.deepEqual(result.ledger.map((e) => [e.auth, e.modelAvailable]), [["ok", false]]);
});

test("Task55 dry run: 2 topics × A/B/C with mocks — budget summary, reservation ≥ measured, not a hard cap", async () => {
  const { fetch, calls } = recordingFetch((call) => isPaid(call) ? paidAnswer(call) : modelCheck(call));
  const result = await runLiveCompare(PLAN, { fetch, readEnv, ...go(12), runOne });
  assert.deepEqual([result.status, result.paidCalls, calls.length], ["completed", 12, 15]);
  assert.deepEqual(result.budget.capKind, LIVE_COMPARE_CAP_KIND);
  assert.deepEqual(result.budget.capKind, "client_estimate_not_hard_cap");
  assert(result.budget.reservedUsd <= result.budget.planWorstCaseUsd!);
  assert(result.budget.planWorstCaseUsd! <= result.budget.ceilingUsd!);
  const paid = result.ledger.filter((e) => e.kind === "paid");
  assert.deepEqual(paid.map((e) => `${e.run}:${e.model}`), [
    "A-1009:claude-opus-5-5", "A-1009:claude-opus-5-5",
    "A-1010:claude-opus-5-5", "A-1010:claude-opus-5-5",
    "B-1009:gpt-6.1-sol", "B-1009:gpt-6.1-sol",
    "B-1010:gpt-6.1-sol", "B-1010:gpt-6.1-sol",
    "C-1009:gpt-6-luna", "C-1009:gpt-6.1-sol",
    "C-1010:gpt-6-luna", "C-1010:gpt-6.1-sol",
  ]);
  assert(paid.every((e) => e.measuredUsd !== null && e.measuredUsd! <= e.reservedUsd!));
  // Draft 1,500 / rewrite 3,072 output tokens, as the AI Lab stages ask.
  assert.deepEqual(paid.slice(0, 2).map((e) => e.boundTokens?.output), [1500, 3072]);
  assert(paid.every((e) => e.boundTokens!.input > 2048 && e.boundTokens!.input <= 30_000));
  assert(calls.every((c) => c.url.startsWith("https://api.anthropic.com/") || c.url.startsWith("https://api.openai.com/")));
});
