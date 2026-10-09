import type { ImportantNewsCategory } from "../../../supabase/functions/important-news-monitor/news_candidate_logic.ts";

export type Importance = "no_post" | "important" | "most_important";

export type RecordedJudgement = {
  importance: Importance;
  category: ImportantNewsCategory;
  affectedEntities: string[];
  japanMarketRelevance: "none" | "low" | "medium" | "high";
  reason: string;
  confidence: number;
  needsSol: boolean;
  factCheckStatus: "passed" | "needs_review";
  /** The model that made the stored decision (gpt-6-luna, or gpt-6-sol after escalation). */
  model: string;
  escalatedToSol: boolean;
};

export type RecordedGeneration = {
  text: string | null;
  model: string | null;
  factStatus: string | null;
  voiceStatus: string | null;
  error: string | null;
  factIssues: string[];
  voiceIssues: string[];
};

export type OutcomeKind = "success" | "miss" | "generation_failure" | "negative_control";

export type CaseGroup =
  | "boj"
  | "fx"
  | "geopolitics"
  | "north_korea"
  | "domestic_incident"
  | "disaster"
  | "fsa_action"
  | "tdnet_earnings"
  | "tdnet_capital"
  | "tdnet_governance"
  | "negative_control";

export type CaseFixture = {
  caseId: string;
  group: CaseGroup;
  outcomeKind: OutcomeKind;
  /** Why the case is in the set, in Japanese (shown in reports). */
  note: string;
  candidate: {
    sourceType: string;
    sourceUrl: string;
    sourceName: string;
    title: string;
    bodySummary: string | null;
    companyName: string | null;
    companyCode: string | null;
    entityKey: string | null;
    category: ImportantNewsCategory;
    publishedAt: string;
  };
  recorded: {
    judgement: RecordedJudgement;
    generation: RecordedGeneration | null;
  };
  /**
   * What the case should have been. "production_decision" is only what production decided (not ground truth);
   * "human_hint" marks the cases where production's decision is known to have been wrong or incomplete.
   */
  expected: { importance: Importance; source: "production_decision" | "human_hint" };
};

export type CasesFile = { version: 1; exportedAt: string; cases: CaseFixture[] };

export async function loadCases(url: URL = new URL("../fixtures/cases.json", import.meta.url)): Promise<CaseFixture[]> {
  const file = JSON.parse(await Deno.readTextFile(url)) as CasesFile;
  if (file.version !== 1 || !Array.isArray(file.cases)) throw new Error("CASES_FILE_INVALID");
  return file.cases;
}
