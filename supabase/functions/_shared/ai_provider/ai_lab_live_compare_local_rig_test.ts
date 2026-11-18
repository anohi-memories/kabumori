// Task56: the local rig runs the 10/09 and 10/10 topics × A/B/C through the real stop/budget gates, the real AI Lab
// stages and the real grounding/voice checks. Every model answer is an explicit fixture; no request leaves the process.
// A pass here is NOT "own-voice PASS", NOT "real API success" and says nothing about how interesting a topic is.
import assert from "node:assert/strict";
import test from "node:test";
import {
  LOCAL_RIG_BUDGET,
  LOCAL_RIG_DISCLAIMER,
  localRigPlan,
  localRigPriceCheck,
  type RigReplies,
  type RigReply,
  runLocalRigTrial,
} from "./ai_lab_live_compare_rig_test.ts";
import {
  DRAFT_1009,
  DRAFT_1010,
  REWRITE_1009,
} from "../brand/ai_lab_live_compare_fixtures.ts";
import { LIVE_COMPARE_CAP_KIND } from "./ai_lab_live_compare_budget.ts";
import { FAKE_ANTHROPIC_KEY, FAKE_OPENAI_KEY, jsonResponse, openAiBody } from "./test_support.ts";

const rewritten = (text: string) => ({ decision: "rewritten", text, edits: [] });

// Allowed retelling of 10/09 (the Task53 free rewrite; the design clause is grounded in 「決めたこと」).
const PASS_1009: RigReply = { draft: DRAFT_1009, rewrite: rewritten(REWRITE_1009) };
// 10/10: a draft that grounds, then an editor that changes nothing → the voice check asks for review.
const UNCHANGED_1010: RigReply = { draft: DRAFT_1010, rewrite: { decision: "keep", text: DRAFT_1010, edits: [] } };
// 10/10: a free rewrite of the draft that the real fact check refuses.
const EDITED_1010: RigReply = {
  draft: DRAFT_1010,
  rewrite: rewritten(DRAFT_1010.replace("詰まったのは", "一番詰まったのは")),
};

// The gate refuses a request body it already sent. Two runs that share a stage model and a fixture draft (B and C
// both edit with Sol) would collide, so each method gets its own whitespace variant of the same fixture draft.
const VARIANT: Record<string, (text: string) => string> = {
  A: (t) => t,
  B: (t) => t.replace("。", "。\n"),
  C: (t) => t.replace("\n\n#", "\n\n\n#"),
};
const forMethod = (method: string, reply: RigReply): RigReply => {
  const draft = VARIANT[method](reply.draft);
  const rewrite = reply.rewrite as { decision: string; text: string; edits: unknown[] };
  // "keep" must return the very draft; a free rewrite carries its own text.
  return rewrite.decision === "keep" ? { draft, rewrite: { ...rewrite, text: draft } } : { draft, rewrite };
};

const all = (r1009: RigReply, r1010: RigReply): RigReplies => {
  const replies: Record<string, RigReply> = {};
  for (const method of ["A", "B", "C"]) {
    replies[`${method}-1009`] = forMethod(method, r1009);
    replies[`${method}-1010`] = forMethod(method, r1010);
  }
  return replies;
};

const paidCount = (records: { method: string }[]) => records.filter((r) => r.method === "POST").length;

test("task56 expected results: 10/09 passes the real checks, 10/10 fixtures hold with their own codes, X payload 0", async () => {
  const result = await runLocalRigTrial(all(PASS_1009, UNCHANGED_1010));
  assert.equal(result.status, "completed");
  assert.equal(result.stop, null);
  assert.deepEqual(
    result.runs.map((r) => [r.label, r.outcome]),
    [
      ["A-1009", "READY_FOR_X_DISPATCH:edited"],
      ["A-1010", "HOLD:AI_LAB_VOICE_REWRITE_REVIEW_REQUIRED"],
      ["B-1009", "READY_FOR_X_DISPATCH:edited"],
      ["B-1010", "HOLD:AI_LAB_VOICE_REWRITE_REVIEW_REQUIRED"],
      ["C-1009", "READY_FOR_X_DISPATCH:edited"],
      ["C-1010", "HOLD:AI_LAB_VOICE_REWRITE_REVIEW_REQUIRED"],
    ],
  );
  // 6 runs × 2 stages; one free check per planned model (3), no retry.
  assert.equal(result.paidCalls, 12);
  assert.equal(paidCount(result.rig.records), 12);
  assert.equal(result.rig.records.filter((r) => r.method === "GET").length, 3);
  assert.match(result.disclaimer, /no model wrote these texts/);
  assert.equal(result.disclaimer, LOCAL_RIG_DISCLAIMER);
  // The budget is a fixture, never a user approval, and the cap kind stays "not a hard cap".
  assert.match(LOCAL_RIG_BUDGET.approvalRef, /^fixture-only:/);
  assert.equal(result.budget.capKind, LIVE_COMPARE_CAP_KIND);
  assert.ok(result.budget.reservedUsd > 0 && result.budget.reservedUsd <= LOCAL_RIG_BUDGET.ceilingUsd);
  // Nothing the runner returns holds a key or any fixture text.
  const dump = JSON.stringify({ ...result, rig: undefined });
  for (const secret of [FAKE_ANTHROPIC_KEY, FAKE_OPENAI_KEY, DRAFT_1009, DRAFT_1010]) {
    assert.equal(dump.includes(secret), false);
  }
});

test("task56 expected: a free rewrite of 10/10 that touches wording is refused by the fact check", async () => {
  const result = await runLocalRigTrial(all(PASS_1009, EDITED_1010));
  assert.deepEqual(
    result.runs.filter((r) => r.label.endsWith("1010")).map((r) => r.outcome),
    Array(3).fill("HOLD:AI_LAB_VOICE_REWRITE_REJECTED"),
  );
});

test("task56 hold: a draft that claims an unbuilt/finished thing or invents facts stops before the editor call", async () => {
  for (
    const [label, draft] of [
      ["done claim", "昨日は株アプリの削除を実装して本番に出した。\n\n#個人開発"],
      ["fiction", "昨日はアカウント切替で1000人のユーザーから苦情が来て徹夜で直した。\n\n#個人開発"],
    ]
  ) {
    const replies = all({ draft, rewrite: rewritten(draft) }, { draft, rewrite: rewritten(draft) });
    const result = await runLocalRigTrial(replies, { plan: localRigPlan().filter((r) => r.label === "A-1009") });
    assert.equal(result.status, "completed", label);
    assert.deepEqual(result.runs.map((r) => r.outcome), ["HOLD:AI_LAB_SOURCE_GROUNDING_REJECTED"], label);
    // Draft was paid for, the editor was never called, nothing is re-sent.
    assert.equal(paidCount(result.rig.records), 1, label);
  }
});

test("task56 hold: an editor that adds a finished state to 10/09 is not READY", async () => {
  const added = REWRITE_1009.replace("#個人開発", "もう本番に反映して全ユーザーで動いてる。\n\n#個人開発");
  const result = await runLocalRigTrial(all({ draft: DRAFT_1009, rewrite: rewritten(added) }, UNCHANGED_1010));
  for (const r of result.runs.filter((r) => r.label.endsWith("1009"))) {
    assert.equal(r.outcome.startsWith("HOLD:"), true, r.label);
    assert.equal(r.outcome.includes("READY"), false, r.label);
  }
});

test("task56 gate: OpenAI 401 on the free check → paid 0 on every provider, whole trial stops", async () => {
  const result = await runLocalRigTrial(all(PASS_1009, UNCHANGED_1010), {
    faults: { modelCheck: (m) => m.startsWith("gpt") ? jsonResponse(401, { error: {} }) : undefined },
  });
  assert.deepEqual([result.stop, result.stoppedAt, result.paidCalls], ["PREFLIGHT_AUTH_FAILED", "preflight", 0]);
  assert.equal(paidCount(result.rig.records), 0);
});

test("task56 gate: paid 401 / unexpected status / network error / substituted model / missing usage stop at once, no resend, no other provider", async () => {
  const cases: [string, (m: string, s: string, i: number) => Response | Error | undefined, string][] = [
    ["401", (_m, _s, i) => i === 0 ? jsonResponse(401, {}) : undefined, "PAID_AUTH_FAILED"],
    ["500", (_m, _s, i) => i === 0 ? jsonResponse(500, {}) : undefined, "PAID_UNEXPECTED_RESPONSE"],
    ["network", (_m, _s, i) => i === 0 ? new TypeError("net") : undefined, "PAID_UNKNOWN_OUTCOME"],
    [
      "usage missing",
      (_m, _s, i) => i === 0 ? jsonResponse(200, { model: "claude-opus-5-5", content: [] }) : undefined,
      "PAID_USAGE_MISSING",
    ],
  ];
  for (const [name, paid, expected] of cases) {
    const result = await runLocalRigTrial(all(PASS_1009, UNCHANGED_1010), { faults: { paid } });
    assert.equal(result.stop, expected, name);
    assert.equal(result.stoppedAt, "A-1009", name);
    assert.equal(paidCount(result.rig.records), 1, name);
    assert.equal(result.rig.records.some((r) => r.url.includes("api.openai.com") && r.method === "POST"), false, name);
  }
  // A dated snapshot of the requested alias is fine; another model is a substitution.
  const other = await runLocalRigTrial(all(PASS_1009, UNCHANGED_1010), {
    plan: localRigPlan().filter((r) => r.label === "B-1009"),
    faults: {
      paid: (_m, _s, i) => i === 0 ? jsonResponse(200, openAiBody({ text: "x" }, { model: "gpt-6-luna-2026-09-01" })) : undefined,
    },
  });
  assert.equal(other.stop, "PAID_MODEL_SUBSTITUTED");
  assert.equal(paidCount(other.rig.records), 1);
});

test("task56 gate: no budget approval, no fresh price check, a wrong plan or a missing fixture reply → 0 paid calls or an immediate stop", async () => {
  const noBudget = await runLocalRigTrial(all(PASS_1009, UNCHANGED_1010), {
    budget: { ...LOCAL_RIG_BUDGET, approvalRef: "" },
  });
  assert.deepEqual([noBudget.stop, noBudget.rig.records.length], ["BUDGET_NOT_APPROVED", 0]);

  const noPrice = await runLocalRigTrial(all(PASS_1009, UNCHANGED_1010), { priceCheck: null });
  assert.deepEqual([noPrice.stop, noPrice.rig.records.length], ["PRICE_UNCONFIRMED", 0]);

  const stale = localRigPriceCheck(Date.parse("2026-11-18T03:00:00Z") - 3 * 86_400_000);
  const old = await runLocalRigTrial(all(PASS_1009, UNCHANGED_1010), { priceCheck: stale });
  assert.deepEqual([old.stop, old.rig.records.length], ["PRICE_CHECK_STALE", 0]);

  const wrongC = localRigPlan().map((r) =>
    r.label === "C-1009" ? { ...r, env: { ...r.env, AI_LAB_TEXT_MODE: "" } } : r
  );
  const mismatch = await runLocalRigTrial(all(PASS_1009, UNCHANGED_1010), { plan: wrongC });
  assert.deepEqual([mismatch.stop, mismatch.rig.records.length], ["PLAN_MODEL_MISMATCH", 0]);

  const tooFew = await runLocalRigTrial(all(PASS_1009, UNCHANGED_1010), {
    budget: { ...LOCAL_RIG_BUDGET, maxPaidCalls: 11 },
  });
  assert.deepEqual([tooFew.stop, tooFew.rig.records.length], ["PLAN_EXCEEDS_CALL_CAP", 0]);

  const noReply = await runLocalRigTrial({ "A-1009": PASS_1009 });
  assert.equal(noReply.status, "stopped");
  assert.equal(noReply.stoppedAt, "A-1010");
  assert.equal(paidCount(noReply.rig.records), 3);
});

test("task56 net: the mock refuses every URL other than the model checks and paid endpoints", async () => {
  const { createLocalRigFetch } = await import("./ai_lab_live_compare_rig_test.ts");
  const rig = createLocalRigFetch({});
  await assert.rejects(rig.fetch("https://example.com/x", { method: "GET" }), /RIG_NET_REFUSED/);
  await assert.rejects(rig.fetch("https://api.openai.com/v1/chat/completions", { method: "POST", body: "{}" }), /RIG_NET_REFUSED/);
});
