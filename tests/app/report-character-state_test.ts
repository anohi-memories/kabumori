import assert from "node:assert/strict";
import test from "node:test";

import {
  REPORT_CHARACTER_STATES,
  selectReportCharacterState,
  type ReportCharacterState,
} from "../../src/lib/report-character-state.ts";
import type { PersonalizedReport, ReportBody } from "../../src/lib/report-presentation.ts";

type Tone = "positive" | "neutral" | "cautious";
type Direction = "up" | "down" | "mixed" | "flat" | "unknown";
type Stance = "tailwind" | "headwind" | "neutral" | "no_clear_material";

type Spec = {
  type?: "morning" | "close";
  tone?: Tone;
  direction?: Direction;
  sectionDirection?: Direction;
  stances?: Stance[];
  dayChange?: number | null;
  benchmarkChange?: number | null;
  detailGaps?: string[];
  sectionGaps?: string[];
  todayClaims?: Array<{ text_ja: string; claim_type?: string }>;
  overnightClaims?: Array<{ text_ja: string; claim_type?: string }>;
  sectionClaims?: Array<{ text_ja: string; claim_type?: string }>;
  overview?: string;
  summary?: string;
  risks?: string[];
  watchPoints?: string[];
};

// Builds only the fields the selector reads; everything else is intentionally absent/loose.
function report(spec: Spec = {}): PersonalizedReport {
  const type = spec.type ?? "morning";
  const body: Record<string, unknown> = {};
  if (spec.tone) body.tone = spec.tone;
  if (spec.overview !== undefined) body.overview_ja = spec.overview;
  if (spec.stances) body.holding_impacts = spec.stances.map((stance, index) => ({ ticker_code: `T${index}`, stance }));
  if (spec.direction || spec.detailGaps || spec.todayClaims || spec.overnightClaims || spec.risks || spec.watchPoints) {
    body.market_detail = {
      version: "t",
      report_type: type,
      direction: spec.direction,
      data_gaps_ja: spec.detailGaps ?? [],
      today_claims: (spec.todayClaims ?? []).map((c) => ({ claim_type: "observation", ...c })),
      overnight_claims: (spec.overnightClaims ?? []).map((c) => ({ claim_type: "observation", ...c })),
      risks_ja: spec.risks ?? [],
      watch_points_ja: spec.watchPoints ?? [],
    };
  }
  if (spec.sectionDirection || spec.sectionGaps || spec.sectionClaims) {
    body.market_section = {
      market_direction: spec.sectionDirection,
      data_gaps_ja: spec.sectionGaps ?? [],
      claims: (spec.sectionClaims ?? []).map((c) => ({ claim_type: "observation", scope: "market", ...c })),
    };
  }
  const snapshot = type === "close" && (spec.dayChange !== undefined || spec.benchmarkChange !== undefined)
    ? {
      report_type: "close",
      totals: {
        day_change_percent: spec.dayChange ?? null,
        topix_change_percent: spec.benchmarkChange ?? null,
      },
    }
    : null;
  return {
    id: "r1",
    report_type: type,
    trading_date: "2026-10-01",
    title_ja: null,
    summary_ja: spec.summary ?? null,
    body: body as ReportBody,
    portfolio_snapshot: snapshot as unknown as PersonalizedReport["portfolio_snapshot"],
    generated_at: "2026-10-01T00:00:00Z",
  };
}

function state(spec: Spec): ReportCharacterState {
  return selectReportCharacterState(report(spec));
}

test("the eight states are exactly 01..08 in order", () => {
  assert.deepEqual([...REPORT_CHARACTER_STATES], [
    "very_positive", "positive", "neutral", "uncertain", "caution", "negative", "very_negative", "volatile",
  ]);
});

// ---- the eight outcomes -------------------------------------------------

test("01 very_positive: no negatives and 3 positives (morning) / 4 (close)", () => {
  assert.equal(state({ type: "morning", tone: "positive", direction: "up", stances: ["tailwind", "tailwind"] }), "very_positive");
  assert.equal(
    state({ type: "close", tone: "positive", direction: "up", stances: ["tailwind"], dayChange: 1.2, benchmarkChange: 0.8 }),
    "very_positive",
  );
});

test("02 positive: positives outnumber negatives but are not very strong", () => {
  assert.equal(state({ type: "morning", tone: "positive", direction: "up" }), "positive");
  // close with only 3 positives is not "very" (needs 4)
  assert.equal(state({ type: "close", tone: "positive", direction: "up", dayChange: 0.5 }), "positive");
  // positive 2 vs negative 1 is still positive
  assert.equal(state({ type: "morning", tone: "positive", direction: "up", stances: ["headwind"] }), "positive");
});

test("03 neutral: balanced, calm, no gaps; also the answer for missing or legacy reports", () => {
  assert.equal(state({ tone: "neutral" }), "neutral");
  assert.equal(state({ tone: "neutral", direction: "flat" }), "neutral");
  assert.equal(selectReportCharacterState(null), "neutral");
  assert.equal(selectReportCharacterState(undefined), "neutral");
  assert.equal(selectReportCharacterState({ ...report(), body: null }), "neutral");
});

test("04 uncertain: no majority and (mixed/unknown direction, both signals, data gaps, or no-clear-material dominating)", () => {
  assert.equal(state({ tone: "neutral", direction: "mixed" }), "uncertain");
  assert.equal(state({ tone: "neutral", direction: "unknown" }), "uncertain");
  assert.equal(state({ tone: "positive", direction: "down" }), "uncertain", "1 positive vs 1 negative");
  assert.equal(state({ tone: "neutral", direction: "flat", detailGaps: ["米国指標が未取得"] }), "uncertain");
  assert.equal(state({ tone: "neutral", sectionDirection: "flat", sectionGaps: ["欠損あり"] }), "uncertain");
  assert.equal(state({ tone: "neutral", stances: ["no_clear_material", "no_clear_material", "tailwind", "neutral"] }), "positive", "a directional tailwind scores even next to no_clear_material rows");
  assert.equal(state({ tone: "neutral", stances: ["no_clear_material", "no_clear_material", "neutral"] }), "uncertain");
});

test("05 caution: negatives outnumber positives by one", () => {
  assert.equal(state({ type: "morning", tone: "cautious" }), "caution");
  assert.equal(state({ type: "morning", tone: "cautious", direction: "down", stances: ["tailwind"] }), "caution");
});

test("06 negative: negatives lead by two or more (but not very negative)", () => {
  assert.equal(state({ type: "morning", tone: "cautious", direction: "down" }), "negative");
  assert.equal(state({ type: "close", tone: "cautious", direction: "down", stances: ["headwind"] }), "negative", "3 negatives in a close is not yet 4");
});

test("07 very_negative: no positives and 3 negatives (morning) / 4 (close)", () => {
  assert.equal(state({ type: "morning", tone: "cautious", direction: "down", stances: ["headwind", "headwind"] }), "very_negative");
  assert.equal(
    state({ type: "close", tone: "cautious", direction: "down", stances: ["headwind"], dayChange: -1.5, benchmarkChange: -1 }),
    "very_negative",
  );
});

test("08 volatile: only explicit rough-market wording in the Fact-passed text", () => {
  assert.equal(state({ tone: "neutral", todayClaims: [{ text_ja: "日経平均は乱高下する展開となった。" }] }), "volatile");
  assert.equal(state({ tone: "neutral", overview: "米国市場は上下に大きく振れました。" }), "volatile");
  assert.equal(state({ tone: "neutral", sectionClaims: [{ text_ja: "ボラティリティが高い一日でした。" }] }), "volatile");
  assert.equal(state({ tone: "neutral", overnightClaims: [{ text_ja: "ナスダックは急騰と急落が交錯した。" }] }), "volatile");
  assert.equal(state({ summary: "値動きが激しい相場でした。" }), "volatile");
  // an explicit rough move wins over a strongly one-sided score (it is a different axis)
  assert.equal(state({ tone: "cautious", direction: "down", stances: ["headwind", "headwind"], summary: "値動きが荒い一日でした。" }), "volatile");
});

// ---- the guards the TASK demands --------------------------------------------

test("mixed direction alone never selects volatile", () => {
  assert.equal(state({ tone: "neutral", direction: "mixed" }), "uncertain");
  assert.equal(state({ tone: "positive", direction: "mixed", stances: ["tailwind"] }), "positive");
});

test("a severe negative score alone never selects volatile", () => {
  const severe = state({ type: "close", tone: "cautious", direction: "down", stances: ["headwind", "headwind"], dayChange: -3, benchmarkChange: -2.5 });
  assert.equal(severe, "very_negative");
  assert.notEqual(severe, "volatile");
});

test("risk / watch wording about a possible rough market is not volatile", () => {
  assert.notEqual(state({ tone: "neutral", risks: ["乱高下する可能性があります。"] }), "volatile");
  assert.notEqual(state({ tone: "neutral", watchPoints: ["ボラティリティが高い局面に注意が必要です。"] }), "volatile");
  assert.notEqual(state({ tone: "neutral", todayClaims: [{ text_ja: "乱高下が再び起きる可能性があります。" }] }), "volatile");
  assert.notEqual(state({ tone: "neutral", overview: "値動きが荒くなるリスクがあります。" }), "volatile");
  assert.notEqual(state({ tone: "neutral", todayClaims: [{ text_ja: "乱高下に注意する点です。", claim_type: "watch_point" }] }), "volatile");
});

// ---- signal rules --------------------------------------------------------------

test("close-day numbers count only for close reports", () => {
  const withNumbers = { dayChange: 2, benchmarkChange: 1.5, tone: "neutral" as Tone };
  assert.equal(state({ type: "close", ...withNumbers }), "positive");
  assert.equal(state({ type: "morning", ...withNumbers }), "neutral", "morning has no snapshot numbers to score");
});

test("zero or missing numbers add no signal; non-finite numbers are ignored", () => {
  assert.equal(state({ type: "close", tone: "neutral", dayChange: 0, benchmarkChange: 0 }), "neutral");
  assert.equal(state({ type: "close", tone: "neutral", dayChange: null, benchmarkChange: null }), "neutral");
  assert.equal(state({ type: "close", tone: "neutral", dayChange: Number.NaN, benchmarkChange: Infinity }), "neutral");
});

test("market_detail direction wins; the shared market_section is the fallback", () => {
  assert.equal(state({ tone: "neutral", direction: "up", sectionDirection: "down" }), "positive");
  assert.equal(state({ tone: "neutral", sectionDirection: "up" }), "positive");
  assert.equal(state({ tone: "neutral", sectionDirection: "down" }), "caution");
});

test("holding stances: the larger side wins, a tie scores nothing, neutral/no_clear_material never score", () => {
  assert.equal(state({ stances: ["tailwind", "tailwind", "headwind"] }), "positive");
  assert.equal(state({ stances: ["headwind", "headwind", "tailwind"] }), "caution");
  assert.equal(state({ tone: "neutral", stances: ["tailwind", "headwind"] }), "neutral");
  assert.equal(state({ tone: "neutral", stances: ["neutral", "neutral"] }), "neutral");
});

// ---- robustness ----------------------------------------------------------------

test("malformed old reports never throw and fall back to neutral", () => {
  const broken = [
    { id: "x" },
    { id: "x", report_type: "morning", body: { holding_impacts: "nope", market_detail: 5 } },
    { id: "x", report_type: "close", body: { tone: 7 }, portfolio_snapshot: { totals: null } },
    { id: "x", report_type: "morning", body: { market_detail: { today_claims: [null, 3, { text_ja: 9 }] } } },
  ];
  for (const value of broken) {
    assert.doesNotThrow(() => selectReportCharacterState(value as unknown as PersonalizedReport));
    assert.equal(selectReportCharacterState(value as unknown as PersonalizedReport), "neutral");
  }
});

test("the selector is deterministic: the same report always gives the same state", () => {
  const input = report({ type: "close", tone: "positive", direction: "up", dayChange: 1, benchmarkChange: 1, stances: ["tailwind"] });
  const first = selectReportCharacterState(input);
  for (let i = 0; i < 20; i++) assert.equal(selectReportCharacterState(input), first);
});

test("the selector has no network, AI, clock or randomness", async () => {
  const text = await Deno.readTextFile(new URL("../../src/lib/report-character-state.ts", import.meta.url));
  const code = text.replace(/\/\/.*$/gm, "");
  assert.ok(!/fetch\(|supabase|XMLHttp|WebSocket|Math\.random|Date\b|new Date|Date\.now|performance\.now|openai|anthropic|await |async /i.test(code));
  assert.ok(!/from '@\/lib\/(?!report-presentation)/.test(code), "only the report type is imported");
});
