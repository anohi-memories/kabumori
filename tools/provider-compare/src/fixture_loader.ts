// Loads the fixture cases a run may use.
//
// "rights_safe" (the default and the only committed set) is cases.rights_safe.json plus the body manifest: bodies whose
// reuse terms are not confirmed are not in the repository, and are attached only from a local export the operator names;
// every case that cannot be attached is listed as excluded.
//
// "legacy" is a PRIVATE file that still holds third-party bodies (the PR #115 cases.json, kept outside Git). Nothing is
// shipped for it and nothing falls back to one: it is read only when its path is named with --legacy-file, it is for
// offline local use, and it is never cleared for external send.
//
// Loading is LOCAL ONLY. A case that is loaded (or attached from a runtime export) is not thereby cleared to be sent to a
// vendor: that is decided separately by src/external_send_gate.ts from the licence register this loader reads.
import { loadCases, type CaseFixture } from "./fixtures.ts";
import {
  type BodyManifest,
  type Exclusion,
  resolveRunnableCases,
  runtimeBodiesFromRows,
  summariseExclusions,
} from "./fixture_access.ts";
import { EMPTY_LICENCE_REGISTER, type LicenceRegister, parseLicenceRegister } from "./external_send_gate.ts";

export type FixtureMode = "legacy" | "rights_safe";

export type LoadedCases = {
  mode: FixtureMode;
  cases: CaseFixture[];
  excluded: Exclusion[];
  provenance: Record<string, string>;
  summary: ReturnType<typeof summariseExclusions>;
  warning: string | null;
  /** null for legacy (it has no per-case rights state, so nothing in it can be cleared for external send). */
  manifest: BodyManifest | null;
  /** The explicit licence records; the shipped register is empty. */
  licences: LicenceRegister;
};

export async function readJsonLines(path: string): Promise<Array<Record<string, unknown>>> {
  const text = await Deno.readTextFile(path);
  return text.split("\n").filter((line) => line.startsWith("{")).map((line) => JSON.parse(line) as Record<string, unknown>);
}

const SHIPPED_FIXTURES = new URL("../fixtures/", import.meta.url);

/** An explicit directory is resolved against the working directory; nothing else is ever searched. */
function dirUrl(path: string | undefined): URL {
  if (path === undefined) return SHIPPED_FIXTURES;
  const withSlash = path.endsWith("/") ? path : `${path}/`;
  return new URL(withSlash, `file://${Deno.cwd()}/`);
}

export async function loadLicenceRegister(fixturesDir?: string): Promise<LicenceRegister> {
  return parseLicenceRegister(JSON.parse(await Deno.readTextFile(new URL("body_licences.json", dirUrl(fixturesDir)))));
}

export type LoadOptions = {
  fixtures: FixtureMode;
  /** Local JSON-lines export that attaches bodies for LOCAL use (attaching is not a licence to send). */
  runtimeBodiesPath?: string;
  /** Directory holding cases.rights_safe.json, cases_body_manifest.json and body_licences.json (default: the shipped fixtures). */
  fixturesDir?: string;
  /** Required for legacy: the private cases file that is kept outside Git. */
  legacyFile?: string;
};

export async function loadRunnableCases(options: LoadOptions): Promise<LoadedCases> {
  if (options.fixtures === "legacy") {
    if (!options.legacyFile) {
      throw new Error("LEGACY_FILE_REQUIRED: legacy fixtures are not shipped; name a private local file with --legacy-file");
    }
    return {
      mode: "legacy",
      cases: await loadCases(new URL(options.legacyFile, `file://${Deno.cwd()}/`)),
      excluded: [],
      provenance: {},
      summary: summariseExclusions([]),
      warning: "legacy fixtures hold third-party bodies (TDnet, BBC, Al Jazeera, AP); offline local use only, never sent externally; use --fixtures rights_safe",
      manifest: null,
      licences: EMPTY_LICENCE_REGISTER,
    };
  }
  const dir = dirUrl(options.fixturesDir);
  const cases = await loadCases(new URL("cases.rights_safe.json", dir));
  const manifest = JSON.parse(await Deno.readTextFile(new URL("cases_body_manifest.json", dir))) as BodyManifest;
  if (manifest.version !== 1 || !Array.isArray(manifest.entries)) throw new Error("BODY_MANIFEST_INVALID");
  const licences = await loadLicenceRegister(options.fixturesDir);
  const runtimeBodies = options.runtimeBodiesPath ? runtimeBodiesFromRows(await readJsonLines(options.runtimeBodiesPath)) : null;
  const resolved = await resolveRunnableCases(cases, manifest, { runtimeBodies });
  return {
    mode: "rights_safe",
    cases: resolved.ready,
    excluded: resolved.excluded,
    provenance: resolved.provenance,
    summary: summariseExclusions(resolved.excluded),
    warning: null,
    manifest,
    licences,
  };
}
