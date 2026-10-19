// What the information-sufficiency gate did, and how much of it can be read back from storage.
//
// The gate lives in judgeCandidateWithEscalation() (importance_judgement_logic.ts). After the Luna call, and a Sol call when
// escalation is required and enabled, it forces the final importance to no_post if
//   (a) the final fact_check_status is not "passed", or
//   (b) escalation was required but Sol did not run (settings.solEscalationEnabled === false).
// It then appends a fixed sentence to the stored reason. Nothing else about the pre-gate state is written down.
//
// This module does three things: it classifies a stored row into the gate outcomes above, it says for each outcome which
// pre-gate facts are recoverable, and it defines the observation record (JudgementTrace) that would make the rest
// recoverable. It changes nothing in production; the safety gate itself is untouched.
import {
  type FinalJudgement,
  judgeCandidateWithEscalation,
  type ModelJudgement,
} from "../../../supabase/functions/important-news-monitor/importance_judgement_logic.ts";

export const GATE_SENTENCE = "（保存済み情報だけでは安全に確定できないため投稿対象外）";

export type StoredJudgement = {
  importance: "no_post" | "important" | "most_important";
  judgementModel: string;
  escalatedToSol: boolean;
  factCheckStatus: string | null;
  reason: string;
  /** Escalation reasons from the 'news_judgement_sol|…' usage row, or "" when no such row (or reasons) exist. */
  solEscalationReasons: string;
};

export type GateOutcome =
  | "final_positive"            // important or most_important: the gate did not turn it into no_post
  | "model_no_post"             // the model that produced the stored decision said no_post and its Fact status passed
  | "gate_after_sol"            // Sol ran, its Fact status was not passed, so no_post was forced
  | "gate_sol_required_not_run"; // escalation was required, Sol did not run, no_post was forced

export type Recoverability = {
  outcome: GateOutcome;
  gateApplied: boolean;
  solRan: boolean;
  /** Stored as "A+B" on the Sol usage row; null when the row or the reasons are missing (older rows). */
  escalationReasons: string[] | null;
  /** What can be said about the importance the model returned before the gate. */
  preGateImportance: "known_final" | "not_stored";
  /** What can be said about the Fact status before the gate. */
  preGateFactStatus: "passed" | "needs_review" | "not_stored";
  /** Luna's own output when Sol ran (Luna's reason, importance and confidence are overwritten by Sol's). */
  lunaOutput: "stored" | "not_stored";
};

export function classifyStoredJudgement(row: StoredJudgement): Recoverability {
  const gateApplied = row.reason.includes(GATE_SENTENCE);
  const reasons = row.solEscalationReasons.trim() === "" ? null : row.solEscalationReasons.split(/[+,]/).filter(Boolean);
  if (row.importance !== "no_post") {
    return {
      outcome: "final_positive", gateApplied: false, solRan: row.escalatedToSol, escalationReasons: reasons,
      preGateImportance: "known_final", preGateFactStatus: "passed", lunaOutput: row.escalatedToSol ? "not_stored" : "stored",
    };
  }
  if (!gateApplied) {
    return {
      outcome: "model_no_post", gateApplied: false, solRan: row.escalatedToSol, escalationReasons: reasons,
      preGateImportance: "known_final", preGateFactStatus: "passed", lunaOutput: row.escalatedToSol ? "not_stored" : "stored",
    };
  }
  if (row.escalatedToSol) {
    // The gate fired on the stored (Sol) output, whose fact_check_status was not passed. Its importance was overwritten.
    return {
      outcome: "gate_after_sol", gateApplied: true, solRan: true, escalationReasons: reasons,
      preGateImportance: "not_stored", preGateFactStatus: "needs_review", lunaOutput: "not_stored",
    };
  }
  // No Sol call: escalation was required and could not run. The stored output is Luna's with its importance overwritten;
  // its Fact status may have been passed (the gate fired because of the missing escalation).
  return {
    outcome: "gate_sol_required_not_run", gateApplied: true, solRan: false, escalationReasons: null,
    preGateImportance: "not_stored", preGateFactStatus: "not_stored", lunaOutput: "stored",
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Simulation with the production function itself, so the classification above is checked against real behaviour.

export type ModelOutput = Pick<ModelJudgement, "importance" | "factCheckStatus" | "confidence" | "needsSol">;

function model(name: "gpt-6-luna" | "gpt-6-sol", output: ModelOutput): ModelJudgement {
  return {
    importance: output.importance,
    category: "other_corporate_ir",
    affectedEntities: [],
    japanMarketRelevance: "medium",
    reason: `${name} reason`,
    confidence: output.confidence,
    needsSol: output.needsSol,
    factCheckStatus: output.factCheckStatus,
    model: name,
    inputTokens: 1,
    outputTokens: 1,
    estimatedCost: 0,
  };
}

const CANDIDATE = {
  sourceType: "tdnet", sourceUrl: "https://example.test/a", sourceName: "tdnet", title: "t", bodySummary: "b", companyName: null,
  companyCode: null, entityKey: null, category: "other_corporate_ir" as const, publishedAt: "2026-10-01T00:00:00Z",
};

export async function runProductionGate(
  luna: ModelOutput,
  sol: ModelOutput | null,
  settings: { solEscalationEnabled: boolean },
): Promise<{ result: FinalJudgement; stored: StoredJudgement }> {
  const result = await judgeCandidateWithEscalation(CANDIDATE, settings, (_item, which) => {
    if (which === "gpt-6-luna") return Promise.resolve(model("gpt-6-luna", luna));
    if (sol === null) throw new Error("SOL_OUTPUT_NOT_PROVIDED");
    return Promise.resolve(model("gpt-6-sol", sol));
  });
  return {
    result,
    stored: {
      importance: result.final.importance,
      judgementModel: result.final.model,
      escalatedToSol: result.escalatedToSol,
      factCheckStatus: result.final.factCheckStatus,
      reason: result.final.reason,
      solEscalationReasons: result.sol ? result.escalationReasons.join("+") : "",
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The observation record that would make the pre-gate state recoverable. Design only: nothing writes it today.

export type MissingInformation =
  | "body_empty"
  | "numbers_missing"
  | "current_period_missing"
  | "inconsistent_summary"
  | "scale_unknown"
  | "identity_unconfirmed"
  | "single_source"
  | "source_unclear";

export type JudgementTrace = {
  version: 1;
  luna: { importance: string; factCheckStatus: string; confidence: number; needsSol: boolean };
  escalation: {
    required: boolean;
    reasons: string[];
    solEnabled: boolean;
    ran: boolean;
    notRunBecause: "not_required" | "disabled" | null;
  };
  sol: { importance: string; factCheckStatus: string; confidence: number } | null;
  gate: {
    applied: boolean;
    trigger: "fact_not_passed" | "sol_required_not_run" | null;
    preGateImportance: string | null;
    preGateFactStatus: string | null;
  };
  final: { importance: string; factCheckStatus: string };
  /** Kinds of missing information the model reported; free text stays in judgement_reason. */
  missingInformation: MissingInformation[];
};

/** Builds the trace from the three outputs the pipeline already has in memory when it applies the gate. */
export function buildJudgementTrace(
  luna: ModelOutput,
  sol: ModelOutput | null,
  settings: { solEnabled: boolean },
  result: Pick<FinalJudgement, "escalationReasons" | "escalatedToSol" | "final">,
  gateApplied: boolean,
  missingInformation: MissingInformation[] = [],
): JudgementTrace {
  const required = result.escalationReasons.length > 0;
  const preGate = sol ?? luna;
  return {
    version: 1,
    luna: { importance: luna.importance, factCheckStatus: luna.factCheckStatus, confidence: luna.confidence, needsSol: luna.needsSol },
    escalation: {
      required,
      reasons: result.escalationReasons,
      solEnabled: settings.solEnabled,
      ran: result.escalatedToSol,
      notRunBecause: result.escalatedToSol ? null : required ? "disabled" : "not_required",
    },
    sol: sol ? { importance: sol.importance, factCheckStatus: sol.factCheckStatus, confidence: sol.confidence } : null,
    gate: {
      applied: gateApplied,
      trigger: !gateApplied ? null : preGate.factCheckStatus !== "passed" ? "fact_not_passed" : "sol_required_not_run",
      preGateImportance: gateApplied ? preGate.importance : null,
      preGateFactStatus: gateApplied ? preGate.factCheckStatus : null,
    },
    final: { importance: result.final.importance, factCheckStatus: result.final.factCheckStatus },
    missingInformation,
  };
}

const MATERIAL_WORDING = /(重要だが|重要であり|重要な(?:進展|決定|開示|事象)|影響は大きい|大幅(?:な)?(?:増|減|下方|上方)|増収増益|減収減益|下方修正|上方修正|最重要(?:と(?:は)?)?(?:判定|判断)(?:しない|できない|せず)|important)/;
const NOT_MATERIAL_WORDING = /(重要ニュースとは判定できない|重要性は確認できない|定型|定例|通常の決算開示|軽微|具体的な影響は入力から確認できない|日本株への具体的)/;

/**
 * Rough read of what a gate-suppressed reason says about materiality, because the model's pre-gate importance is not stored.
 * "material" = the wording treats the item as important but unverifiable. It is a text heuristic: it is used to size the
 * review queue the gate hides, never to relabel an item.
 */
export function reasonSignal(reason: string): "material" | "mixed" | "not_material" | "unclear" {
  const text = reason.replace(GATE_SENTENCE, "");
  const positive = MATERIAL_WORDING.test(text);
  const negative = NOT_MATERIAL_WORDING.test(text);
  if (positive && !negative) return "material";
  if (positive && negative) return "mixed";
  if (negative) return "not_material";
  return "unclear";
}

const MISSING_RULES: ReadonlyArray<readonly [MissingInformation, RegExp]> = [
  ["body_empty", /本文(?:要約)?が(?:ない|空|なく)|本文要約がなく|表題のみ|タイトルのみ|タイトル上は/],
  ["current_period_missing", /当期の行|表の欠落|数値配列に欠落|年度表記に不整合|年度表記|数値の欠落/],
  ["inconsistent_summary", /不整合|一致しない|矛盾/],
  ["numbers_missing", /(?:数値|修正(?:前後|後)|減額率|増額率|増減率|金額|売上高|営業利益)[^。]{0,16}(?:確認でき(?:な[いく]|ず)|欠落|が(?:ない|なく))/],
  ["scale_unknown", /規模[^。]{0,10}確認できない|規模を確認できず|影響(?:額|規模)[^。]{0,8}(?:確認できない|未確定|不明)|日本株への具体的/],
  ["identity_unconfirmed", /同一(?:企業|性)|企業名|会社名.{0,6}(?:一致|確認)/],
  ["single_source", /単一(?:の)?(?:ソース|記事|オピニオン)|単一ソース|一次情報で(?:は)?確認できない|未確認情報|当事者の主張/],
];

/** Text heuristic for the kinds of missing information a stored reason mentions (an approximation, not a model output). */
export function inferMissingInformation(reason: string): MissingInformation[] {
  const text = reason.replace(GATE_SENTENCE, "");
  return MISSING_RULES.filter(([, pattern]) => pattern.test(text)).map(([kind]) => kind);
}
