// Withholds source-derived text from the committed evaluation datasets (see src/eval_redaction.ts).
//
//   apply (rewrites the two fixture files in place; idempotent):
//     deno run --no-config --allow-read --allow-write=tools/provider-compare/fixtures \
//       tools/provider-compare/scripts/redact_eval_fixtures.ts
//   verify against a LOCAL export (read-only; nothing is written, no text is printed):
//     deno run --no-config --allow-read tools/provider-compare/scripts/redact_eval_fixtures.ts --verify <rows.jsonl>
//   Rows carry `id`, `title` and optionally `generated_text` (scripts/export_cases.sql shape).
import {
  contentDigest,
  hostClassOf,
  redactEvalExpansion,
  redactNopostSample,
  verifyAgainstRows,
} from "../src/eval_redaction.ts";
import { caseHazards, hazardCoverage } from "./eval_set_report.ts";

const dir = new URL("../fixtures/", import.meta.url);
const read = async (name: string) => JSON.parse(await Deno.readTextFile(new URL(name, dir)));

const at = Deno.args.indexOf("--verify");
if (at >= 0) {
  const path = Deno.args[at + 1];
  if (!path) throw new Error("--verify needs a JSON-lines file");
  const rows = (await Deno.readTextFile(path)).split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l) as Record<string, unknown>);
  for (const name of ["eval_expansion.json", "eval_nopost_sample.json"]) {
    const result = await verifyAgainstRows(await read(name), rows);
    const brief = (b: typeof result.titles) => `${b.matched}/${b.checked} match, ${b.mismatched.length} differ, ${b.missing.length} not in export`;
    console.log(`${name}: titles ${brief(result.titles)}; posts ${brief(result.posts)}`);
  }
} else {
  // --record <path> also writes counts and content digests (before / after) as a small JSON record (no source text).
  const recordAt = Deno.args.indexOf("--record");
  const recordPath = recordAt >= 0 ? Deno.args[recordAt + 1] : undefined;
  const record: Record<string, unknown> = {};
  for (const name of ["eval_expansion.json", "eval_nopost_sample.json"] as const) {
    const file = await read(name);
    const expansion = name === "eval_expansion.json";
    // Coverage is computed from the text, so it is measured BEFORE the text is withheld and stored with the case (`derived`).
    const coverageBefore = expansion ? hazardCoverage(file.cases) : null;
    const redact = expansion
      ? (f: typeof file) => redactEvalExpansion(f, (item) => ({ hazards: caseHazards(item as never) }))
      : (f: typeof file) => redactNopostSample(f);
    const before = await contentDigest(file);
    const withheldBefore = file.cases.filter((c: Record<string, unknown>) => typeof (c.candidate as Record<string, unknown> | undefined)?.titleSha256 === "string" || typeof c.titleSha256 === "string").length;
    const stats = await redact(file);
    const after = await contentDigest(file);
    if (before !== after) throw new Error(`REDACTION_CHANGED_CONTENT:${name}`);
    const byClass: Record<string, number> = {};
    for (const c of file.cases) {
      const holder = (c.candidate ?? c) as Record<string, unknown>;
      if (typeof holder.titleSha256 === "string") byClass[hostClassOf(String(holder.sourceUrl ?? c.sourceUrl))] = (byClass[hostClassOf(String(holder.sourceUrl ?? c.sourceUrl))] ?? 0) + 1;
    }
    await Deno.writeTextFile(new URL(name, dir), JSON.stringify(file, null, 2) + "\n");
    console.log(`${name}: ${JSON.stringify(stats)}`);
    if (expansion && JSON.stringify(hazardCoverage(file.cases)) !== JSON.stringify(coverageBefore)) {
      throw new Error("REDACTION_CHANGED_HAZARD_COVERAGE");
    }
    record[name] = { cases: stats.cases, contentSha256: before, hazardCoverage: coverageBefore, titlesWithheld: stats.titlesWithheld + stats.alreadyRedacted, titlesKept: stats.titlesKept, postsWithheld: stats.postsWithheld, withheldTitlesByHostClass: byClass, withheldBeforeThisRun: withheldBefore };
  }
  if (recordPath) await Deno.writeTextFile(recordPath, JSON.stringify({ version: 1, note: "Counts and content digests only; no source text. contentSha256 is the digest of each dataset with title / generated-post keys removed, measured before redaction and re-checked after.", files: record }, null, 2) + "\n");
}
