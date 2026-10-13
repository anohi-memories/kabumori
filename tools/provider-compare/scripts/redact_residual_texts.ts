// Offline redaction CANDIDATE for retained texts that repeat a known third-party text (see src/residual_redaction.ts).
//
//   deno run --no-config --allow-read --allow-write=tools/provider-compare/fixtures,docs/model-optimization \
//     tools/provider-compare/scripts/redact_residual_texts.ts --legacy-file <private cases.json> \
//     [--rows <export.jsonl>] [--min-run 40] [--record docs/model-optimization/residual_redaction_2026-10-14.json] [--dry-run]
//
// References are files you hold locally: bodies and headlines of the private legacy file and, optionally, the `title`
// column of a production export. Only strings that contain a run of at least --min-run characters from a reference are
// withheld; the record lists pointer, length, SHA-256 and longest run (no text). Idempotent. --dry-run writes nothing and
// prints counts only.
import { bodyMayBeStored } from "../src/body_policy.ts";
import { applyWithheld, findOverlapping, maskedDigest, type WithheldEntry } from "../src/residual_redaction.ts";
import type { ReferenceText } from "../src/residual_text_report.ts";
import { caseHazards } from "./eval_set_report.ts";

const arg = (name: string): string | undefined => {
  const at = Deno.args.indexOf(name);
  return at >= 0 ? Deno.args[at + 1] : undefined;
};
const legacyPath = arg("--legacy-file");
if (!legacyPath) throw new Error("usage: --legacy-file <private cases.json> [--rows <export.jsonl>] [--min-run 40] [--record <path>] [--dry-run]");
const minRun = Number(arg("--min-run") ?? "40");
if (!Number.isInteger(minRun) || minRun < 8) throw new Error("--min-run must be an integer of at least 8");
const dryRun = Deno.args.includes("--dry-run");
const recordPath = arg("--record");

const references: ReferenceText[] = [];
for (const c of JSON.parse(await Deno.readTextFile(legacyPath)).cases) {
  const cand = c.candidate;
  if (bodyMayBeStored(cand.sourceUrl)) continue;
  if (cand.bodySummary) references.push({ key: `body:${c.caseId.slice(-8)}`, text: cand.bodySummary });
  references.push({ key: `title:${c.caseId.slice(-8)}`, text: cand.title });
}
const dir = new URL("../fixtures/", import.meta.url);
const rowsPath = arg("--rows");
if (rowsPath) {
  // Only headlines of sources without confirmed terms are references: the headline of an open-terms source is retained on
  // purpose and repeats in its own body. The source of each id comes from the committed datasets; an unknown id is kept
  // as a reference (conservative).
  const openIds = new Set<string>();
  for (const name of ["eval_expansion.json", "eval_nopost_sample.json"]) {
    for (const c of JSON.parse(await Deno.readTextFile(new URL(name, dir))).cases) {
      const url = String(c.candidate?.sourceUrl ?? c.sourceUrl ?? "");
      if (bodyMayBeStored(url)) openIds.add(String(c.candidateId).slice(0, 8));
    }
  }
  for (const line of (await Deno.readTextFile(rowsPath)).split("\n")) {
    if (!line.startsWith("{")) continue;
    const row = JSON.parse(line) as { id?: string; title?: string };
    if (typeof row.id !== "string" || typeof row.title !== "string") continue;
    if (!openIds.has(row.id.slice(0, 8))) references.push({ key: `title:${row.id.slice(0, 8)}`, text: row.title });
  }
}
console.log(`references=${references.length} minRun=${minRun}${dryRun ? " (dry run)" : ""}`);

const FILES = [
  "cases.rights_safe.json",
  "eval_expansion.json",
  "eval_nopost_sample.json",
  "eval_labels.json",
  "eval_labels_nopost.json",
  "eval_provisional_policy.json",
] as const;

const record: Record<string, { minRun: number; withheld: WithheldEntry[]; maskedContentSha256: string }> = {};
for (const name of FILES) {
  const root = JSON.parse(await Deno.readTextFile(new URL(name, dir)));
  const entries = await findOverlapping(root, references, minRun);
  if (name === "eval_expansion.json") {
    // Hazard tags are computed from the text, so they are stored with a case before any of its text is withheld.
    for (const index of new Set(entries.map((e) => Number(e.pointer.split("/")[2])))) {
      const item = root.cases[index];
      if (item && item.derived === undefined) item.derived = { hazards: caseHazards(item) };
    }
  }
  const pointers = entries.map((e) => e.pointer);
  const before = await maskedDigest(root, pointers);
  applyWithheld(root, entries);
  const after = await maskedDigest(root, pointers);
  if (before !== after) throw new Error(`RESIDUAL_REDACTION_CHANGED_OTHER_CONTENT:${name}`);
  console.log(`${name}: withheld=${entries.length} longest=${Math.max(0, ...entries.map((e) => e.longestRun))}`);
  if (entries.length > 0) record[name] = { minRun, withheld: entries, maskedContentSha256: after };
  if (!dryRun && entries.length > 0) await Deno.writeTextFile(new URL(name, dir), JSON.stringify(root, null, 2) + "\n");
}
if (!dryRun && recordPath) {
  await Deno.writeTextFile(
    recordPath,
    JSON.stringify(
      {
        version: 1,
        note: "Pointers, lengths and SHA-256 of withheld strings only; no text. maskedContentSha256 is the digest of the file with those pointers blanked, equal before and after withholding.",
        files: record,
      },
      null,
      2,
    ) + "\n",
  );
}
