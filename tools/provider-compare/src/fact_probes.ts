import type { CaseFixture } from "./fixtures.ts";
import type { NeutralRequest } from "./types.ts";
import { captureOpenAiRequest } from "./capture.ts";
import { fromOpenAiResponsesBody } from "./neutral.ts";
import { generationCandidate, recordedFinalText } from "./tasks.ts";
import { requestGenerationStep } from "../../../supabase/functions/important-news-monitor/post_generation_logic.ts";

// Fact "tamper probes". A post that production's Fact check PASSED is deliberately damaged in one well-defined way and
// the Fact prompt is asked about it. Because the damage is known, the right verdict is known without a human:
//   fail  the model must flag the post (a miss here is a Fact-check miss on the exact hazards PR #116 targets)
//   pass  an equivalent rewrite (unit conversion) that must NOT be flagged (a false alarm here costs publications)
// The prompt sent is the production Fact prompt of the checked-out production code (captured, never copied).
// Mutations are regex rules over the post body, deterministic, at most one probe per (post, mutation).

export type MutationType =
  | "currency_swap"      // 円 -> ドル on the first yen amount (通貨の取り違え)
  | "direction_flip"     // 下方修正 -> 上方修正, 増額 -> 減額, 損失 -> 利益 ... (負号・方向の消失)
  | "amount_swap"        // two different amounts of the same unit exchange places (指標と金額の交換)
  | "state_flip"         // 承認 -> 否決, 設置 -> 撤回, 予定 -> 完了 ... (承認・撤回状態の誤り)
  | "subject_swap"       // parent and subsidiary / reporter and actor exchange places (主体の取り違え)
  | "hedge_removal"      // 「とされています」「可能性があります」 -> 断定 (exploratory)
  | "unit_equivalent";   // 147百万円 -> 1.47億円 (同値単位換算: must pass)

export type Expectation = "fail" | "pass";

export type FactProbe = {
  probeId: string;
  caseId: string;
  mutation: MutationType;
  expected: Expectation;
  /** exploratory probes are reported but excluded from headline detection rates. */
  exploratory: boolean;
  /** Human-readable description of the change, e.g. "11円 -> 11ドル". */
  change: string;
  mutatedFinalText: string;
};

export const MUTATION_EXPECTATION: Readonly<Record<MutationType, { expected: Expectation; exploratory: boolean }>> = {
  currency_swap: { expected: "fail", exploratory: false },
  direction_flip: { expected: "fail", exploratory: false },
  amount_swap: { expected: "fail", exploratory: false },
  state_flip: { expected: "fail", exploratory: false },
  subject_swap: { expected: "fail", exploratory: false },
  hedge_removal: { expected: "fail", exploratory: true },
  unit_equivalent: { expected: "pass", exploratory: false },
};

type Result = { mutated: string; change: string } | null;

const AMOUNT = /\d[\d,]*(?:\.\d+)?(?:億|百万|万|千)?円/g;

function replaceFirst(body: string, pairs: ReadonlyArray<readonly [string, string]>): Result {
  for (const [from, to] of pairs) {
    const index = body.indexOf(from);
    if (index >= 0) return { mutated: body.slice(0, index) + to + body.slice(index + from.length), change: `${from} -> ${to}` };
  }
  return null;
}

function currencySwap(body: string): Result {
  const match = /(\d[\d,]*(?:\.\d+)?(?:億|百万|万|千)?)円/.exec(body);
  if (!match || match.index === undefined) return null;
  const to = `${match[1]}ドル`;
  return { mutated: body.slice(0, match.index) + to + body.slice(match.index + match[0].length), change: `${match[0]} -> ${to}` };
}

const DIRECTION_PAIRS = [
  ["下方修正", "上方修正"], ["上方修正", "下方修正"], ["増額", "減額"], ["減額", "増額"], ["引き上げ", "引き下げ"],
  ["引き下げ", "引き上げ"], ["減の", "増の"], ["増の", "減の"], ["赤字", "黒字"], ["損失", "利益"],
] as const;

const STATE_PAIRS = [
  ["承認されました", "否決されました"], ["可決されました", "否決されました"], ["設置しました", "撤回しました"],
  ["決議しました", "撤回しました"], ["子会社化します", "子会社化を見送ります"], ["取得し、", "取得を中止し、"],
  ["実施します", "中止します"], ["となる予定です", "となりました"], ["に指定されました", "の指定が解除されました"],
] as const;

function amountSwap(body: string): Result {
  const tokens = [...body.matchAll(AMOUNT)].map((m) => m[0]);
  const unit = (token: string) => token.replace(/^[\d,.]+/, "");
  for (let i = 0; i < tokens.length; i += 1) {
    for (let j = i + 1; j < tokens.length; j += 1) {
      if (tokens[i] !== tokens[j] && unit(tokens[i]) === unit(tokens[j])) {
        const [a, b] = [tokens[i], tokens[j]];
        const marker = "\u0000";
        const mutated = body.split(a).join(marker).split(b).join(a).split(marker).join(b);
        return mutated === body ? null : { mutated, change: `${a} <-> ${b}` };
      }
    }
  }
  return null;
}

function subjectSwap(body: string): Result {
  const reporter = /([^【】\n。、]{2,30}?)によると、傘下の([^【】\n。、]{2,30}?)が/.exec(body);
  if (reporter && reporter.index !== undefined) {
    const [whole, parent, child] = reporter;
    const swapped = `${child}によると、傘下の${parent}が`;
    return { mutated: body.slice(0, reporter.index) + swapped + body.slice(reporter.index + whole.length), change: `${parent} <-> ${child}` };
  }
  const named = /^(【[^】]+】)(.{2,20}?)（(\d{4})）は、完全子会社の(.{2,30}?)と/.exec(body);
  if (named) {
    const [whole, label, parent, code, child] = named;
    const swapped = `${label}${child}（${code}）は、完全子会社の${parent}と`;
    return { mutated: swapped + body.slice(whole.length), change: `${parent} <-> ${child}` };
  }
  return null;
}

function hedgeRemoval(body: string): Result {
  const rules: Array<readonly [RegExp, string]> = [
    [/した(?:と報じられています|とされています|とみられます|と伝えられています)/, "しました"],
    [/する可能性があります/, "します"],
    [/可能性があります/, "ことになります"],
    [/見込んでいます/, "確定しています"],
  ];
  for (const [pattern, to] of rules) {
    const match = pattern.exec(body);
    if (match && match.index !== undefined) {
      return { mutated: body.slice(0, match.index) + to + body.slice(match.index + match[0].length), change: `${match[0]} -> ${to}` };
    }
  }
  return null;
}

function trimNumber(value: number): string {
  return Number(value.toFixed(2)).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function unitEquivalent(body: string): Result {
  const million = /(\d[\d,]*(?:\.\d+)?)百万円/.exec(body);
  if (million && million.index !== undefined) {
    const to = `${trimNumber(Number(million[1].replace(/,/g, "")) / 100)}億円`;
    return { mutated: body.slice(0, million.index) + to + body.slice(million.index + million[0].length), change: `${million[0]} -> ${to}` };
  }
  const hundredMillion = /(\d[\d,]*)億円/.exec(body);
  if (hundredMillion && hundredMillion.index !== undefined) {
    const to = `${(Number(hundredMillion[1].replace(/,/g, "")) * 100).toLocaleString("en-US")}百万円`;
    return { mutated: body.slice(0, hundredMillion.index) + to + body.slice(hundredMillion.index + hundredMillion[0].length), change: `${hundredMillion[0]} -> ${to}` };
  }
  return null;
}

const RULES: ReadonlyArray<readonly [MutationType, (body: string) => Result]> = [
  ["currency_swap", currencySwap],
  ["direction_flip", (body) => replaceFirst(body, DIRECTION_PAIRS)],
  ["amount_swap", amountSwap],
  ["state_flip", (body) => replaceFirst(body, STATE_PAIRS)],
  ["subject_swap", subjectSwap],
  ["hedge_removal", hedgeRemoval],
  ["unit_equivalent", unitEquivalent],
];

const SOURCE_LINE = /\n\n出典:\s*\S+\s*$/u;

/** Splits a stored post into its body and the source line production appends. */
export function splitPost(finalText: string): { body: string; sourceLine: string } {
  const match = SOURCE_LINE.exec(finalText);
  return match ? { body: finalText.slice(0, match.index), sourceLine: match[0] } : { body: finalText, sourceLine: "" };
}

export function probesFor(caseId: string, finalText: string): FactProbe[] {
  const { body, sourceLine } = splitPost(finalText);
  const probes: FactProbe[] = [];
  for (const [mutation, rule] of RULES) {
    const result = rule(body);
    if (!result || result.mutated === body) continue;
    const meta = MUTATION_EXPECTATION[mutation];
    probes.push({
      probeId: `${caseId}::${mutation}`,
      caseId,
      mutation,
      expected: meta.expected,
      exploratory: meta.exploratory,
      change: result.change,
      mutatedFinalText: result.mutated + sourceLine,
    });
  }
  return probes;
}

/** Probes for every stored post that production's own Fact check passed (the clean originals). */
export function buildFactProbes(cases: readonly CaseFixture[]): FactProbe[] {
  return [...cases]
    .sort((a, b) => a.caseId.localeCompare(b.caseId))
    .filter((fixture) => fixture.recorded.generation?.factStatus === "passed" && recordedFinalText(fixture) !== null)
    .flatMap((fixture) => probesFor(fixture.caseId, recordedFinalText(fixture) as string));
}

/** The production Fact request for the damaged post (prompt and schema captured from production, not copied). */
export async function buildFactProbeRequest(probe: FactProbe, fixture: CaseFixture): Promise<NeutralRequest> {
  const captured = await captureOpenAiRequest((fetchImpl) =>
    requestGenerationStep("capture-only", "fact", generationCandidate(fixture), probe.mutatedFinalText, fetchImpl)
  );
  return fromOpenAiResponsesBody(captured.body, { taskId: "fact_probe", caseId: probe.probeId });
}

export type ProbeOutcome = { probe: FactProbe; flagged: boolean | null };

export type ProbeSummary = {
  mutation: MutationType;
  n: number;
  expected: Expectation;
  exploratory: boolean;
  /** fail-expected: share flagged (detection rate). pass-expected: share flagged (false-alarm rate). */
  flaggedRate: number | null;
  /** fail-expected only: probes the model passed although they are wrong. */
  missed: number;
  /** pass-expected only: equivalents the model wrongly failed. */
  falseAlarms: number;
};

export function summariseProbeOutcomes(outcomes: readonly ProbeOutcome[]): ProbeSummary[] {
  const groups = new Map<MutationType, ProbeOutcome[]>();
  for (const outcome of outcomes) groups.set(outcome.probe.mutation, [...(groups.get(outcome.probe.mutation) ?? []), outcome]);
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([mutation, group]) => {
    const scored = group.filter((o) => o.flagged !== null);
    const flagged = scored.filter((o) => o.flagged === true).length;
    const meta = MUTATION_EXPECTATION[mutation];
    return {
      mutation,
      n: group.length,
      expected: meta.expected,
      exploratory: meta.exploratory,
      flaggedRate: scored.length === 0 ? null : Math.round((flagged / scored.length) * 1000) / 1000,
      missed: meta.expected === "fail" ? scored.length - flagged : 0,
      falseAlarms: meta.expected === "pass" ? flagged : 0,
    };
  });
}
