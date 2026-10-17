import type { LedgerSnapshot } from "./ledger_snapshot.ts";
import { costUsd } from "./pricing.ts";
import { thinkingOverhead, type ThinkingSetting } from "./estimate.ts";

// Monthly cost of three provider assignments for the important-news pipeline, from the 2026-10-09 ledger snapshot.
//   measured     OpenAI numbers are the ledger's own totals for the window (estimates of invoice, not the invoice).
//   assumed      Claude token counts = the ledger's averages x tokenizerFactor, plus an UNMEASURED thinking overhead.
// The first small live run (see README) replaces the assumed part with measured usage.

export type Assignment = {
  provider: "openai" | "anthropic";
  model: string;
  effort?: "low" | "medium" | "high";
  thinking?: ThinkingSetting;
};

export type Scenario = {
  id: "A" | "B" | "C";
  name: string;
  /** feature (ledger key) -> where it runs. Features not listed stay on OpenAI. */
  moved: Record<string, Assignment>;
};

const SONNET_SEARCH: Assignment = { provider: "anthropic", model: "claude-sonnet-5-5", effort: "low" };

export const SCENARIOS: readonly Scenario[] = [
  { id: "A", name: "全処理をOpenAIのまま維持", moved: {} },
  {
    id: "B",
    name: "一部だけClaudeへ（Sol相当の詳細判定とWeb検索）",
    moved: {
      judgement_sol: { provider: "anthropic", model: "claude-sonnet-5-5", effort: "medium" },
      breaking_search: SONNET_SEARCH,
    },
  },
  {
    id: "C",
    name: "多くをClaudeへ（軽量処理=Haiku、詳細判定=Opus、本文=Sonnet）",
    moved: {
      judgement_luna: { provider: "anthropic", model: "claude-haiku-5-5", effort: "low", thinking: "off" },
      trigger_triage_luna: { provider: "anthropic", model: "claude-haiku-5-5", effort: "low", thinking: "off" },
      judgement_sol: { provider: "anthropic", model: "claude-opus-5-5", effort: "medium" },
      generation_draft: { provider: "anthropic", model: "claude-sonnet-5-5", effort: "low" },
      generation_fact: { provider: "anthropic", model: "claude-haiku-5-5", effort: "low", thinking: "off" },
      generation_fact_retry: { provider: "anthropic", model: "claude-haiku-5-5", effort: "low", thinking: "off" },
      generation_voice: { provider: "anthropic", model: "claude-haiku-5-5", effort: "low", thinking: "off" },
      generation_voice_retry: { provider: "anthropic", model: "claude-haiku-5-5", effort: "low", thinking: "off" },
      app_copy_draft: { provider: "anthropic", model: "claude-haiku-5-5", effort: "low", thinking: "off" },
      app_copy_fact: { provider: "anthropic", model: "claude-haiku-5-5", effort: "low", thinking: "off" },
      breaking_search: SONNET_SEARCH,
    },
  },
];

export type StepCost = {
  feature: string;
  provider: "openai" | "anthropic";
  model: string;
  callsPerMonth: number;
  monthlyUsd: number;
  basis: "measured" | "assumed";
};

export type ScenarioResult = {
  scenarioId: Scenario["id"];
  name: string;
  tokenizerFactor: number;
  monthlyOpenAiUsd: number;
  monthlyClaudeUsd: number;
  monthlyTotalUsd: number;
  /** Monthly Claude API credit counted (0 unless the credit was verified and passed in). */
  creditUsd: number;
  claudeCoveredByCreditUsd: number;
  /** What actually comes out of pocket: all OpenAI plus the Claude spend the credit does not cover. */
  selfPayUsd: number;
  steps: StepCost[];
};

const DAYS_PER_MONTH = 30;

function claudeCallUsd(
  assignment: Assignment,
  avgInput: number,
  avgOutput: number,
  searchesPerCall: number,
  tokenizerFactor: number,
): number {
  const effort = assignment.effort ?? "low";
  const overhead = thinkingOverhead(assignment.model, effort, assignment.thinking ?? "default");
  return costUsd(assignment.model, {
    inputTokens: Math.ceil(avgInput * tokenizerFactor),
    outputTokens: Math.ceil((avgOutput + overhead) * tokenizerFactor),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    webSearchRequests: searchesPerCall,
  });
}

export function simulate(
  snapshot: LedgerSnapshot,
  scenario: Scenario,
  options: { tokenizerFactor?: number; creditUsd?: number } = {},
): ScenarioResult {
  const tokenizerFactor = options.tokenizerFactor ?? 1;
  const creditUsd = Math.max(0, options.creditUsd ?? 0);
  const steps: StepCost[] = [];
  for (const [feature, value] of Object.entries(snapshot.features)) {
    const callsPerMonth = (value.calls / snapshot.window.days) * DAYS_PER_MONTH;
    const moved = scenario.moved[feature];
    if (!moved) {
      steps.push({
        feature, provider: "openai", model: value.model, callsPerMonth,
        monthlyUsd: (value.totalUsd / snapshot.window.days) * DAYS_PER_MONTH, basis: "measured",
      });
      continue;
    }
    const searchesPerCall = value.calls > 0 ? value.searches / value.calls : 0;
    steps.push({
      feature, provider: moved.provider, model: moved.model, callsPerMonth,
      monthlyUsd: claudeCallUsd(moved, value.avgInputTokens, value.avgOutputTokens, searchesPerCall, tokenizerFactor) * callsPerMonth,
      basis: "assumed",
    });
  }
  const sum = (provider: "openai" | "anthropic") =>
    steps.filter((step) => step.provider === provider).reduce((total, step) => total + step.monthlyUsd, 0);
  const openai = sum("openai");
  const claude = sum("anthropic");
  const covered = Math.min(claude, creditUsd);
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    scenarioId: scenario.id,
    name: scenario.name,
    tokenizerFactor,
    monthlyOpenAiUsd: round(openai),
    monthlyClaudeUsd: round(claude),
    monthlyTotalUsd: round(openai + claude),
    creditUsd,
    claudeCoveredByCreditUsd: round(covered),
    selfPayUsd: round(openai + claude - covered),
    steps: steps.map((step) => ({ ...step, callsPerMonth: Math.round(step.callsPerMonth), monthlyUsd: round(step.monthlyUsd) })),
  };
}

export function simulateAll(
  snapshot: LedgerSnapshot,
  options: { tokenizerFactors?: readonly number[]; creditUsd?: number } = {},
): ScenarioResult[] {
  const factors = options.tokenizerFactors ?? [1, 1.3];
  return SCENARIOS.flatMap((scenario) =>
    factors.map((tokenizerFactor) => simulate(snapshot, scenario, { tokenizerFactor, creditUsd: options.creditUsd }))
  );
}

export function markdownTable(results: readonly ScenarioResult[]): string {
  const lines = [
    "| 案 | tokenizer係数 | OpenAI/月 | Claude/月 | 合計/月 | クレジット適用 | 自己負担/月 |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const r of results) {
    lines.push(
      `| ${r.scenarioId} ${r.name} | ${r.tokenizerFactor} | $${r.monthlyOpenAiUsd} | $${r.monthlyClaudeUsd} | $${r.monthlyTotalUsd} | $${r.claudeCoveredByCreditUsd} | $${r.selfPayUsd} |`,
    );
  }
  return lines.join("\n");
}
