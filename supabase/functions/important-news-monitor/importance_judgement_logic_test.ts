import assert from "node:assert/strict";
import test from "node:test";
import {
  judgeCandidateWithEscalation,
  parseModelJudgement,
  statusForJudgement,
  type JudgementCandidate,
  type ModelJudgement,
} from "./importance_judgement_logic.ts";

const candidate: JudgementCandidate = {
  id: "candidate-1",
  sourceType: "tdnet",
  sourceUrl: "https://www.release.tdnet.info/inbs/example.pdf",
  sourceName: "tdnet",
  title: "通期業績予想の修正について",
  bodySummary: "営業利益予想を上方修正",
  companyName: "テスト株式会社",
  companyCode: "1234",
  entityKey: "company:1234",
  category: "earnings_revision_up",
  publishedAt: "2026-08-31T06:00:00.000Z",
};

function judgement(overrides: Partial<ModelJudgement> = {}): ModelJudgement {
  return {
    importance: "important",
    category: "earnings_revision_up",
    affectedEntities: ["テスト株式会社", "1234"],
    japanMarketRelevance: "medium",
    reason: "業績予想の修正で株価材料になりうるため",
    confidence: 0.9,
    needsSol: false,
    factCheckStatus: "passed",
    model: "gpt-5.6-luna",
    inputTokens: 100,
    outputTokens: 50,
    estimatedCost: 0.00008,
    ...overrides,
  };
}

test("no_post judgement transitions to rejected", async () => {
  const result = await judgeCandidateWithEscalation(candidate, { solEscalationEnabled: true }, async () =>
    judgement({ importance: "no_post", japanMarketRelevance: "low" })
  );
  assert.equal(result.final.importance, "no_post");
  assert.equal(result.status, "rejected");
  assert.equal(result.escalatedToSol, false);
});

test("important judgement transitions to ready_for_generation", async () => {
  const result = await judgeCandidateWithEscalation(candidate, { solEscalationEnabled: true }, async () => judgement());
  assert.equal(result.final.importance, "important");
  assert.equal(result.status, "ready_for_generation");
});

test("most_important candidate is reviewed by Sol", async () => {
  const models: string[] = [];
  const result = await judgeCandidateWithEscalation(candidate, { solEscalationEnabled: true }, async (_candidate, model) => {
    models.push(model);
    return judgement({ importance: "most_important", model });
  });
  assert.deepEqual(models, ["gpt-5.6-luna", "gpt-5.6-sol"]);
  assert.equal(result.final.importance, "most_important");
  assert.equal(result.escalatedToSol, true);
});

test("low Luna confidence escalates to Sol", async () => {
  let calls = 0;
  const result = await judgeCandidateWithEscalation(candidate, { solEscalationEnabled: true }, async (_candidate, model) => {
    calls += 1;
    return model === "gpt-5.6-luna"
      ? judgement({ confidence: 0.55 })
      : judgement({ model, confidence: 0.92 });
  });
  assert.equal(calls, 2);
  assert.ok(result.escalationReasons.includes("LOW_CONFIDENCE"));
  assert.equal(result.final.model, "gpt-5.6-sol");
});

test("high-confidence Luna result completes without Sol", async () => {
  let calls = 0;
  const result = await judgeCandidateWithEscalation(candidate, { solEscalationEnabled: true }, async () => {
    calls += 1;
    return judgement();
  });
  assert.equal(calls, 1);
  assert.equal(result.escalatedToSol, false);
  assert.equal(result.final.model, "gpt-5.6-luna");
});

test("insufficient facts are safely rejected after review", async () => {
  const result = await judgeCandidateWithEscalation(candidate, { solEscalationEnabled: true }, async (_candidate, model) =>
    judgement({
      importance: "important",
      factCheckStatus: "needs_review",
      needsSol: true,
      confidence: 0.4,
      model,
      reason: "規模を判断できる本文情報が不足",
    })
  );
  assert.equal(result.escalatedToSol, true);
  assert.equal(result.final.importance, "no_post");
  assert.equal(result.final.factCheckStatus, "needs_review");
  assert.equal(result.status, "rejected");
});

test("structured result validation and DB status mapping accept declared values", () => {
  const parsed = parseModelJudgement({
    importance: "important",
    category: "share_buyback",
    affected_entities: ["1234"],
    japan_market_relevance: "medium",
    reason: "自己株式取得が需給材料になりうるため",
    confidence: 0.88,
    needs_sol: false,
    fact_check_status: "passed",
  }, "gpt-5.6-luna");
  assert.equal(parsed.category, "share_buyback");
  assert.equal(statusForJudgement(parsed.importance), "ready_for_generation");
  assert.equal(statusForJudgement("no_post"), "rejected");
});
