import { type ChangeSet, keyFields, parseHeader, PlanError, type ReadFile, type SlotDef } from "./registry.ts";

// One registration = one commit. The backend builds a commit on an exact base and publishes it with a
// compare-and-swap (fast-forward only, never force). A stale base is re-planned from the new head a bounded
// number of times; a refusal is recorded and stops the run; success is reported only after the published ref
// reads back the expected fields. Writing to a non-main branch is never reported as registered.

export type PublishResult =
  | { ok: true }
  | { ok: false; kind: "stale" | "permission" | "refused" | "other"; detail: string };

export interface Backend {
  readonly name: string;
  head(ref: string): string;
  read(commit: string, path: string): string | null;
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

export type OutcomeCode =
  | "REGISTERED_ON_MAIN"
  | "WRITTEN_TO_BRANCH_NOT_REGISTERED"
  | "CONFLICT_SAME_SLOT"
  | "PLAN_REFUSED"
  | "STALE_BASE_RETRY_EXHAUSTED"
  | "REFUSED_STOPPED"
  | "TRANSPORT_FAILED_STOPPED"
  | "ERROR_STOPPED"
  | "PERMISSION_DENIED"
  | "PUBLISH_FAILED"
  | "PARTIAL_DETECTED"
  | "PUBLISHED_UNVERIFIED"
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

const TOKEN_PATTERNS = [/gh[pousr]_[A-Za-z0-9]{20,}/g, /github_pat_[A-Za-z0-9_]{20,}/g, /(authorization|bearer)\s*[:=]?\s*\S+/gi];

// Incident text is kept for the Report; anything that looks like a credential is masked first.
export function redact(text: string): string {
  return TOKEN_PATTERNS.reduce((t, p) => t.replace(p, "[REDACTED]"), text).slice(0, 2000);
}

function fail(code: OutcomeCode, ref: string, attempts: number, base: string | null, commit: string | null, detail: string): Outcome {
  return { code, registered: false, ref, attempts, base, commit, detail: redact(detail) };
}

export type Planner = (read: ReadFile, base: string) => ChangeSet;

export function runTransaction(
  backend: Backend,
  defs: SlotDef[],
  ref: string,
  planner: Planner,
  options: { maxAttempts?: number } = {},
): Outcome {
  const maxAttempts = options.maxAttempts ?? 3;
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
      const plan = planner((p) => backend.read(at, p), at);
      commit = backend.commit(at, plan.files, plan.message);
      // The commit object must hold every planned file exactly before it is published.
      for (const [path, content] of plan.files) {
        if (backend.read(commit, path) !== content) {
          return fail("PARTIAL_DETECTED", ref, attempt, base, commit, `commit ${commit} does not contain the planned ${path}`);
        }
      }
      sent = true;
      const published: PublishResult = backend.publish(ref, commit, at);
      if (!published.ok) {
        if (published.kind === "stale") continue; // someone else moved the ref: re-plan from the new head
        const code = published.kind === "permission" ? "PERMISSION_DENIED" : published.kind === "refused" ? "REFUSED_STOPPED" : "PUBLISH_FAILED";
        return fail(code, ref, attempt, base, commit, published.detail);
      }
      return readBack(backend, defs, ref, attempt, at, commit, plan);
    } catch (e) {
      if (e instanceof PlanError) {
        return fail(e.kind === "same_slot_conflict" ? "CONFLICT_SAME_SLOT" : "PLAN_REFUSED", ref, attempt, base, null, e.message);
      }
      const detail = e instanceof Error ? e.message : String(e);
      if (sent) return fail("PUBLISHED_UNVERIFIED", ref, attempt, base, commit, `publish or read-back did not complete; check ${ref}: ${detail}`);
      if (e instanceof RefusedError) return fail("REFUSED_STOPPED", ref, attempt, base, commit, detail);
      if (e instanceof TransportError) return fail("TRANSPORT_FAILED_STOPPED", ref, attempt, base, commit, detail);
      return fail("ERROR_STOPPED", ref, attempt, base, commit, detail);
    }
  }
  return fail("STALE_BASE_RETRY_EXHAUSTED", ref, maxAttempts, base, null, `ref kept moving for ${maxAttempts} attempts`);
}

function readBack(backend: Backend, defs: SlotDef[], ref: string, attempts: number, base: string, commit: string, plan: ChangeSet): Outcome {
  const head = backend.head(ref);
  if (!backend.contains(head, commit)) {
    return fail("READBACK_MISMATCH", ref, attempts, base, commit, `${commit} is not in the history of ${ref} at ${head}`);
  }
  const readback: Outcome["readback"] = {};
  let ok = true;
  for (const [slot, expected] of plan.expectations) {
    const def = defs.find((d) => d.slot === slot)!;
    const actual = keyFields(parseHeader(backend.read(head, def.taskPath)));
    readback[slot] = { expected, actual };
    if (Object.keys(expected).some((k) => expected[k] !== actual[k])) ok = false;
  }
  if (!ok) {
    const out = fail("READBACK_MISMATCH", ref, attempts, base, commit, `${ref} at ${head} does not read back the expected fields`);
    return { ...out, readback };
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
