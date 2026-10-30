// Prints (and optionally writes) the Phase 4 no_post-layer report: composition, label status, the suspected-miss list and the
// layer-wise upper bounds with their assumptions.
//   deno run --no-config --allow-read [--allow-write=<out>] tools/provider-compare/scripts/nopost_report.ts [--out <file.json>]
import { estimateNopostMissRate, type NopostCase, type NopostSampleFile } from "../src/nopost_sample.ts";

export async function loadNopostSample(): Promise<NopostSampleFile> {
  const file = JSON.parse(await Deno.readTextFile(new URL("../fixtures/eval_nopost_sample.json", import.meta.url))) as NopostSampleFile;
  if (file.version !== 3 || !Array.isArray(file.cases)) throw new Error("NOPOST_SAMPLE_INVALID");
  return file;
}

const tally = <T>(items: readonly T[], key: (item: T) => string) => {
  const out: Record<string, number> = {};
  for (const item of items) out[key(item)] = (out[key(item)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
};

export function buildNopostReport(cases: readonly NopostCase[]) {
  const priority = cases.filter((c) => c.label.suspected || c.label.expected === "important" || c.label.expected === "most_important" ||
    c.label.status === "human_review_pending");
  return {
    sampled: cases.length,
    byLayer: tally(cases, (c) => c.layer),
    bySource: tally(cases, (c) => c.sourceName),
    byStatus: tally(cases, (c) => c.label.status),
    byExpected: tally(cases, (c) => c.label.expected ?? "null"),
    undeterminedByReason: tally(
      cases.filter((c) => c.label.expected === null),
      (c) => (c.label.status === "human_review_pending" ? "policy_question" : /当期の行|経営成績|当期/.test(c.label.rationale) ? "tanshin_current_row_missing" : "stored_text_lacks_decisive_fact"),
    ),
    bodiesStored: cases.filter((c) => c.bodyStored).length,
    estimate: estimateNopostMissRate(cases),
    priorityReview: priority.map((c) => ({
      caseId: c.caseId,
      layer: c.layer,
      expected: c.label.expected,
      status: c.label.status,
      rule: c.label.rule,
      suspected: c.label.suspected,
      title: c.title.slice(0, 80),
    })),
  };
}

if (import.meta.main) {
  const file = await loadNopostSample();
  const report = buildNopostReport(file.cases);
  console.log(JSON.stringify({ ...report, priorityReview: `${report.priorityReview.length} items` }, null, 2));
  const outIndex = Deno.args.indexOf("--out");
  if (outIndex >= 0 && Deno.args[outIndex + 1]) await Deno.writeTextFile(Deno.args[outIndex + 1], JSON.stringify(report, null, 2) + "\n");
}
