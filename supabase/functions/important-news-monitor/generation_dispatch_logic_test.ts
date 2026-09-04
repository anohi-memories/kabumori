import assert from "node:assert/strict";
import test from "node:test";
import { dispatchGeneration, type GenerationDispatchRepository } from "./generation_dispatch_logic.ts";
import type { GenerationCandidate, GenerationRunner, PostGenerationResult } from "./post_generation_logic.ts";

const candidate = (overrides: Partial<GenerationCandidate> = {}): GenerationCandidate => ({
  id: "candidate-1",
  sourceType: "tdnet",
  sourceUrl: "https://www.release.tdnet.info/inbs/example.pdf",
  sourceName: "tdnet",
  title: "通期業績予想の上方修正について",
  bodySummary: "営業利益予想を上方修正",
  companyName: "テスト株式会社",
  companyCode: "1234",
  entityKey: "company:1234",
  category: "earnings_revision_up",
  publishedAt: "2026-08-31T06:00:00.000Z",
  importance: "important",
  affectedEntities: ["テスト株式会社"],
  japanMarketRelevance: "medium",
  judgementReason: "業績予想の修正で株価材料になりうるため",
  judgementFactStatus: "passed",
  status: "ready_for_generation",
  ...overrides,
});

function passingRunner(): GenerationRunner {
  return async (step) => ({
    payload: step === "draft"
      ? { text: "テスト株式会社が通期業績予想を上方修正しました。", sufficient_information: true, notes: [] }
      : { passed: true, issues: [] },
    model: "gpt-5.6-luna",
    inputTokens: 100,
    outputTokens: 50,
    estimatedCost: 0.00008,
  });
}

// Simulates the DB-backed repository: a single shared row store, where claim() is an atomic
// conditional transition (ready_for_generation -> generating) — exactly like claimCandidateForGeneration's
// real PostgREST PATCH ... WHERE status=eq.ready_for_generation, which either matches exactly one row or
// none. This is what actually prevents two concurrent dispatchGeneration calls from both generating.
function memoryRepository(initial: GenerationCandidate & { status: string }) {
  const state = { ...initial };
  const saveCalls: unknown[] = [];
  const errorCalls: string[] = [];
  const repository: GenerationDispatchRepository = {
    async claim(candidateId) {
      if (candidateId !== state.id || state.status !== "ready_for_generation") return null;
      state.status = "generating";
      // The claimed candidate is handed to generateImportantNewsPost with status normalized back to
      // "ready_for_generation" — that's the semantic "you are eligible to generate this" state
      // generationEligibility() checks for; "generating" is only the DB's transient lock value, not a
      // state the generation pipeline itself needs to know about. Mirrors the real claim() in index.ts.
      return { ...state, status: "ready_for_generation" };
    },
    async save(candidateId, result) {
      assert.equal(candidateId, state.id);
      assert.equal(state.status, "generating");
      saveCalls.push(result);
      state.status = result.status;
    },
    async saveError(candidateId, code) {
      assert.equal(candidateId, state.id);
      errorCalls.push(code);
      state.status = "generation_failed";
    },
  };
  return { repository, state, saveCalls, errorCalls };
}

test("9: an important candidate is generated immediately (single dispatchGeneration call reaches ready_for_publish)", async () => {
  const { repository, state } = memoryRepository(candidate({ importance: "important", status: "ready_for_generation" }));
  const outcome = await dispatchGeneration("candidate-1", repository, passingRunner());
  assert.equal(outcome.claimed, true);
  assert.ok("result" in outcome);
  assert.equal(outcome.result?.status, "ready_for_publish");
  assert.equal(state.status, "ready_for_publish");
});

test("10: a most_important candidate is generated immediately the same way", async () => {
  const { repository, state } = memoryRepository(candidate({ importance: "most_important", status: "ready_for_generation" }));
  const outcome = await dispatchGeneration("candidate-1", repository, passingRunner());
  assert.equal(outcome.claimed, true);
  assert.ok("result" in outcome);
  assert.equal(outcome.result?.status, "ready_for_publish");
  assert.equal(state.status, "ready_for_publish");
});

test("11: a candidate not in ready_for_generation (e.g. still pending_judgement, or rejected as no_post) is never claimed or generated", async () => {
  const { repository, state, saveCalls } = memoryRepository(
    candidate({ importance: "no_post" as never, status: "rejected" }),
  );
  const outcome = await dispatchGeneration("candidate-1", repository, passingRunner());
  assert.equal(outcome.claimed, false);
  assert.equal(saveCalls.length, 0);
  assert.equal(state.status, "rejected");
});

test("12: an immediate dispatch and a concurrent cron dispatch for the same candidate never both generate — only one claims", async () => {
  const { repository, state } = memoryRepository(candidate({ status: "ready_for_generation" }));
  let generationCalls = 0;
  const countingRunner: GenerationRunner = async (...args) => {
    if (args[0] === "draft") generationCalls += 1;
    return passingRunner()(...args);
  };
  const [first, second] = await Promise.all([
    dispatchGeneration("candidate-1", repository, countingRunner),
    dispatchGeneration("candidate-1", repository, countingRunner),
  ]);
  const claimedCount = [first.claimed, second.claimed].filter(Boolean).length;
  assert.equal(claimedCount, 1);
  assert.equal(generationCalls, 1);
  assert.equal(state.status, "ready_for_publish");
});

test("13: a failure inside dispatchGeneration (the generation call itself throwing) is caught, saved via saveError, and never leaves the candidate stuck in 'generating' for a later cron pass", async () => {
  const { repository, state, errorCalls } = memoryRepository(candidate({ status: "ready_for_generation" }));
  const throwingRunner: GenerationRunner = async () => {
    throw new Error("NEWS_GENERATION_OPENAI_FAILED:500");
  };
  const outcome = await dispatchGeneration("candidate-1", repository, throwingRunner);
  assert.equal(outcome.claimed, true);
  assert.ok("error" in outcome);
  assert.equal(outcome.error, "NEWS_GENERATION_OPENAI_FAILED:500");
  assert.deepEqual(errorCalls, ["NEWS_GENERATION_OPENAI_FAILED:500"]);
  // the row is no longer "generating" — a later generate_ready cron pass would not (and should not) pick
  // it back up, since generation_failed is the existing terminal-failure state used everywhere else too.
  assert.equal(state.status, "generation_failed");
});

test("13b: after a claim failure (candidate already claimed elsewhere), a later dispatchGeneration call on the now-generating row also safely returns claimed:false rather than erroring", async () => {
  const { repository } = memoryRepository(candidate({ status: "generating" as never }));
  const outcome = await dispatchGeneration("candidate-1", repository, passingRunner());
  assert.equal(outcome.claimed, false);
});

test("even if repository.saveError itself throws, dispatchGeneration still returns a claimed error result instead of throwing", async () => {
  const { repository } = memoryRepository(candidate({ status: "ready_for_generation" }));
  const brokenRepository: GenerationDispatchRepository = {
    ...repository,
    saveError: async () => { throw new Error("DB_UNAVAILABLE"); },
  };
  const throwingRunner: GenerationRunner = async () => { throw new Error("NEWS_GENERATION_OPENAI_FAILED:500"); };
  const outcome = await dispatchGeneration("candidate-1", brokenRepository, throwingRunner);
  assert.equal(outcome.claimed, true);
  assert.ok("error" in outcome);
});
