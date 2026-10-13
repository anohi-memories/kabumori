// External-send gate: the single place that decides whether a case may leave this machine for a vendor endpoint
// (Anthropic / OpenAI request, count_tokens, models list).
//
// Reading a body locally is NOT permission to send it. In particular:
//   * a SHA-256 match (src/fixture_access.ts) proves the exported text is the text the manifest describes, nothing more;
//   * the operator's own opt-in (--runtime-bodies, PROVIDER_COMPARE_ALLOW_PAID) is not a licence either.
// A case whose rights state is `rights_unconfirmed` is sendable only when the licence register holds an explicit,
// auditable `licence_confirmed` record for that exact body, provider and payload. The shipped register is empty, so
// nothing from TDnet / BBC / Al Jazeera / AP can be sent. Everything unknown fails closed.
//
// This file is pure: no network, no subprocess, no file access (the loader reads the register and hands it in).
import type { CaseFixture } from "./fixtures.ts";
import { type BodyManifest, isWithheldTitle, type ManifestEntry } from "./fixture_access.ts";
import type { NeutralRequest, Provider, ProviderResult } from "./types.ts";
import { bodyMayBeStored } from "./body_policy.ts";
import { ZERO_USAGE } from "./types.ts";

export type SendProvider = "anthropic" | "openai";

export const LICENCE_SCOPE = "external_provider_send" as const;

/** Everything a request can carry that may quote the publisher; a licence has to name all of it. */
export const REQUIRED_COVERAGE = ["title", "body", "recorded_text"] as const;
/** A case without a body still sends its headline and the stored post; from a host with unconfirmed terms that needs a licence too. */
export const REQUIRED_COVERAGE_NO_BODY = ["title", "recorded_text"] as const;

export type LicenceState = "licence_confirmed" | "denied";

export type LicenceRecord = {
  caseId: string;
  state: LicenceState;
  scope: typeof LICENCE_SCOPE;
  /** The body the licence was granted for (sanitised-body SHA-256, the manifest's bodySha256); null for a case that has no body. */
  bodySha256: string | null;
  /** Vendors the licence allows. */
  providers: SendProvider[];
  /** Parts of the request payload the licence covers; must include title, body and recorded_text. */
  covers: string[];
  /** Where the confirmation can be checked (contract id, terms URL + retrieval date, written reply, ...). */
  evidenceRef: string;
  confirmedBy: string;
  /** YYYY-MM-DD */
  confirmedOn: string;
  /** YYYY-MM-DD; absent = no expiry. */
  expiresOn?: string;
  note?: string;
};

export type LicenceRegister = {
  version: 1;
  note: string;
  entries: LicenceRecord[];
};

export type SendCode =
  | "allowed_no_body"
  | "allowed_open_terms"
  | "allowed_licence_confirmed"
  | "blocked_legacy_fixtures"
  | "blocked_provenance_unknown"
  | "blocked_rights_unconfirmed_no_licence"
  | "blocked_licence_denied"
  | "blocked_licence_hash_mismatch"
  | "blocked_licence_provider"
  | "blocked_licence_scope"
  | "blocked_licence_expired"
  | "blocked_licence_not_yet_valid";

export type SendDecision = {
  caseId: string;
  allowed: boolean;
  code: SendCode;
  reason: string;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA256 = /^[0-9a-f]{64}$/;

/** Structural validation of a register read from disk. Throws (fail closed, loud) on anything malformed. */
export function parseLicenceRegister(raw: unknown): LicenceRegister {
  const fail = (why: string): never => {
    throw new Error(`LICENCE_REGISTER_INVALID: ${why}`);
  };
  if (typeof raw !== "object" || raw === null) return fail("not an object");
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) return fail("version must be 1");
  if (!Array.isArray(obj.entries)) return fail("entries must be an array");
  const entries: LicenceRecord[] = [];
  for (const [index, item] of obj.entries.entries()) {
    if (typeof item !== "object" || item === null) return fail(`entries[${index}] is not an object`);
    const e = item as Record<string, unknown>;
    const str = (key: string): string => {
      const v = e[key];
      if (typeof v !== "string" || v.trim().length === 0) return fail(`entries[${index}].${key} must be a non-empty string`);
      return v;
    };
    const state = str("state");
    if (state !== "licence_confirmed" && state !== "denied") return fail(`entries[${index}].state is unknown`);
    if (e.scope !== LICENCE_SCOPE) return fail(`entries[${index}].scope must be ${LICENCE_SCOPE}`);
    const bodySha256 = e.bodySha256 === null ? null : str("bodySha256");
    if (bodySha256 !== null && !SHA256.test(bodySha256)) return fail(`entries[${index}].bodySha256 must be 64 hex chars or null`);
    if (!Array.isArray(e.providers) || e.providers.some((p) => p !== "anthropic" && p !== "openai")) {
      return fail(`entries[${index}].providers must list anthropic and/or openai`);
    }
    if (!Array.isArray(e.covers) || e.covers.some((c) => typeof c !== "string")) {
      return fail(`entries[${index}].covers must be a string array`);
    }
    const confirmedOn = str("confirmedOn");
    if (!ISO_DATE.test(confirmedOn)) return fail(`entries[${index}].confirmedOn must be YYYY-MM-DD`);
    const expiresOn = e.expiresOn;
    if (expiresOn !== undefined && (typeof expiresOn !== "string" || !ISO_DATE.test(expiresOn))) {
      return fail(`entries[${index}].expiresOn must be YYYY-MM-DD`);
    }
    entries.push({
      caseId: str("caseId"),
      state,
      scope: LICENCE_SCOPE,
      bodySha256,
      providers: e.providers as SendProvider[],
      covers: e.covers as string[],
      evidenceRef: str("evidenceRef"),
      confirmedBy: str("confirmedBy"),
      confirmedOn,
      ...(typeof expiresOn === "string" ? { expiresOn } : {}),
      ...(typeof e.note === "string" ? { note: e.note } : {}),
    });
  }
  return { version: 1, note: typeof obj.note === "string" ? obj.note : "", entries };
}

export const EMPTY_LICENCE_REGISTER: LicenceRegister = { version: 1, note: "no licence confirmed", entries: [] };

export type Provenance = "stored_open_terms" | "attached_verified" | "no_body";

export type SendInput = {
  /** How the fixtures were loaded; "legacy" never sends anything. */
  fixtureMode: "legacy" | "rights_safe";
  cases: readonly CaseFixture[];
  /** From Resolution.provenance; a case missing here is of unknown origin and is blocked. */
  provenance: Readonly<Record<string, string>>;
  manifest: BodyManifest | null;
  licences: LicenceRegister;
  /** Every vendor the run will contact; a licence must name all of them. */
  providers: readonly SendProvider[];
  /** YYYY-MM-DD, injected so the decision is deterministic. */
  today: string;
};

function decideLicence(
  caseId: string,
  entry: ManifestEntry,
  input: SendInput,
  required: readonly string[],
): SendDecision {
  const block = (code: SendCode, reason: string): SendDecision => ({ caseId, allowed: false, code, reason });
  const records = input.licences.entries.filter((r) => r.caseId === caseId);
  const label = `${entry.sourceName}${entry.host ? ` (${entry.host})` : ""}`;
  if (records.some((r) => r.state === "denied")) {
    return block("blocked_licence_denied", `${label}: an explicit denial is recorded; it overrides any confirmation`);
  }
  const confirmed = records.filter((r) => r.state === "licence_confirmed");
  if (confirmed.length === 0) {
    return block(
      "blocked_rights_unconfirmed_no_licence",
      `${label}: reuse terms unconfirmed and no licence record; a hash match or an operator opt-in is not a licence`,
    );
  }
  // One valid record is enough; report the most informative failure when none is.
  let last: SendDecision | null = null;
  for (const r of confirmed) {
    if (r.bodySha256 !== entry.bodySha256) {
      last = block("blocked_licence_hash_mismatch", `${label}: the licence was granted for a different body`);
      continue;
    }
    const missingProvider = input.providers.filter((p) => !r.providers.includes(p));
    if (input.providers.length === 0 || missingProvider.length > 0) {
      last = block("blocked_licence_provider", `${label}: the licence does not name provider(s) ${missingProvider.join(",") || "(none given)"}`);
      continue;
    }
    const missingCover = required.filter((c) => !r.covers.includes(c));
    if (missingCover.length > 0) {
      last = block("blocked_licence_scope", `${label}: the licence does not cover ${missingCover.join(",")}`);
      continue;
    }
    if (r.confirmedOn > input.today) {
      last = block("blocked_licence_not_yet_valid", `${label}: confirmedOn is in the future`);
      continue;
    }
    if (r.expiresOn !== undefined && r.expiresOn < input.today) {
      last = block("blocked_licence_expired", `${label}: the licence expired on ${r.expiresOn}`);
      continue;
    }
    return { caseId, allowed: true, code: "allowed_licence_confirmed", reason: `${label}: licence confirmed by ${r.confirmedBy} on ${r.confirmedOn} (${r.evidenceRef})` };
  }
  return last as SendDecision;
}

export function decideExternalSend(item: CaseFixture, input: SendInput): SendDecision {
  const caseId = item.caseId;
  const block = (code: SendCode, reason: string): SendDecision => ({ caseId, allowed: false, code, reason });
  if (input.fixtureMode === "legacy") {
    return block("blocked_legacy_fixtures", "legacy fixtures hold third-party bodies and carry no per-case rights state");
  }
  const entry = input.manifest?.entries.find((e) => e.caseId === caseId);
  const provenance = input.provenance[caseId];
  if (!entry || provenance === undefined) {
    return block("blocked_provenance_unknown", "the case has no manifest entry or no recorded origin for its body");
  }
  if (provenance === "no_body" && entry.rightsState === "no_body") {
    // No body, but the headline and the stored post still travel and may quote the publisher.
    if (bodyMayBeStored(item.candidate.sourceUrl)) {
      return { caseId, allowed: true, code: "allowed_no_body", reason: "the case has no body and its host terms allow reuse" };
    }
    return decideLicence(caseId, entry, input, REQUIRED_COVERAGE_NO_BODY);
  }
  if (provenance === "stored_open_terms" && entry.rightsState === "open_terms") {
    return { caseId, allowed: true, code: "allowed_open_terms", reason: `${entry.sourceName}: host terms allow reuse` };
  }
  if (provenance === "attached_verified" && entry.rightsState === "rights_unconfirmed") {
    return decideLicence(caseId, entry, input, REQUIRED_COVERAGE);
  }
  return block("blocked_provenance_unknown", `provenance ${provenance} does not match rights state ${entry.rightsState}`);
}

export type SendPlan = {
  decisions: SendDecision[];
  allowedCases: CaseFixture[];
  allowedIds: ReadonlySet<string>;
  blocked: SendDecision[];
  /** Sanitised text of every ready case that is NOT sendable: used to catch a payload that carries one anyway. */
  blockedBodies: string[];
  counts: Record<string, number>;
};

export function planExternalSend(input: SendInput): SendPlan {
  const decisions: SendDecision[] = [];
  const allowedCases: CaseFixture[] = [];
  const blockedBodies: string[] = [];
  const counts: Record<string, number> = {};
  for (const item of input.cases) {
    const decision = decideExternalSend(item, input);
    decisions.push(decision);
    counts[decision.code] = (counts[decision.code] ?? 0) + 1;
    if (decision.allowed) {
      allowedCases.push(item);
    } else {
      const body = item.candidate.bodySummary;
      if (body !== null && body.length > 0) blockedBodies.push(body);
      // A headline re-attached from a local export is withheld text too (the committed placeholder is not).
      const title = item.candidate.title;
      if (title.length > 0 && !isWithheldTitle(title)) blockedBodies.push(title);
    }
  }
  return {
    decisions,
    allowedCases,
    allowedIds: new Set(allowedCases.map((c) => c.caseId)),
    blocked: decisions.filter((d) => !d.allowed),
    blockedBodies,
    counts,
  };
}

/** What leaves the machine per case: sizes only, so the plan can be reviewed without printing any text. */
export function describePayloadScope(item: CaseFixture): { caseId: string; titleChars: number; bodyChars: number; recordedTextChars: number } {
  return {
    caseId: item.caseId,
    titleChars: item.candidate.title.length,
    bodyChars: item.candidate.bodySummary?.length ?? 0,
    recordedTextChars: item.recorded.generation?.text?.length ?? 0,
  };
}

const WINDOW = 50;

/** Probes at the start, middle and end of a body; a request that carries any of them carries (part of) that body. */
function windowsOf(body: string): string[] {
  if (body.length <= WINDOW) return body.length >= 20 ? [body] : [];
  const mid = Math.floor((body.length - WINDOW) / 2);
  return [body.slice(0, WINDOW), body.slice(mid, mid + WINDOW), body.slice(body.length - WINDOW)];
}

/** null = the request may be sent; otherwise the reason it must not be. Web-search requests carry no fixture content. */
export function checkRequestSendable(request: NeutralRequest, plan: SendPlan): string | null {
  if (request.taskId === "web_search") return null;
  if (!plan.allowedIds.has(request.caseId)) return `case ${request.caseId} is not cleared for external send`;
  const text = `${request.system}\n${request.user}`;
  for (const body of plan.blockedBodies) {
    if (windowsOf(body).some((w) => text.includes(w))) return `payload for ${request.caseId} carries text of a case that is not cleared`;
  }
  return null;
}

export function assertRequestsSendable(requests: readonly NeutralRequest[], plan: SendPlan): void {
  for (const request of requests) {
    const why = checkRequestSendable(request, plan);
    if (why !== null) throw new Error(`EXTERNAL_SEND_BLOCKED: ${why}`);
  }
}

/** Wraps a provider so that a request which is not cleared is answered locally and never reaches the inner provider. */
export function guardProvider(inner: Provider, plan: SendPlan): Provider {
  return {
    name: inner.name,
    model: inner.model,
    label: inner.label,
    run(request, context) {
      const why = checkRequestSendable(request, plan);
      if (why === null) return inner.run(request, context);
      const result: ProviderResult = {
        provider: inner.name,
        model: inner.model,
        label: inner.label,
        ok: false,
        text: null,
        parsed: null,
        parseError: null,
        usage: { ...ZERO_USAGE },
        costUsd: 0,
        latencyMs: 0,
        stopReason: null,
        attempts: 0,
        sourceUrls: [],
        error: { code: "EXTERNAL_SEND_BLOCKED", status: null, retryable: false, message: why },
      };
      return Promise.resolve(result);
    },
  };
}
