// Derives the rights-safe fixture file and the body manifest from a PRIVATE cases file that still holds third-party bodies
// (the old PR #115 cases.json, kept outside Git; it is not in this repository). The input is never modified.
//   deno run --no-config --allow-read --allow-write=tools/provider-compare/fixtures \
//     tools/provider-compare/scripts/build_rights_safe_fixtures.ts --input <private cases.json>
// cases.rights_safe.json is that file with every body that src/body_policy.ts does not allow replaced by null, and the
// headline of such a case replaced by a placeholder (its length and SHA-256 go to the manifest).
// cases_body_manifest.json says, per case, the rights state and the SHA-256 of the sanitised body, so that a body
// re-read at run time can be accepted or refused (src/fixture_access.ts). Deterministic: same input, same files.
import type { CasesFile } from "../src/fixtures.ts";
import { manifestFor, stripUnconfirmedBodies } from "../src/fixture_access.ts";

export async function buildRightsSafe(file: CasesFile, generatedFrom: string) {
  const safe: CasesFile = { ...file, cases: stripUnconfirmedBodies(file.cases) };
  const manifest = await manifestFor(file.cases, generatedFrom);
  return { safe, manifest };
}

if (import.meta.main) {
  const dir = new URL("../fixtures/", import.meta.url);
  const at = Deno.args.indexOf("--input");
  const input = at >= 0 ? Deno.args[at + 1] : undefined;
  if (!input) throw new Error("--input <private cases.json> is required: no file with third-party bodies is shipped");
  const source = JSON.parse(await Deno.readTextFile(input)) as CasesFile;
  const { safe, manifest } = await buildRightsSafe(source, "private cases file (the PR #115 cases.json; not in this repository)");
  await Deno.writeTextFile(new URL("cases.rights_safe.json", dir), JSON.stringify(safe, null, 2) + "\n");
  await Deno.writeTextFile(new URL("cases_body_manifest.json", dir), JSON.stringify(manifest, null, 2) + "\n");
  const counts: Record<string, number> = {};
  for (const e of manifest.entries) counts[e.rightsState] = (counts[e.rightsState] ?? 0) + 1;
  console.log(JSON.stringify({ cases: safe.cases.length, rightsStates: counts }));
}
