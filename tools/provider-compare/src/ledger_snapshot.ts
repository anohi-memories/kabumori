import type { LedgerAverages } from "./providers/recorded.ts";

export type LedgerFeature = {
  model: string;
  calls: number;
  searches: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  p90InputTokens: number;
  avgUsd: number;
  totalUsd: number;
};

export type LedgerSnapshot = {
  version: 1;
  source: string;
  window: { fromJst: string; toJst: string; days: number; note: string };
  features: Record<string, LedgerFeature>;
  outcomes: Record<string, number>;
  webSearchBaseline: {
    note: string;
    events: number;
    searches: number;
    eventsWithCandidates: number;
    candidates: number;
    importantOrMoreCandidates: number;
    avgSurfacedSources: number;
    surfacedSourcesOnAllowedDomains: number;
    observation: string;
  };
  otherOpenAiUse: string;
};

export async function loadLedgerSnapshot(
  url: URL = new URL("../data/openai_ledger_snapshot_2026-10-09.json", import.meta.url),
): Promise<LedgerSnapshot> {
  const snapshot = JSON.parse(await Deno.readTextFile(url)) as LedgerSnapshot;
  if (snapshot.version !== 1 || typeof snapshot.features !== "object") throw new Error("LEDGER_SNAPSHOT_INVALID");
  return snapshot;
}

export function averagesOf(snapshot: LedgerSnapshot): LedgerAverages {
  return Object.fromEntries(
    Object.entries(snapshot.features).map(([feature, value]) => [feature, {
      model: value.model,
      avgInputTokens: value.avgInputTokens,
      avgOutputTokens: value.avgOutputTokens,
    }]),
  );
}
