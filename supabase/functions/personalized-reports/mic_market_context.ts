// Read-only MIC (Market Intelligence Core) State as additional, non-authoritative
// context for the app's personalized morning/close reports.
//
// Scope (Phase 1, source-only): rates / macro / equity_index. Reads only
// market_state_current -- never mic_state_evaluation_runs, mic_state_evidence
// or mic_fed_statement_diffs, so a domain's context is only ever the content
// of its most recently *written* State (by a 'no_change' or 'evaluated' run;
// a 'failed' or still-'running' run never writes this table, so there is
// nothing to filter out here -- reading this table already excludes them).
//
// This is deliberately separate from the shared_market (X + app) analysis
// pipeline: it reads a different table, is optional, and never overrides or
// contradicts shared_market. A MIC fetch failure never blocks report
// generation -- the caller treats [] the same as "MIC has nothing to add".
export type MicDomain = "rates" | "macro" | "equity_index";

export const MIC_DOMAINS: readonly MicDomain[] = ["rates", "macro", "equity_index"];

const MIC_DOMAIN_LABEL_JA: Record<MicDomain, string> = {
  rates: "金利", macro: "マクロ経済", equity_index: "国内株式（指数）",
};

export type MicConfidenceLabel = "high" | "medium" | "low";
const CONFIDENCE_LABEL_JA: Record<MicConfidenceLabel, string> = { high: "高", medium: "中", low: "低" };

// Aligned with mic_state_decision_logic.ts's computeDataConfidence bands:
// 1.0/0.9 = full coverage + fresh/delayed_expected observation ("high");
// 0.2 = fetch failed ("low"); values in between ("medium").
export function confidenceLabel(dataConfidence: number): MicConfidenceLabel {
  if (dataConfidence >= 0.8) return "high";
  if (dataConfidence >= 0.5) return "medium";
  return "low";
}

// Raw shape as PostgREST returns a market_state_current row for this select list.
export type MicMarketRow = {
  domain?: unknown;
  narrative?: unknown;
  bullish_factors?: unknown;
  bearish_factors?: unknown;
  key_risks?: unknown;
  data_confidence?: unknown;
  coverage_status?: unknown;
  observation_status?: unknown;
  ai_model?: unknown;
  ai_evaluated_at?: unknown;
  as_of?: unknown;
  source_evaluation_run_id?: unknown;
};

export type MicDomainState = {
  domain: MicDomain;
  narrative: string;
  bullishFactors: string[];
  bearishFactors: string[];
  keyRisks: string[];
  dataConfidence: number;
  confidence: MicConfidenceLabel;
  coverageStatus: string | null;
  observationStatus: string | null;
  aiModel: string | null;
  aiEvaluatedAt: string | null;
  asOf: string | null;
  sourceEvaluationRunId: string | null;
};

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

// Never evaluated yet (narrative still null) -> no context for that domain,
// not an error. A row that fails to parse at all is treated the same way
// (fail-open per domain, not per whole fetch).
export function toMicDomainState(row: MicMarketRow): MicDomainState | null {
  if (!MIC_DOMAINS.includes(row.domain as MicDomain)) return null;
  if (typeof row.narrative !== "string" || row.narrative.trim().length === 0) return null;
  if (typeof row.data_confidence !== "number" || !Number.isFinite(row.data_confidence) ||
      row.data_confidence < 0 || row.data_confidence > 1) return null;
  const dataConfidence = row.data_confidence;
  return {
    domain: row.domain as MicDomain,
    narrative: row.narrative,
    bullishFactors: stringArray(row.bullish_factors),
    bearishFactors: stringArray(row.bearish_factors),
    keyRisks: stringArray(row.key_risks),
    dataConfidence,
    confidence: confidenceLabel(dataConfidence),
    coverageStatus: typeof row.coverage_status === "string" ? row.coverage_status : null,
    observationStatus: typeof row.observation_status === "string" ? row.observation_status : null,
    aiModel: typeof row.ai_model === "string" ? row.ai_model : null,
    aiEvaluatedAt: typeof row.ai_evaluated_at === "string" ? row.ai_evaluated_at : null,
    asOf: typeof row.as_of === "string" ? row.as_of : null,
    sourceEvaluationRunId: typeof row.source_evaluation_run_id === "string" ? row.source_evaluation_run_id : null,
  };
}

export function toMicDomainStates(rows: MicMarketRow[]): MicDomainState[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (typeof row.domain === "string") counts.set(row.domain, (counts.get(row.domain) ?? 0) + 1);
  }
  // The DB primary key normally prevents this. If a malformed response repeats
  // a domain, omit that domain rather than letting conflicting narratives win
  // by response order.
  return rows
    .filter((row) => typeof row.domain !== "string" || counts.get(row.domain) === 1)
    .map(toMicDomainState)
    .filter((state): state is MicDomainState => state !== null);
}

const MIC_SELECT = "domain,narrative,bullish_factors,bearish_factors,key_risks,data_confidence," +
  "coverage_status,observation_status,ai_model,ai_evaluated_at,as_of,source_evaluation_run_id";

// Fail-open by design: this is additional context, never a hard dependency of
// report generation (see the file header). Any failure -- missing table,
// network error, malformed response -- yields [], identical to "MIC has no
// context yet for these domains". The caller never needs its own try/catch
// around this call.
export async function loadMicMarketContext(
  db: { get<T>(path: string): Promise<T> },
): Promise<MicDomainState[]> {
  try {
    const rows = await db.get<MicMarketRow[]>(`market_state_current?domain=in.(${MIC_DOMAINS.join(",")})&select=${MIC_SELECT}`);
    if (!Array.isArray(rows)) return [];
    return toMicDomainStates(rows);
  } catch {
    return [];
  }
}

// The packet field the report-writing AI actually sees. Deliberately narrow:
// no raw data_confidence number, no ai_model/as_of/run id (those are
// provenance, not content -- they go into source_basis for audit instead,
// mirroring how shared_market's packet_id/content_hash never reach the AI
// packet either).
export type MicPacketEntry = {
  domain: string;
  narrative: string;
  bullish_points: string[];
  bearish_points: string[];
  key_risks: string[];
  confidence: string;
  narrative_freshness: "fresh" | "recent" | "stale" | "unknown";
  observation_status: "fresh" | "delayed_expected" | "stale" | "unknown";
  coverage_status: "full" | "partial" | "unavailable";
};

function narrativeFreshness(aiEvaluatedAt: string | null, now: number): MicPacketEntry["narrative_freshness"] {
  if (aiEvaluatedAt === null) return "unknown";
  const evaluatedAt = Date.parse(aiEvaluatedAt);
  const ageMs = now - evaluatedAt;
  if (!Number.isFinite(evaluatedAt) || ageMs < 0) return "unknown";
  // The evaluator normally runs once per weekday. Allow a little scheduling
  // drift for fresh, then a weekend-sized window for recent; older narratives
  // are explicitly marked stale. This measures narrative age, unlike as_of,
  // which the no_change RPC refreshes without regenerating the narrative.
  if (ageMs <= 36 * 60 * 60 * 1000) return "fresh";
  if (ageMs <= 96 * 60 * 60 * 1000) return "recent";
  return "stale";
}

export function toMicPacketEntries(states: MicDomainState[], now = Date.now()): MicPacketEntry[] {
  return states.map((state) => ({
    domain: MIC_DOMAIN_LABEL_JA[state.domain],
    narrative: state.narrative,
    bullish_points: [...state.bullishFactors],
    bearish_points: [...state.bearishFactors],
    key_risks: [...state.keyRisks],
    confidence: CONFIDENCE_LABEL_JA[state.confidence],
    narrative_freshness: narrativeFreshness(state.aiEvaluatedAt, now),
    observation_status: ["fresh", "delayed_expected", "stale", "unknown"].includes(state.observationStatus ?? "")
      ? state.observationStatus as MicPacketEntry["observation_status"]
      : "unknown",
    coverage_status: ["full", "partial", "unavailable"].includes(state.coverageStatus ?? "")
      ? state.coverageStatus as MicPacketEntry["coverage_status"]
      : "unavailable",
  }));
}

// Audit trail only (source_basis column), never sent to the writer/fact-check AI.
export function micSourceBasis(states: MicDomainState[]): Record<string, unknown> | undefined {
  if (states.length === 0) return undefined;
  return {
    mic_state: states.map((state) => ({
      domain: state.domain,
      ai_model: state.aiModel,
      ai_evaluated_at: state.aiEvaluatedAt,
      as_of: state.asOf,
      source_evaluation_run_id: state.sourceEvaluationRunId,
      data_confidence: state.dataConfidence,
    })),
  };
}

// Conditionally appended to the writer instructions only when the packet
// carries a non-empty mic_market. Treats MIC content strictly as
// unconfirmed background: never fact_ja, never contradicting shared_market,
// and low-confidence domains never used for confident/strong statements.
export const MIC_MARKET_INSTRUCTIONS = [
  "入力の mic_market は、金利・マクロ経済・国内株式全体についての日次AI分析で、shared_market（Factチェック済みの確定分析）とは異なる未確定の参考情報です。",
  "mic_market の narrative や bullish_points / bearish_points / key_risks を、そのまま書き写したり要約として貼り付けたりしません。overview_ja や holding_impacts の inference_ja で、一般的な市場環境の背景として触れる場合だけ使います。",
  "mic_market の内容は確定した事実（fact_ja）として書きません。触れる場合は必ず推定の言い方（inference_ja）にします。",
  "mic_market の confidence が「低」の項目は、参考程度にとどめ、断定的な言い方や強い結論の根拠にしません。",
  "narrative_freshness が stale または unknown、observation_status が stale または unknown、または coverage_status が unavailable の項目は、現在の市場状況の根拠として使いません。recent や delayed_expected は時間差を意識した弱い推定に限り、coverage_status=partial は結論を弱めます。",
  "mic_market と shared_market の内容が食い違う場合は shared_market を優先し、その論点では mic_market 側の内容を書きません。",
].join("\n");

// Appended to the Fact-check instructions only when the packet carries a
// non-empty mic_market -- mirrors REPORT_FACT_INSTRUCTIONS' existing
// shared_market contradiction check.
export const MIC_MARKET_FACT_INSTRUCTIONS =
  "packet に mic_market がある場合、それは未確定の参考情報です。report がその内容を確定事実（fact_ja）として書いていたり、confidence が「低」の項目を断定的な結論に使っていたり、narrative_freshness が stale/unknown、observation_status が stale/unknown、または coverage_status が unavailable の内容を現在の根拠として使っていたり、shared_market と矛盾する内容を mic_market 側の情報で書いていたら passed を false にします。";
