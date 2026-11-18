// Task54: the comparison runner stops the whole trial, never per provider.
// Every response below is a local mock; no request leaves the process.
import assert from "node:assert/strict";
import test from "node:test";
import {
  createAiLabTextStages,
} from "./ai_lab_post.ts";
import {
  checkLiveComparePlan,
  LIVE_COMPARE_PAID_URL,
  type LiveCompareRun,
  runLiveCompare,
} from "./ai_lab_live_compare.ts";
import type { FetchLike } from "./adapter.ts";
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
    maxPaidCalls: 12,
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
  const result = await runLiveCompare(PLAN, { fetch, readEnv, maxPaidCalls: 12, runOne });
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
    maxPaidCalls: 12,
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
    const result = await runLiveCompare(PLAN, { fetch, readEnv, maxPaidCalls: 12, runOne });
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
    maxPaidCalls: 12,
    runOne,
  });
  assert.deepEqual([result.stop, result.paidCalls, calls.length], ["KEY_MISSING", 0, 0]);
});

test("all checks pass → the trial may start and every run goes through the gate", async () => {
  const { fetch, calls } = recordingFetch((call) =>
    isPaid(call) ? paidAnswer(call) : modelCheck(call)
  );
  const result = await runLiveCompare(PLAN, { fetch, readEnv, maxPaidCalls: 12, runOne });
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
  const result = await runLiveCompare(PLAN, { fetch, readEnv, maxPaidCalls: 12, runOne });
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
      const result = await runLiveCompare(plan, { fetch, readEnv, maxPaidCalls: 12, runOne });
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
  const result = await runLiveCompare(PLAN, { fetch, readEnv, maxPaidCalls: 12, runOne });
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
    maxPaidCalls: 12,
    runOne,
  });
  assert.deepEqual([stopped.stop, stopped.paidCalls], ["PAID_MODEL_SUBSTITUTED", 1]);
});

test("a run asking for an unplanned model, a re-sent body or a call over the cap is refused unsent", async () => {
  const sendOnce = (run: LiveCompareRun) => {
    const body = JSON.stringify({ model: run.generateModel, input: "同じ" });
    return { body, run };
  };
  for (
    const [runOne2, expected, sent] of [
      [async (run: LiveCompareRun, d: { fetch: FetchLike }) => {
        await d.fetch(LIVE_COMPARE_PAID_URL[run.provider], {
          method: "POST",
          body: JSON.stringify({ model: "claude-sonnet-5-5" }),
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
        for (let i = 0; i < 3; i += 1) {
          await d.fetch(LIVE_COMPARE_PAID_URL[run.provider], {
            method: "POST",
            body: JSON.stringify({ model: run.generateModel, n: i }),
          });
        }
        return "SENT";
      }, "PAID_CALL_CAP", 2],
    ] as const
  ) {
    const { fetch, calls } = recordingFetch((call) =>
      isPaid(call) ? jsonResponse(200, { model: (call.body as { model: string }).model }) : modelCheck(call)
    );
    const result = await runLiveCompare([A("1009"), B("1009")], {
      fetch,
      readEnv,
      maxPaidCalls: 2,
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
  const result = await runLiveCompare(PLAN, { fetch, readEnv, maxPaidCalls: 12, runOne });
  assert.deepEqual(result.paidCalls, 12);
  assert.deepEqual(calls.length, 15);
  assert(calls.every((c) => c.url.startsWith("https://api.anthropic.com/") || c.url.startsWith("https://api.openai.com/")));
  // No key in the ledger.
  assert(!JSON.stringify(result).includes(FAKE_ANTHROPIC_KEY));
  assert(!JSON.stringify(result).includes(FAKE_OPENAI_KEY));
});
