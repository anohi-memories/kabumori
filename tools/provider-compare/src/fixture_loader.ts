// Loads the fixture cases a run may use. "legacy" is cases.json as PR #115 shipped it (it still holds third-party bodies);
// "rights_safe" is cases.rights_safe.json plus the body manifest, with bodies attached only from a local export the operator
// names, and every case that cannot be attached listed as excluded.
import { loadCases, type CaseFixture } from "./fixtures.ts";
import {
  type BodyManifest,
  type Exclusion,
  resolveRunnableCases,
  runtimeBodiesFromRows,
  summariseExclusions,
} from "./fixture_access.ts";

export type FixtureMode = "legacy" | "rights_safe";

export type LoadedCases = {
  mode: FixtureMode;
  cases: CaseFixture[];
  excluded: Exclusion[];
  provenance: Record<string, string>;
  summary: ReturnType<typeof summariseExclusions>;
  warning: string | null;
};

export async function readJsonLines(path: string): Promise<Array<Record<string, unknown>>> {
  const text = await Deno.readTextFile(path);
  return text.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, unknown>);
}

export async function loadRunnableCases(options: { fixtures: FixtureMode; runtimeBodiesPath?: string }): Promise<LoadedCases> {
  if (options.fixtures === "legacy") {
    return {
      mode: "legacy",
      cases: await loadCases(),
      excluded: [],
      provenance: {},
      summary: summariseExclusions([]),
      warning: "legacy fixtures hold third-party bodies (TDnet, BBC, Al Jazeera, AP); use --fixtures rights_safe",
    };
  }
  const dir = new URL("../fixtures/", import.meta.url);
  const cases = await loadCases(new URL("cases.rights_safe.json", dir));
  const manifest = JSON.parse(await Deno.readTextFile(new URL("cases_body_manifest.json", dir))) as BodyManifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.entries)) throw new Error("BODY_MANIFEST_INVALID");
  const runtimeBodies = options.runtimeBodiesPath ? runtimeBodiesFromRows(await readJsonLines(options.runtimeBodiesPath)) : null;
  const resolved = await resolveRunnableCases(cases, manifest, { runtimeBodies });
  return {
    mode: "rights_safe",
    cases: resolved.ready,
    excluded: resolved.excluded,
    provenance: resolved.provenance,
    summary: summariseExclusions(resolved.excluded),
    warning: null,
  };
}
