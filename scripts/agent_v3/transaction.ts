import { assertSafeRoot, assertWithinRoot, type ChangeSet, keyFields, type ListFiles, parseHeader, PlanError, type ReadFile, type SlotDef } from "./registry.ts";

// One registration = one commit. The backend builds a commit on an exact base and publishes it with a
// compare-and-swap (fast-forward only, never force). A stale base is re-planned from the new head a bounded
// number of times; a refusal is recorded and stops the run; success is reported only after the published ref
// reads back the expected fields. Writing to a non-main ref is never reported as registered.

// stale: the ref moved (or a concurrent update won the lock) -> re-plan on the new head.
// permission / refused / rejected: the server answered "no" explicitly -> the ref did not move.
// unknown: the request may have been applied (5xx, dropped connection, unparseable answer) -> never re-sent;
//          the ref is only *read* to find out.
export type PublishResult =
  | { ok: true }
  | { ok: false; kind: "stale" | "permission" | "refused" | "rejected" | "unknown"; detail: string };

export interface Backend {
  readonly name: string;
  head(ref: string): string;
  read(commit: string, path: string): string | null;
  list(commit: string, prefix: string): string[]; // paths under a directory prefix; [] only when nothing exists there
  changedPaths(base: string, commit: string): string[];
  commit(base: string, files: Map<string, string | null>, message: string): string;
  publish(ref: string, newCommit: string, expectedOld: string): PublishResult;
  contains(head: string, commit: string): boolean; // commit is head or an ancestor of head
}

// Thrown by a backend when the platform refuses the write itself (a policy or safety rejection, as opposed
// to an HTTP/git error). The transaction stops; the content is never re-encoded, split or retried.
export class RefusedError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "RefusedError";
  }
}

// Thrown when a request did not complete (no HTTP/git answer at all, e.g. a dropped connection). Whether the
// platform refused it or the network failed is not guessed; the run stops either way.
export class TransportError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "TransportError";
  }
}

// Thrown when an answer arrived but cannot be trusted (truncated body, blob SHA or size mismatch).
export class IntegrityError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "IntegrityError";
  }
}

export type OutcomeCode =
  | "REGISTERED_ON_MAIN"
  | "WRITTEN_TO_BRANCH_NOT_REGISTERED"
  | "CONFLICT_SAME_SLOT"
  | "PLAN_REFUSED"
  | "DESTINATION_REFUSED"
  | "STALE_BASE_RETRY_EXHAUSTED"
  | "REFUSED_STOPPED"
  | "TRANSPORT_FAILED_STOPPED"
  | "INTEGRITY_FAILED_STOPPED"
  | "ERROR_STOPPED"
  | "PERMISSION_DENIED"
  | "PUBLISH_REJECTED"
  | "PARTIAL_DETECTED"
  | "UNPLANNED_CHANGE_DETECTED"
  | "PUBLISHED_UNVERIFIED"
  | "SUPERSEDED_AFTER_PUBLISH"
  | "READBACK_MISMATCH";

export type Outcome = {
  code: OutcomeCode;
  registered: boolean;
  ref: string;
  attempts: number;
  base: string | null;
  commit: string | null;
  detail: string;
  readback?: Record<string, { expected: Record<string, string>; actual: Record<string, string> }>;
};

export const MAIN_REF = "refs/heads/main";
export const LIVE_TEST_REF = /^refs\/agent-v3-live-test\/[a-z0-9-]+$/;
export const MAX_ATTEMPTS_LIMIT = 5;

const TOKEN_PATTERNS: [RegExp, string][] = [
  [/\b(gh[pousr]_[A-Za-z0-9]{16,})/g, "[REDACTED]"],
  [/\bgithub_pat_[A-Za-z0-9_]{16,}/g, "[REDACTED]"],
  [/\b(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@"], // credentials embedded in a URL
  [/\b(x-access-token|oauth2|token)[:=]\s*[^\s@&]+/gi, "$1:[REDACTED]"],
  [/\b(authorization|proxy-authorization)\s*[:=]\s*\S+(\s+\S+)?/gi, "$1: [REDACTED]"],
  [/\bbearer\s+\S+/gi, "Bearer [REDACTED]"],
];

// Incident text is kept for the Report; anything that looks like a credential is masked first.
export function redact(text: string): string {
  return TOKEN_PATTERNS.reduce((t, [p, r]) => t.replace(p, r), text).slice(0, 2000);
}

function fail(code: OutcomeCode, ref: string, attempts: number, base: string | null, commit: string | null, detail: string): Outcome {
  return { code, registered: false, ref, attempts, base, commit, detail: redact(detail) };
}

export type Planner = (read: ReadFile, base: string, list: ListFiles) => ChangeSet;

export type TransactionOptions = {
  root: string; // every planned path must live under this V3 root
  allowMain?: boolean; // refs/heads/main is written only when the caller says so explicitly
  allowedRefs?: RegExp; // other refs that may be written (default: the live-test namespace only)
  maxAttempts?: number;
};

export function checkMaxAttempts(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_ATTEMPTS_LIMIT) {
    throw new RangeError(`maxAttempts must be an integer from 1 to ${MAX_ATTEMPTS_LIMIT}, got ${value}`);
  }
  return value;
}

export function refAllowed(ref: string, options: TransactionOptions): boolean {
  if (ref === MAIN_REF) return options.allowMain === true;
  return (options.allowedRefs ?? LIVE_TEST_REF).test(ref);
}

export function runTransaction(backend: Backend, defs: SlotDef[], ref: string, planner: Planner, options: TransactionOptions): Outcome {
  const maxAttempts = checkMaxAttempts(options.maxAttempts ?? 3);
  try {
    assertSafeRoot(options.root);
  } catch (e) {
    return fail("DESTINATION_REFUSED", ref, 0, null, null, (e as Error).message);
  }
  if (!refAllowed(ref, options)) return fail("DESTINATION_REFUSED", ref, 0, null, null, `ref ${ref} is not an allowed destination`);
  let base: string | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Errors before the publish request leave the ref untouched. Once the publish request has been sent,
    // an error means the ref may or may not have moved, so the result is PUBLISHED_UNVERIFIED, never a
    // claim either way.
    let sent = false;
    let commit: string | null = null;
    try {
      base = backend.head(ref);
      const at = base;
      const plan = planner((p) => backend.read(at, p), at, (prefix) => backend.list(at, prefix));
      assertWithinRoot(plan.files.keys(), options.root);
      commit = backend.commit(at, plan.files, plan.message);
      // The commit object must hold every planned file exactly, and nothing else may differ from the base.
      for (const [path, content] of plan.files) {
        if (backend.read(commit, path) !== content) {
          return fail("PARTIAL_DETECTED", ref, attempt, base, commit, `commit ${commit} does not contain the planned ${path}`);
        }
      }
      const extra = backend.changedPaths(at, commit).filter((p) => !plan.files.has(p));
      if (extra.length) {
        return fail("UNPLANNED_CHANGE_DETECTED", ref, attempt, base, commit, `commit ${commit} also changes ${extra.slice(0, 5).join(", ")}`);
      }
      sent = true;
      const published = backend.publish(ref, commit, at);
      if (!published.ok) {
        if (published.kind === "stale") continue; // someone else moved the ref: re-plan from the new head
        if (published.kind === "unknown") return resolveUnknown(backend, defs, ref, attempt, at, commit, plan, published.detail);
        const code = published.kind === "permission" ? "PERMISSION_DENIED" : published.kind === "refused" ? "REFUSED_STOPPED" : "PUBLISH_REJECTED";
        return fail(code, ref, attempt, base, commit, published.detail);
      }
      return readBack(backend, defs, ref, attempt, at, commit, plan);
    } catch (e) {
      if (e instanceof PlanError) {
        const code = e.kind === "same_slot_conflict" ? "CONFLICT_SAME_SLOT" : e.kind === "destination" ? "DESTINATION_REFUSED" : "PLAN_REFUSED";
        return fail(code, ref, attempt, base, null, e.message);
      }
      const detail = e instanceof Error ? e.message : String(e);
      if (sent) return fail("PUBLISHED_UNVERIFIED", ref, attempt, base, commit, `publish or read-back did not complete; check ${ref}: ${detail}`);
      if (e instanceof RefusedError) return fail("REFUSED_STOPPED", ref, attempt, base, commit, detail);
      if (e instanceof TransportError) return fail("TRANSPORT_FAILED_STOPPED", ref, attempt, base, commit, detail);
      if (e instanceof IntegrityError) return fail("INTEGRITY_FAILED_STOPPED", ref, attempt, base, commit, detail);
      return fail("ERROR_STOPPED", ref, attempt, base, commit, detail);
    }
  }
  return fail("STALE_BASE_RETRY_EXHAUSTED", ref, maxAttempts, base, null, `ref kept moving for ${maxAttempts} attempts`);
}

// The publish answer was lost or unclear. The request is not sent again; the ref is read once: if our commit
// is in its history the normal read-back decides, otherwise the result stays unverified.
function resolveUnknown(backend: Backend, defs: SlotDef[], ref: string, attempts: number, base: string, commit: string, plan: ChangeSet, why: string): Outcome {
  let head: string;
  try {
    head = backend.head(ref);
    if (!backend.contains(head, commit)) {
      return fail("PUBLISHED_UNVERIFIED", ref, attempts, base, commit, `publish answer unclear (${why}); ${ref} is ${head} and does not contain ${commit} yet`);
    }
  } catch (e) {
    return fail("PUBLISHED_UNVERIFIED", ref, attempts, base, commit, `publish answer unclear (${why}); checking ${ref} failed: ${(e as Error).message}`);
  }
  return readBack(backend, defs, ref, attempts, base, commit, plan);
}

// Read-back separates three facts: our own commit carries the planned state; the ref's history contains our
// commit; and the slot still reads that state at the ref's head. A later legitimate commit that changed the
// slot is SUPERSEDED_AFTER_PUBLISH (our write landed, but the slot no longer holds it), not a failed write.
// Any read that fails here is PUBLISHED_UNVERIFIED (the write was sent), never READBACK_MISMATCH.
function readBack(backend: Backend, defs: SlotDef[], ref: string, attempts: number, base: string, commit: string, plan: ChangeSet): Outcome {
  let head: string;
  const readback: Outcome["readback"] = {};
  let own = true;
  let current = true;
  try {
    head = backend.head(ref);
    for (const [slot, expected] of plan.expectations) {
      const def = defs.find((d) => d.slot === slot)!;
      const mine = keyFields(parseHeader(backend.read(commit, def.taskPath)));
      if (Object.keys(expected).some((k) => expected[k] !== mine[k])) own = false;
    }
    if (own && !backend.contains(head, commit)) {
      return fail("READBACK_MISMATCH", ref, attempts, base, commit, `${commit} is not in the history of ${ref} at ${head}`);
    }
    for (const [slot, expected] of plan.expectations) {
      const def = defs.find((d) => d.slot === slot)!;
      const actual = keyFields(parseHeader(backend.read(head, def.taskPath)));
      readback[slot] = { expected, actual };
      if (Object.keys(expected).some((k) => expected[k] !== actual[k])) current = false;
    }
  } catch (e) {
    return fail("PUBLISHED_UNVERIFIED", ref, attempts, base, commit, `read-back could not complete: ${(e as Error).message}`);
  }
  if (!own) return { ...fail("READBACK_MISMATCH", ref, attempts, base, commit, `${commit} itself does not carry the planned fields`), readback };
  if (!current) {
    return { ...fail("SUPERSEDED_AFTER_PUBLISH", ref, attempts, base, commit, `${commit} landed, but ${ref} at ${head} has since changed the slot`), readback };
  }
  const onMain = ref === MAIN_REF;
  return {
    code: onMain ? "REGISTERED_ON_MAIN" : "WRITTEN_TO_BRANCH_NOT_REGISTERED",
    registered: onMain,
    ref,
    attempts,
    base,
    commit,
    detail: onMain ? `published ${commit} and read back from ${ref} at ${head}` : `written to ${ref} only; main is unchanged`,
    readback,
  };
}
