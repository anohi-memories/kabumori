import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  appCopyDraftRequestBody,
  appCopyFactRequestBody,
  type AppCopySource,
} from "./app_copy_logic.ts";
import {
  BREAKING_MARKET_QUERIES,
  MAX_BREAKING_MARKET_SEARCHES_PER_FETCH,
} from "./breaking_market_source_fetchers.ts";
import { generationModelInput, type GenerationCandidate } from "./post_generation_logic.ts";

const mixedCandidates = (bodyLengths: number[]): GenerationCandidate[] => bodyLengths.map((length, index) => ({
  id: `cost-fixture-${index}`,
  sourceType: index === 0 ? "tdnet" : index === 1 ? "market_macro" : "breaking_market",
  sourceUrl: `https://example.com/cost-fixture-${index}`,
  sourceName: index === 0 ? "tdnet" : index === 1 ? "official_macro" : "breaking_market",
  title: index === 0 ? "通期業績予想の修正" : index === 1 ? "米CPIの発表" : "地政学上の新たな動き",
  bodySummary: "確認済みの事実本文。".repeat(Math.ceil(length / 10)).slice(0, length),
  companyName: index === 2 ? null : "例示株式会社",
  companyCode: index === 2 ? null : "12340",
  entityKey: index === 2 ? "breaking:event:geopolitics:2026-09-16T00:00" : "company:1234",
  category: index === 0 ? "earnings_revision_up" : index === 1 ? "interest_rates" : "geopolitics",
  publishedAt: "2026-09-16T00:00:00Z",
  importance: "important",
  affectedEntities: index === 2 ? ["市場"] : ["例示株式会社"],
  japanMarketRelevance: "high",
  judgementReason: "保存済み情報から重要性を確認",
  judgementFactStatus: "passed",
  status: "ready_for_generation",
}));

test("active Important News runtime entrypoints do not select GPT-5.6 models", () => {
  const runtimeFiles = [
    "./importance_judgement_logic.ts",
    "./breaking_market_source_fetchers.ts",
    "./post_generation_logic.ts",
    "./index.ts",
  ];
  for (const path of runtimeFiles) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.doesNotMatch(source, /gpt-5\.6-(?:luna|sol)/, `${path} must not select a legacy model`);
  }
});

test("mixed important-news cost fixture measures stage and whole-path input reduction", () => {
  const candidates = mixedCandidates([900, 1400, 650]);
  let beforeX = 0;
  let afterX = 0;
  for (const candidate of candidates) {
    // Baseline models the pre-hardening behavior: the full candidate packet was sent to each stage.
    const baselinePacket = JSON.stringify(generationModelInput(candidate, "本文"));
    beforeX += baselinePacket.length * 3;
    afterX += JSON.stringify(generationModelInput(candidate, undefined, undefined, false, "draft")).length;
    afterX += JSON.stringify(generationModelInput(candidate, "本文", undefined, false, "fact")).length;
    afterX += JSON.stringify(generationModelInput(candidate, "本文", undefined, false, "voice")).length;
  }

  // One Luna judgement per candidate plus one representative Sol escalation; coverage/severity/
  // category are deterministic code paths and therefore add no model call here.
  const judgementInput = candidates.reduce(
    (total, candidate) => total + JSON.stringify({ candidate, luna_preliminary: null }).length,
    0,
  ) + JSON.stringify({ candidate: candidates[1], luna_preliminary: { confidence: 0.5 } }).length;

  const appSource: AppCopySource = {
    id: "app-copy-fixture",
    title: "English market headline",
    bodySummary: "Original source text ".repeat(60),
    sourceUrl: "https://example.com/app-copy-fixture",
    sourceType: "market_macro",
    publishedAt: "2026-09-16T00:00:00Z",
    category: "tariffs",
    affectedEntities: ["米国"],
  };
  const appCopy = { titleJa: "日本語見出し", summaryJa: "日本語要約", detailJa: "詳細", keyPointsJa: ["要点"] };
  const appCopyInput = JSON.stringify(appCopyDraftRequestBody(appSource)).length +
    JSON.stringify(appCopyFactRequestBody(appSource, appCopy)).length;
  const webSearchInput = BREAKING_MARKET_QUERIES
    .slice(0, MAX_BREAKING_MARKET_SEARCHES_PER_FETCH)
    .reduce((total, query) => total + (`search topic: ${query.searchQuery}\nreference UTC: 2026-09-16T00:00:00.000Z`).length, 0);

  const beforeWholePath = judgementInput + beforeX + appCopyInput + webSearchInput;
  const afterWholePath = judgementInput + afterX + appCopyInput + webSearchInput;
  const xReduction = (beforeX - afterX) / beforeX;
  const wholeReduction = (beforeWholePath - afterWholePath) / beforeWholePath;

  assert.equal(candidates.length, 3);
  assert.equal(MAX_BREAKING_MARKET_SEARCHES_PER_FETCH, 4);
  assert.ok(xReduction > 0.2, `X reduction should be material: ${xReduction}`);
  assert.ok(wholeReduction > 0, `whole path should not regress: ${wholeReduction}`);
  // This remains below the 30% whole-workload target because judgement, app-copy and web-search
  // inputs are unchanged; report the measured result instead of overstating it.
  assert.ok(wholeReduction < 0.3, `whole-path reduction must not be overstated: ${wholeReduction}`);
  assert.equal(beforeWholePath, 27641);
  assert.equal(afterWholePath, 23978);
});
