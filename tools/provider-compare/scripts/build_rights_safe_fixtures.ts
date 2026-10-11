// Derives the rights-safe fixture file and the body manifest from fixtures/cases.json, without changing cases.json.
//   deno run --no-config --allow-read --allow-write=tools/provider-compare/fixtures tools/provider-compare/scripts/build_rights_safe_fixtures.ts
// cases.rights_safe.json is cases.json with every body that src/body_policy.ts does not allow replaced by null.
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
  const source = JSON.parse(await Deno.readTextFile(new URL("cases.json", dir))) as CasesFile;
  const { safe, manifest } = await buildRightsSafe(source, "fixtures/cases.json");
  await Deno.writeTextFile(new URL("cases.rights_safe.json", dir), JSON.stringify(safe, null, 2) + "\n");
  await Deno.writeTextFile(new URL("cases_body_manifest.json", dir), JSON.stringify(manifest, null, 2) + "\n");
  const counts: Record<string, number> = {};
  for (const e of manifest.entries) counts[e.rightsState] = (counts[e.rightsState] ?? 0) + 1;
  console.log(JSON.stringify({ cases: safe.cases.length, rightsStates: counts }));
}
