// Builds fixtures/eval_nopost_sample.json from the read-only export (export_eval_nopost_sample.sql) and the labels
// (fixtures/eval_labels_nopost.json).
//   deno run --no-config --allow-read --allow-write tools/provider-compare/scripts/build_nopost_sample.ts <rows.jsonl> [out.json]
// Deterministic. Bodies are committed only for hosts in src/body_policy.ts; every other body is represented by its length and
// SHA-256 and re-read from production at run time.
import type { Importance } from "../src/fixtures.ts";
import { sanitizeBody } from "../src/sanitize.ts";
import { bodyMayBeStored } from "../src/body_policy.ts";
import type { LabelRecord, LabelStatus } from "../src/eval_set.ts";
import type { NopostCase, NopostSampleFile } from "../src/nopost_sample.ts";
import { sha256Hex } from "./eval_manifest.ts";

type Row = Record<string, unknown>;
type CompactLabel = [string, string, string | null, string, string, boolean?];
type LabelsFile = { labels: Record<string, CompactLabel> };

const EXPECTED: Record<string, Importance | null> = { n: "no_post", i: "important", m: "most_important", "null": null };
const STATUS: Record<string, LabelStatus> = {
  I: "independent_confirmed",
  A: "ai_provisional",
  H: "human_review_pending",
  X: "insufficient_evidence",
};

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

export function expandLabel(entry: CompactLabel, sourceName: string): LabelRecord & { suspected: boolean } {
  const [expectedKey, statusKey, rule, keyFact, rationale, suspected] = entry;
  if (!(expectedKey in EXPECTED)) throw new Error(`UNKNOWN_EXPECTED:${expectedKey}`);
  if (!(statusKey in STATUS)) throw new Error(`UNKNOWN_STATUS:${statusKey}`);
  const expected = EXPECTED[expectedKey];
  const status = STATUS[statusKey];
  const decided = status === "independent_confirmed" || status === "ai_provisional";
  if (decided !== (expected !== null)) throw new Error(`STATUS_EXPECTED_MISMATCH:${expectedKey}:${statusKey}`);
  const official = sourceName === "tdnet" || sourceName === "jp_official" || sourceName === "market_macro";
  return {
    expected,
    status,
    rule,
    cluster: null,
    headline: decided,
    keyFacts: [keyFact],
    rationale,
    ...(status === "human_review_pending" ? { reviewReason: rationale } : {}),
    primarySourceCheck: official ? "stored_extraction_of_official_document" : "secondary_article_summary",
    verifier: "none",
    suspected: suspected === true,
  };
}

export async function buildNopostCase(row: Row, labels: LabelsFile): Promise<NopostCase> {
  const id = String(row.id);
  const id8 = id.slice(0, 8);
  const entry = labels.labels[id8];
  if (!entry) throw new Error(`NO_LABEL:${id8}`);
  const sourceName = String(row.source_name);
  const sourceUrl = String(row.source_url);
  const original = text(row.body_summary) ?? "";
  const stored = bodyMayBeStored(sourceUrl);
  return {
    caseId: `nopost-${sourceName.replace(/_/g, "-")}-${id8}`,
    candidateId: id,
    sourceName,
    sourceUrl,
    title: String(row.title),
    companyName: text(row.company_name),
    companyCode: text(row.company_code),
    category: String(row.category),
    publishedAt: new Date(String(row.published_at)).toISOString(),
    bodyStored: stored,
    bodySummary: stored ? sanitizeBody(original) : null,
    bodyCharsOriginal: original.length,
    bodySha256: await sha256Hex(original),
    layer: row.gate_suppressed === true ? "gate_suppressed" : "not_gated",
    cell: { n: Number(row.cell_n), sampled: Number(row.cell_sampled), rank: Number(row.cell_rank) },
    recorded: {
      importance: row.importance as Importance,
      model: text(row.judgement_model) ?? "unknown",
      confidence: Number(row.confidence ?? 0),
      escalatedToSol: row.escalated_to_sol === true,
      reason: text(row.judgement_reason) ?? "",
      coverageSeverity: text(row.coverage_severity),
    },
    label: expandLabel(entry, sourceName),
  };
}

export async function buildNopostSample(rows: Row[], labels: LabelsFile, codeVersions: NopostSampleFile["codeVersions"]): Promise<NopostSampleFile> {
  const cases: NopostCase[] = [];
  for (const row of rows) cases.push(await buildNopostCase(row, labels));
  cases.sort((a, b) => a.caseId.localeCompare(b.caseId));
  const extra = Object.keys(labels.labels).filter((id) => !rows.some((r) => String(r.id).startsWith(id)));
  if (extra.length > 0) throw new Error(`LABELS_WITHOUT_ROWS:${extra.join(",")}`);
  const cells = new Map<string, { layer: string; source: string; n: number; sampled: number }>();
  for (const c of cases) cells.set(`${c.layer}|${c.sourceName}`, { layer: c.layer, source: c.sourceName, n: c.cell.n, sampled: c.cell.sampled });
  const layer = (name: string) => {
    const mine = [...cells.values()].filter((c) => c.layer === name);
    return { n: mine.reduce((s, c) => s + c.n, 0), sampled: mine.reduce((s, c) => s + c.sampled, 0) };
  };
  return {
    version: 3,
    exportedAt: "2026-10-10",
    population: {
      window: "2026-09-10 00:00 .. 2026-10-10 00:00 JST",
      definition:
        "AI-judged candidates (judgement_model is not null) whose final importance is no_post, created in the window, minus the 212 cases already in the evaluation set. gate_suppressed = the stored reason ends with the information-sufficiency gate text (importance forced to no_post).",
      seed: "kabumori-nopost-v4",
      excludedCases: 212,
      layers: { gate_suppressed: layer("gate_suppressed"), not_gated: layer("not_gated") },
      cells: [...cells.values()].sort((a, b) => `${a.layer}|${a.source}`.localeCompare(`${b.layer}|${b.source}`)),
    },
    codeVersions,
    cases,
  };
}

if (import.meta.main) {
  const [rowsPath, outPath] = Deno.args;
  if (!rowsPath) {
    console.error("usage: build_nopost_sample.ts <rows.jsonl> [out.json]");
    Deno.exit(2);
  }
  const rows = (await Deno.readTextFile(rowsPath)).split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Row);
  const labels = JSON.parse(await Deno.readTextFile(new URL("../fixtures/eval_labels_nopost.json", import.meta.url))) as LabelsFile;
  const main = JSON.parse(await Deno.readTextFile(new URL("../fixtures/eval_labels.json", import.meta.url)));
  const file = await buildNopostSample(rows, labels, main.codeVersions);
  const target = outPath ?? new URL("../fixtures/eval_nopost_sample.json", import.meta.url).pathname;
  await Deno.writeTextFile(target, JSON.stringify(file, null, 2) + "\n");
  console.log(`wrote ${file.cases.length} cases to ${target}`);
}
