// Fail-closed access to fixture bodies.
//
// A fixture case carries a stored body only when the publisher's terms allow reuse (src/body_policy.ts). For every other
// case the body is not part of the repository: the case carries its length and SHA-256, and the body may be attached at
// run time from a LOCAL export of production (read-only, never committed) after the operator opts in. Whatever cannot be
// attached is excluded from the run and recorded with a reason; it is never run with an empty input, and nothing here can
// reach the network, so a refused source (TDnet answers 403) cannot be worked around from this code.
import type { CaseFixture } from "./fixtures.ts";
import { bodyMayBeStored, hostOf } from "./body_policy.ts";
import { sanitizeBody } from "./sanitize.ts";

export type RightsState =
  | "open_terms"          // the host's published terms allow reuse; the body may stay in the repository
  | "rights_unconfirmed"  // TDnet, BBC, Al Jazeera, AP: no confirmed permission to store or redistribute the body
  | "no_body";            // the case never had a body

export type ManifestEntry = {
  caseId: string;
  sourceName: string;
  host: string | null;
  rightsState: RightsState;
  bodyChars: number;
  /** SHA-256 of the sanitised body the fixture carried; null when there was no body. */
  bodySha256: string | null;
};

export type BodyManifest = {
  version: 1;
  generatedFrom: string;
  note: string;
  entries: ManifestEntry[];
};

export type ExclusionState =
  | "needs_rights_review"       // no opt-in: the body is not attached, the case is not run
  | "body_source_missing"       // opted in, but the local export has no row for this case
  | "body_hash_mismatch"        // opted in, the row differs from the body the manifest describes
  | "manifest_entry_missing";   // the case is not described by the manifest at all

export type Exclusion = { caseId: string; state: ExclusionState; reason: string };

export type Resolution = {
  ready: CaseFixture[];
  excluded: Exclusion[];
  /** How each ready case got its body. */
  provenance: Record<string, "stored_open_terms" | "attached_verified" | "no_body">;
};

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function rightsStateOf(sourceUrl: string, hasBody: boolean): RightsState {
  if (!hasBody) return "no_body";
  return bodyMayBeStored(sourceUrl) ? "open_terms" : "rights_unconfirmed";
}

export async function manifestFor(cases: readonly CaseFixture[], generatedFrom: string): Promise<BodyManifest> {
  const entries: ManifestEntry[] = [];
  for (const item of cases) {
    const body = item.candidate.bodySummary;
    const hasBody = body !== null && body.length > 0;
    entries.push({
      caseId: item.caseId,
      sourceName: item.candidate.sourceName,
      host: hostOf(item.candidate.sourceUrl),
      rightsState: rightsStateOf(item.candidate.sourceUrl, hasBody),
      bodyChars: hasBody ? body.length : 0,
      bodySha256: hasBody ? await sha256Hex(body) : null,
    });
  }
  return {
    version: 1,
    generatedFrom,
    note: "Per-case body rights state and fingerprint. A body listed as rights_unconfirmed is not in the rights-safe fixture file; it is re-read at run time and accepted only when its sanitised SHA-256 equals bodySha256.",
    entries,
  };
}

/** The same cases with every body that may not be stored replaced by null. Cases with open terms are returned untouched. */
export function stripUnconfirmedBodies(cases: readonly CaseFixture[]): CaseFixture[] {
  return cases.map((item) => {
    const body = item.candidate.bodySummary;
    if (body === null || body.length === 0 || bodyMayBeStored(item.candidate.sourceUrl)) return item;
    return { ...item, candidate: { ...item.candidate, bodySummary: null } };
  });
}

/** id8 -> body_summary, from the JSON-lines output of scripts/export_cases.sql (a local file; this reads nothing else). */
export function runtimeBodiesFromRows(rows: ReadonlyArray<Record<string, unknown>>): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of rows) {
    const id = typeof row.id === "string" ? row.id.slice(0, 8) : null;
    const body = typeof row.body_summary === "string" ? row.body_summary : null;
    if (id !== null && body !== null) out.set(id, body);
  }
  return out;
}

export type ResolveOptions = {
  /** null = the operator has not opted in: nothing is attached and every rights_unconfirmed case is excluded. */
  runtimeBodies: ReadonlyMap<string, string> | null;
};

export async function resolveRunnableCases(
  cases: readonly CaseFixture[],
  manifest: BodyManifest,
  options: ResolveOptions,
): Promise<Resolution> {
  const byId = new Map(manifest.entries.map((e) => [e.caseId, e]));
  const ready: CaseFixture[] = [];
  const excluded: Exclusion[] = [];
  const provenance: Resolution["provenance"] = {};
  for (const item of cases) {
    const entry = byId.get(item.caseId);
    if (!entry) {
      excluded.push({ caseId: item.caseId, state: "manifest_entry_missing", reason: "the body manifest does not describe this case" });
      continue;
    }
    if (entry.rightsState === "no_body") {
      ready.push({ ...item, candidate: { ...item.candidate, bodySummary: null } });
      provenance[item.caseId] = "no_body";
      continue;
    }
    if (entry.rightsState === "open_terms") {
      // The stored body must still be the one the manifest fingerprinted.
      const stored = item.candidate.bodySummary;
      if (stored !== null && (await sha256Hex(stored)) === entry.bodySha256) {
        ready.push(item);
        provenance[item.caseId] = "stored_open_terms";
      } else {
        excluded.push({ caseId: item.caseId, state: "body_hash_mismatch", reason: "the stored open-terms body differs from the manifest" });
      }
      continue;
    }
    // rights_unconfirmed: whatever the fixture file holds is never used as input.
    if (options.runtimeBodies === null) {
      excluded.push({
        caseId: item.caseId,
        state: "needs_rights_review",
        reason: `${entry.sourceName}${entry.host ? ` (${entry.host})` : ""}: reuse terms unconfirmed; no runtime body source was provided`,
      });
      continue;
    }
    const raw = options.runtimeBodies.get(item.caseId.slice(-8));
    if (raw === undefined) {
      excluded.push({ caseId: item.caseId, state: "body_source_missing", reason: "the local export has no row for this case" });
      continue;
    }
    const sanitised = sanitizeBody(raw);
    if (sanitised === null || (await sha256Hex(sanitised)) !== entry.bodySha256) {
      excluded.push({ caseId: item.caseId, state: "body_hash_mismatch", reason: "the exported body differs from the fingerprinted one (production row changed)" });
      continue;
    }
    ready.push({ ...item, candidate: { ...item.candidate, bodySummary: sanitised } });
    provenance[item.caseId] = "attached_verified";
  }
  return { ready, excluded, provenance };
}

export function summariseExclusions(excluded: readonly Exclusion[]): Record<ExclusionState, number> {
  const out: Record<ExclusionState, number> = {
    needs_rights_review: 0, body_source_missing: 0, body_hash_mismatch: 0, manifest_entry_missing: 0,
  };
  for (const e of excluded) out[e.state] += 1;
  return out;
}
