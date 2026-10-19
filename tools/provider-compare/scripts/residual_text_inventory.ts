// Owner-run, read-only: how much of the texts that REMAIN in the committed datasets repeats a known third-party text.
//
//   deno run --no-config --allow-read tools/provider-compare/scripts/residual_text_inventory.ts \
//     --legacy-file <private cases.json> [--rows <export.jsonl>]
//
// References come from files you hold locally: bodies and headlines of the private legacy file, and (optionally) the
// `title` column of a production export for the withheld headlines. Targets are the retained judgement reasons, the
// stored posts of the original 22 cases and the labeller's notes. Output is counts only; no text is printed.
import { bodyMayBeStored } from "../src/body_policy.ts";
import { type ReferenceText, summariseOverlap } from "../src/residual_text_report.ts";

const arg = (name: string): string | undefined => {
  const at = Deno.args.indexOf(name);
  return at >= 0 ? Deno.args[at + 1] : undefined;
};
const legacyPath = arg("--legacy-file");
if (!legacyPath) throw new Error("usage: --legacy-file <private cases.json> [--rows <export.jsonl>]");

const dir = new URL("../fixtures/", import.meta.url);
const readJson = async (url: URL | string) => JSON.parse(await Deno.readTextFile(url));

const references: ReferenceText[] = [];
for (const c of (await readJson(legacyPath)).cases) {
  const cand = c.candidate;
  if (bodyMayBeStored(cand.sourceUrl)) continue;
  if (cand.bodySummary) references.push({ key: `body:${c.caseId.slice(-8)}`, text: cand.bodySummary });
  references.push({ key: `title:${c.caseId.slice(-8)}`, text: cand.title });
}
const rowsPath = arg("--rows");
if (rowsPath) {
  for (const line of (await Deno.readTextFile(rowsPath)).split("\n")) {
    if (!line.startsWith("{")) continue;
    const row = JSON.parse(line) as { id?: string; title?: string };
    if (typeof row.id === "string" && typeof row.title === "string") references.push({ key: `title:${row.id.slice(0, 8)}`, text: row.title });
  }
}
console.log(`references=${references.length}`);

const originals = (await readJson(new URL("cases.rights_safe.json", dir))).cases as unknown[];
const expansion = (await readJson(new URL("eval_expansion.json", dir))).cases as unknown[];
const nopost = (await readJson(new URL("eval_nopost_sample.json", dir))).cases as unknown[];
const strings = (items: unknown[]) => items.filter((x): x is string => typeof x === "string" && x.length > 0);
/** Follows a path of object keys; undefined when any step is missing. */
const get = (value: unknown, ...keys: string[]): unknown => {
  let current = value;
  for (const key of keys) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
};
const notes = (item: unknown): unknown[] => {
  const facts = get(item, "label", "keyFacts");
  return [...(Array.isArray(facts) ? facts : []), get(item, "label", "rationale")];
};

const rows = [
  summariseOverlap("eval_expansion judgement.reason", strings(expansion.map((c) => get(c, "recorded", "judgement", "reason"))), references),
  summariseOverlap("eval_nopost reason", strings(nopost.map((c) => get(c, "recorded", "reason"))), references),
  summariseOverlap("original 22 judgement.reason", strings(originals.map((c) => get(c, "recorded", "judgement", "reason"))), references),
  summariseOverlap("original 22 stored posts", strings(originals.map((c) => get(c, "recorded", "generation", "text"))), references),
  summariseOverlap("labeller keyFacts + rationale", strings([...expansion, ...nopost].flatMap(notes)), references),
];
for (const r of rows) {
  console.log(`${r.name}: texts=${r.texts} >=20=${r.withRun[20]} >=30=${r.withRun[30]} >=40=${r.withRun[40]} longest=${r.longestRun} top=${JSON.stringify(r.top)}`);
}
