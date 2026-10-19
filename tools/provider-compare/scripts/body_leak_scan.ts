// Owner-run check that none of the third-party bodies in a PRIVATE cases file survive inside a tree that is about to be
// published. The private file is read only; nothing is written; no text is printed (file, JSON path, case key, counts).
//
//   deno run --no-config --allow-read tools/provider-compare/scripts/body_leak_scan.ts \
//     --legacy-file <private cases.json> --root tools --root docs [--window 40]
//
// Exit code 1 when a window of a body is found outside a headline (`title`) field. Overlap inside headline fields is
// listed separately: disclosure titles are the first line of a TDnet body, and keeping a headline next to its URL is the
// evaluation set's documented policy (src/body_policy.ts), so that overlap is reported, not failed.
import { bodyMayBeStored } from "../src/body_policy.ts";
import { buildIndex, scanJson, scanText } from "../src/body_leak_scan.ts";
import type { CasesFile } from "../src/fixtures.ts";

const arg = (name: string): string | undefined => {
  const at = Deno.args.indexOf(name);
  return at >= 0 ? Deno.args[at + 1] : undefined;
};
const roots = Deno.args.flatMap((a, i) => (a === "--root" ? [Deno.args[i + 1]] : []));
const legacy = arg("--legacy-file");
if (!legacy || roots.length === 0) throw new Error("usage: --legacy-file <private cases.json> --root <dir> [--root <dir>] [--window 40]");
const windowChars = Number(arg("--window") ?? "40");

const file = JSON.parse(await Deno.readTextFile(legacy)) as CasesFile;
const bodies = new Map<string, string>();
for (const item of file.cases) {
  const body = item.candidate.bodySummary;
  if (body && !bodyMayBeStored(item.candidate.sourceUrl)) bodies.set(item.caseId.slice(-8), body);
}
const index = buildIndex(bodies, windowChars);
console.log(`bodies=${bodies.size} windows=${index.size} windowChars=${windowChars}`);

const TEXT = /\.(json|ts|md|sql|txt)$/;
async function* walk(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) yield* walk(path);
    else if (TEXT.test(entry.name)) yield path;
  }
}

let failures = 0;
let headline = 0;
for (const root of roots) {
  for await (const path of walk(root)) {
    const text = await Deno.readTextFile(path);
    let hits;
    if (path.endsWith(".json")) {
      try {
        hits = scanJson(JSON.parse(text), index, windowChars);
      } catch {
        hits = scanText(text, index, windowChars);
      }
    } else {
      hits = scanText(text, index, windowChars);
    }
    for (const hit of hits) {
      const isHeadline = /\.title$/.test(hit.path);
      if (isHeadline) headline += 1;
      else failures += 1;
      console.log(`${isHeadline ? "headline" : "BODY"} ${path} ${hit.path} case=${hit.caseKey} covered=${hit.covered}/${hit.total}`);
    }
  }
}
console.log(`body_hits=${failures} headline_hits=${headline}`);
if (failures > 0) Deno.exit(1);
