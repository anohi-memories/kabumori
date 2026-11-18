// Task56: a local, non-network test rig that connects the Task54/55 stop and budget gates (runLiveCompare) to the
// real AI Lab stages and the real grounding / voice checks, on the 10/09 and 10/10 topics.
//
// What is real: runLiveCompare (plan, price, budget, free model checks, the shared gate), createAiLabTextStages
// (adapters, SDK, transport policy), prepareAiLabVoiceRewrite (source grounding + style checks).
// What is NOT real: every model answer. They are explicit fixtures chosen by the test, so a pass here says the
// plumbing and the checks behave, never that a model wrote anything, never that the voice is the user's, and
// never that the topic is interesting. The budget and price check below are fixture values, not a user approval.
//
// The rig has no publish step: nothing here can build an X payload. A hold (grounding, voice) is returned as a
// result code; a gate stop ends the trial as in the real runner. No key is read (fake placeholders only), the
// only fetch is the in-process mock, and any URL outside the two model-check bases / paid endpoints is refused.

import { createAiLabTextStages } from "./ai_lab_post.ts";
import {
  LIVE_COMPARE_PAID_URL,
  type LiveCompareResult,
  type LiveCompareRun,
  type LiveCompareStage,
  runLiveCompare,
} from "./ai_lab_live_compare.ts";
import type {
  LiveCompareBudget,
  LiveComparePriceCheck,
} from "./ai_lab_live_compare_budget.ts";
import { AI_PROVIDER_CATALOG_VERSION, findModelSpec } from "./model_catalog.ts";
import type { FetchLike } from "./adapter.ts";
import {
  anthropicBody,
  FAKE_ANTHROPIC_KEY,
  FAKE_OPENAI_KEY,
  jsonResponse,
  openAiBody,
} from "./test_support.ts";
import { prepareAiLabVoiceRewrite } from "../brand/ai_lab_voice_rewrite.ts";
import { SOURCE_1009, SOURCE_1010 } from "../brand/ai_lab_live_compare_fixtures.ts";

export type RigTopic = "1009" | "1010";
export const RIG_SOURCES: Readonly<Record<RigTopic, string>> = {
  "1009": SOURCE_1009,
  "1010": SOURCE_1010,
};

/** Shown with every rig result: what a pass does and does not mean. */
export const LOCAL_RIG_DISCLAIMER =
  "fixture_replies_only: no model wrote these texts; own-voice quality and topic interest are NOT evaluated; no API call was made";

/** Not a user approval: a fixture reference the rig injects so the real approval gate can be exercised. */
export const LOCAL_RIG_BUDGET: LiveCompareBudget = Object.freeze({
  approvalRef: "fixture-only:local-rig-not-a-user-approval",
  ceilingUsd: 100,
  maxPaidCalls: 12,
  maxInputTokensPerCall: 30_000,
  maxOutputTokensPerCall: 3072,
});

export function localRigPriceCheck(nowMs: number): LiveComparePriceCheck {
  const prices: Record<string, { inputPer1M: number; outputPer1M: number }> = {};
  for (const model of ["claude-opus-5-5", "gpt-6.1-sol", "gpt-6-luna"]) {
    const base = findModelSpec(model)!.priceTiers[0];
    prices[model] = { inputPer1M: base.inputPer1M, outputPer1M: base.outputPer1M };
  }
  return { checkedAtMs: nowMs - 60_000, catalogVersion: AI_PROVIDER_CATALOG_VERSION, prices };
}

const TWO_STAGE = { AI_LAB_CLAUDE_TWO_STAGE: "enabled" };
/** A = Opus→Opus (Anthropic), B = Sol→Sol, C = Luna→Sol (OpenAI), each on both topics. */
export function localRigPlan(): LiveCompareRun[] {
  const runs: LiveCompareRun[] = [];
  for (const topic of ["1009", "1010"] as const) {
    runs.push({
      label: `A-${topic}`,
      provider: "anthropic",
      generateModel: "claude-opus-5-5",
      rewriteModel: "claude-opus-5-5",
      env: { ...TWO_STAGE },
    });
  }
  for (const topic of ["1009", "1010"] as const) {
    runs.push({
      label: `B-${topic}`,
      provider: "openai",
      generateModel: "gpt-6.1-sol",
      rewriteModel: "gpt-6.1-sol",
      env: { ...TWO_STAGE, AI_LAB_TEXT_PROVIDER: "openai" },
    });
  }
  for (const topic of ["1009", "1010"] as const) {
    runs.push({
      label: `C-${topic}`,
      provider: "openai",
      generateModel: "gpt-6-luna",
      rewriteModel: "gpt-6.1-sol",
      env: { ...TWO_STAGE, AI_LAB_TEXT_PROVIDER: "openai", AI_LAB_TEXT_MODE: "luna_sol" },
    });
  }
  return runs;
}

export type RigReply = {
  /** Fixture draft (stage 1 text). */
  draft: string;
  /** Fixture editor reply (stage 2), in the wire shape validate() takes. */
  rewrite: unknown;
};

/** Per run label ("A-1009"); a run without a fixture reply is a rig error, not a pass. */
export type RigReplies = Readonly<Record<string, RigReply>>;

const topicOf = (label: string): RigTopic => label.endsWith("1010") ? "1010" : "1009";

/**
 * runOne for runLiveCompare: draft stage → grounding check of the draft → editor stage → validate (style +
 * grounding of the final text). Returns a result code, never post text. A content hold is that run's outcome
 * (`HOLD:<code>`); a gate stop propagates and ends the trial.
 */
export function createLocalRigRunOne(rig: { setRun: (label: string) => void }) {
  return async (
    run: LiveCompareRun,
    deps: {
      fetchFor: (stage: LiveCompareStage) => FetchLike;
      readEnv: (name: string) => string | undefined;
    },
  ): Promise<string> => {
    const source = RIG_SOURCES[topicOf(run.label)];
    rig.setRun(run.label);
    // Task57: each stage gets the fetch bound to its own operation ("<run>/draft", "<run>/rewrite").
    const drafting = createAiLabTextStages({ readEnv: deps.readEnv, fetch: deps.fetchFor("draft") });
    const editing = createAiLabTextStages({ readEnv: deps.readEnv, fetch: deps.fetchFor("rewrite") });
    if (!drafting.textProvider || !editing.rewriteVoice) return "RIG_STAGES_UNAVAILABLE";
    try {
      const draft = await drafting.textProvider({
        brandId: "ai_salaryman_lab",
        postType: "brand_post",
        instructions: "fixture",
        input: `今日のテーマ: ${source}`,
        maxOutputTokens: 1500,
      });
      const { request, validate } = prepareAiLabVoiceRewrite({
        brandId: "ai_salaryman_lab",
        postType: "brand_post",
        text: draft.text.trim(),
      }, source);
      const { decision } = validate(await editing.rewriteVoice(request));
      // Reaching here means the real pipeline would hand the text to X; the rig has no X step.
      return `READY_FOR_X_DISPATCH:${decision}`;
    } catch (error) {
      const message = error instanceof Error ? error.message : "UNKNOWN";
      if (message.startsWith("AI_LAB_LIVE_COMPARE_STOPPED")) throw error;
      return `HOLD:${message.slice(0, 80)}`;
    }
  };
}

export type RigFaults = {
  /** Replaces the answer to a free model check (e.g. 401). */
  modelCheck?: (model: string) => Response | undefined;
  /** Replaces the answer to a paid call; `index` counts paid calls from 0. */
  paid?: (model: string, stage: "draft" | "rewrite", index: number) => Response | Error | undefined;
};

/** `body` is kept for paid sends only (test inspection; never part of a runner result). */
export type RigRecord = { method: string; url: string; run?: string; body?: string };

/** The in-process mock: records every request, refuses any other URL, never touches the network. */
export function createLocalRigFetch(replies: RigReplies, faults: RigFaults = {}) {
  const records: RigRecord[] = [];
  let paidIndex = 0;
  let currentRun = "";
  const fetchMock: FetchLike = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    records.push({ method, url });
    const path = url.split("?")[0];
    const isPaid = path === LIVE_COMPARE_PAID_URL.anthropic || path === LIVE_COMPARE_PAID_URL.openai;
    if (method === "GET" && url.includes("/v1/models/")) {
      const model = decodeURIComponent(url.split("/v1/models/")[1]);
      return faults.modelCheck?.(model) ?? jsonResponse(200, { id: model });
    }
    if (!isPaid || method !== "POST") throw new Error("RIG_NET_REFUSED");
    const raw = typeof init?.body === "string" ? init.body : await (input as Request).clone().text();
    Object.assign(records.at(-1)!, { run: currentRun, body: raw });
    const body = JSON.parse(raw) as { model: string };
    const stage = raw.includes('"decision"') ? "rewrite" : "draft";
    const index = paidIndex++;
    const fault = faults.paid?.(body.model, stage, index);
    if (fault instanceof Error) throw fault;
    if (fault) return fault;
    const reply = Object.hasOwn(replies, currentRun) ? replies[currentRun] : undefined;
    if (!reply) throw new Error("RIG_NO_FIXTURE_REPLY");
    const payload = stage === "draft" ? { text: reply.draft } : reply.rewrite;
    return path === LIVE_COMPARE_PAID_URL.anthropic
      ? jsonResponse(200, anthropicBody(payload, { model: body.model }))
      : jsonResponse(200, openAiBody(payload, { model: `${body.model}-2026-09-01` }));
  };
  return {
    fetch: fetchMock,
    records,
    paidCalls: () => paidIndex,
    setRun: (label: string) => {
      currentRun = label;
    },
  };
}

export function runLocalRigTrial(
  replies: RigReplies,
  options: {
    nowMs?: number;
    budget?: LiveCompareBudget;
    priceCheck?: LiveComparePriceCheck | null;
    plan?: LiveCompareRun[];
    faults?: RigFaults;
  } = {},
): Promise<LiveCompareResult & { rig: ReturnType<typeof createLocalRigFetch>; disclaimer: string }> {
  const nowMs = options.nowMs ?? Date.parse("2026-11-18T03:00:00Z");
  const plan = options.plan ?? localRigPlan();
  const rig = createLocalRigFetch(replies, options.faults);
  const keys: Record<string, string> = {
    AI_LAB_TEXT_API_KEY: FAKE_ANTHROPIC_KEY,
    AI_LAB_OPENAI_TEXT_API_KEY: FAKE_OPENAI_KEY,
  };
  return runLiveCompare(plan, {
    fetch: rig.fetch,
    readEnv: (name) => keys[name],
    budget: options.budget ?? LOCAL_RIG_BUDGET,
    priceCheck: options.priceCheck === null ? undefined : options.priceCheck ?? localRigPriceCheck(nowMs),
    now: () => nowMs,
    runOne: createLocalRigRunOne(rig),
  }).then((result) => ({ ...result, rig, disclaimer: LOCAL_RIG_DISCLAIMER }));
}
