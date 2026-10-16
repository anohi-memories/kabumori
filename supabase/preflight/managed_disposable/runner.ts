// Runner of the managed-disposable acceptance harness (F5 Phase 11). SOURCE ONLY: never run against a managed
// project. It executes a plan (plan.ts) through two injected transports, so the same code is exercised offline by
// supabase/tests/common_account_phase11_plan_model_test.ts (a model of GoTrue / PostgREST over a local database) and,
// after a SEPARATE user approval of an exact project, by cli.ts over real HTTP and psql.
//
// Guarantees (each pinned by runner_test.ts):
//   * DRY RUN is the default and touches no transport at all (not even a read);
//   * `execute` needs a resolved target (guard.ts) and re-reads the project's identity before EVERY mutating call;
//   * a file is sent only when its bytes equal the digest pinned in the plan lock, and only after the foreign-target
//     scan found nothing;
//   * the first FAIL / STOP ends the run; teardown still runs;
//   * nothing is reported PASS that was not measured, and every text that leaves goes through the redactor.
import type { Requirements } from './baseline_requirements.ts';
import { type Decision, makeRedactor, type Target } from './guard.ts';
import { indirectDynamicCalls, indirectNetworkCalls, scanSql } from './sql_scan.ts';

export type Status = 'PASS' | 'FAIL' | 'STOP' | 'WARN' | 'INFO' | 'MANUAL' | 'NOT_RUN';
/**
 * Evidence a step hands the runner: "the project's own baseline contract equals the approved one". The runner does not
 * trust it as written: it must carry the approved digest and name a probe whose pinned bytes the runner itself sent.
 */
export type BaselineEvidence = { kind: 'baseline_contract'; digest: string; probePath: string };
export type Verdict = { status: Exclude<Status, 'NOT_RUN'>; detail: string; manual?: string[]; evidence?: BaselineEvidence };

/** The id of the step whose PASS (with valid evidence) unlocks every chain mutation. Owned here, used by the plan. */
export const BASELINE_GATE = 'G3b';

export type HttpRequest = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** path below the project's base URL, e.g. /auth/v1/signup */
  path: string;
  /** which project key the request carries (the transport holds the values); 'service' also becomes the bearer unless one is given */
  key: 'publishable' | 'service' | 'none';
  bearer?: string;
  body?: unknown;
  query?: Record<string, string>;
};
export type HttpResponse = { status: number; body: unknown };

export interface Transport {
  http(request: HttpRequest): Promise<HttpResponse>;
  /** read-only SQL; the text of the first column of every row, newline separated (psql -A -t) */
  sqlRead(query: string): Promise<string>;
  /** sends one pinned file as written (its own BEGIN/COMMIT) */
  sqlApplyFile(path: string, bytes: string): Promise<string>;
  /**
   * runs a read-only probe with its disposable session setting; returns its lines. `bytes` are the bytes the runner already
   * verified against the pin: an implementation sends exactly these and MUST NOT read `path` (or anything else) itself --
   * a second read after the check would be a different, unverified query. `path` is a label for logs only.
   */
  sqlProbe(path: string, bytes: string): Promise<string>;
  /** holds a row lock for `seconds` from a second connection; resolves when it is held */
  sqlHoldLock(query: string, seconds: number): Promise<{ release(): Promise<void> }>;
}

export type PlanFile = { id: string; path: string; kind: 'chain' | 'baseline' };
/** What the review accepted in a pinned file, statement by statement (lock.ts builds it; any difference is a refusal). */
export type Reviewed = { dynamic: string[]; writes: string[]; selects: string[]; /** corpus functions that run run-time SQL which this file calls, accepted by name */ indirectDynamic?: string[] };
export type Lock = {
  /** SHA-256 of every file the harness may send */
  files: Record<string, string>;
  /** accepted dynamic statements / write targets / top-level selects per file; a file without an entry accepts none */
  reviewed?: Record<string, Reviewed>;
  /** functions of the repository corpus that reach the network or cron, directly or through helpers: a file that calls one is refused */
  networkFunctions?: string[];
  /** functions of the repository corpus that run SQL assembled at run time, directly or through helpers: a call needs a named acceptance */
  dynamicFunctions?: string[];
  /** what the chain requires of the baseline (read out of the Phase 1 preflight at lock time; the baseline read-back step checks it) */
  requirements?: Requirements;
  /** SHA-256 of the contract subset of the production inventory the owner approved. Supplied by the operator at run time, never stored in the lock file. */
  approvedInventory?: string;
};

export type Step = {
  id: string;
  title: string;
  access: 'read' | 'mutate';
  /** automated: the harness does it; manual: the operator does it and the harness only reads back */
  mode: 'automated' | 'manual';
  /** exercised by the offline model run */
  modelled: boolean;
  expected: string;
  stop: string;
  /** runs even after a FAIL / STOP (teardown) */
  always?: boolean;
  /**
   * step ids that must have PASSED earlier in THIS run. A step is never run, and a selection that leaves one out is
   * refused before the first transport action. Teardown (`always`) is exempt: it must stay runnable on its own.
   */
  requires?: readonly string[];
  run(ctx: Ctx): Promise<Verdict>;
};

export type CreatedUser = { userId: string; email: string };
export type Ctx = {
  target: Target;
  runId: string;
  http(request: HttpRequest): Promise<HttpResponse>;
  sql(query: string): Promise<string>;
  probe(path: string): Promise<string>;
  hold(query: string, seconds: number): Promise<{ release(): Promise<void> }>;
  applyFile(file: PlanFile): Promise<string>;
  /** what the baseline read-back compares the project with */
  baseline: { requirements?: Requirements; approvedInventory?: string };
  /** a synthetic address on the controlled domain, unique to this run */
  email(tag: string): string;
  created: CreatedUser[];
  /** facts one step hands to a later one */
  memo: Record<string, unknown>;
  log(line: string): void;
};

export type Reader = { read(path: string): string };
export type RunOptions = {
  mode: 'dry-run' | 'execute';
  decision: Decision;
  transport?: Transport;
  lock: Lock;
  reader: Reader;
  secrets?: readonly (string | undefined)[];
  runId?: string;
  /** optional restriction to some step ids (the offline model runs only the modelled ones) */
  only?: readonly string[];
};
export type StepResult = { id: string; title: string; status: Status; detail: string; manual?: string[] };
export type Report = {
  mode: 'dry-run' | 'execute';
  refused?: { code: string; detail: string }[];
  results: StepResult[];
  summary: { pass: number; fail: number; stop: number; warn: number; manual: number; notRun: number };
  /** true only when every step ran and passed and no manual item is open */
  complete: boolean;
  stoppedAt?: string;
};

export class IdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityError';
  }
}

/** A mutation was attempted before the baseline read-back passed in this run. It is a STOP, never a FAIL to retry. */
export class GateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GateError';
  }
}

/**
 * Why a selection of steps is unsafe (empty when it is fine). A step that `requires` another must come with it, and
 * after it; an unknown id is refused rather than silently ignored (a typo must not select nothing).
 */
export function unsafeSelection(steps: readonly Pick<Step, 'id' | 'requires'>[], only?: readonly string[]): string[] {
  const ids = steps.map((step) => step.id);
  const selected = new Set(only ?? ids);
  const problems: string[] = [];
  for (const name of selected) if (!ids.includes(name)) problems.push(`unknown step ${name}`);
  for (const step of steps) {
    if (!selected.has(step.id)) continue;
    for (const need of step.requires ?? []) {
      if (!ids.includes(need)) problems.push(`${step.id} requires ${need}, which is not a step of this plan`);
      else if (!selected.has(need)) problems.push(`${step.id} requires ${need}, which is not selected`);
      else if (ids.indexOf(need) > ids.indexOf(step.id)) problems.push(`${step.id} requires ${need}, which comes later`);
    }
  }
  return problems;
}

const sha256Hex = async (text: string) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

/** Every reason a file's text may not be sent: a blocking finding, or a reviewable one the lock did not accept. */
export async function refusalsFor(
  bytes: string, reviewed: Reviewed | undefined, networkFunctions: readonly string[], targetRef: string, dynamicFunctions: readonly string[] = [],
): Promise<string[]> {
  const scan = scanSql(bytes, { targetRef });
  const reasons = new Set<string>();
  for (const finding of scan.findings) if (finding.severity === 'block') reasons.add(finding.code);
  for (const finding of indirectNetworkCalls(scan, new Set(networkFunctions))) reasons.add(finding.code);
  const indirect = new Set(reviewed?.indirectDynamic ?? []);
  for (const name of indirectDynamicCalls(scan, new Set(dynamicFunctions))) if (!indirect.has(name)) reasons.add('INDIRECT_DYNAMIC_CALL');
  const dynamic = new Set(reviewed?.dynamic ?? []);
  for (const statement of scan.dynamic) if (!dynamic.has(await sha256Hex(statement.text))) reasons.add('DYNAMIC_SQL');
  const writes = new Set(reviewed?.writes ?? []);
  for (const table of scan.writes) if (!writes.has(table)) reasons.add('DATA_WRITE');
  const selects = new Set(reviewed?.selects ?? []);
  for (const statement of scan.topLevelSelects) if (!selects.has(await sha256Hex(statement.text))) reasons.add('TOP_LEVEL_SELECT');
  return [...reasons].sort();
}

export async function run(steps: readonly Step[], options: RunOptions): Promise<Report> {
  const redact = makeRedactor(options.secrets ?? []);
  const results: StepResult[] = [];
  const summarize = (stoppedAt?: string): Report => {
    const count = (statuses: Status[]) => results.filter((r) => statuses.includes(r.status)).length;
    const summary = { pass: count(['PASS']), fail: count(['FAIL']), stop: count(['STOP']), warn: count(['WARN']), manual: count(['MANUAL']), notRun: count(['NOT_RUN']) };
    return {
      mode: options.mode,
      results,
      summary,
      complete: options.mode === 'execute' && results.length === steps.length && summary.pass === steps.length && results.every((r) => (r.manual?.length ?? 0) === 0),
      ...(stoppedAt ? { stoppedAt } : {}),
    };
  };

  // ---- dry run: print the plan; no transport is ever touched -------------------------------------------------------
  if (options.mode === 'dry-run') {
    for (const step of steps) {
      results.push({ id: step.id, title: step.title, status: 'NOT_RUN', detail: `dry run (${step.access}, ${step.mode}); expected: ${step.expected}; STOP when: ${step.stop}` });
    }
    return summarize();
  }

  // ---- execute: refused unless the target is resolved ---------------------------------------------------------------
  if (!options.decision.ok) {
    return { ...summarize(), refused: options.decision.failures.map((f) => ({ code: f.code, detail: redact(f.detail) })), results: [], complete: false };
  }
  // an unsafe partial selection is refused before the first transport action (not even an identity read)
  const unsafe = unsafeSelection(steps, options.only);
  if (unsafe.length > 0) {
    return { ...summarize(), refused: unsafe.map((detail) => ({ code: 'UNSAFE_SELECTION', detail })), results: [], complete: false };
  }
  const target = options.decision.target;
  const transport = options.transport;
  if (!transport) throw new Error('execute needs a transport');
  const runId = options.runId ?? crypto.randomUUID().replaceAll('-', '').slice(0, 12);
  const created: CreatedUser[] = [];
  const memo: Record<string, unknown> = {};
  /** digest of the bytes each probe path was sent with in this run */
  const sentProbes = new Map<string, string>();
  /** set only by a PASS of the baseline gate whose evidence names this run's approved digest and a probe the runner sent */
  let baselineGrant: { ref: string; digest: string } | undefined;
  const passed = new Set<string>();
  const requireBaselineGrant = (what: string) => {
    if (!baselineGrant || baselineGrant.ref !== target.projectRef || baselineGrant.digest !== options.lock.approvedInventory) {
      throw new GateError(`${what} is a mutation and the baseline read-back (${BASELINE_GATE}) has not passed in this run`);
    }
  };

  // identity: the project itself says which project it is, and it is the allowlisted one
  const verifyIdentity = async () => {
    const answer = (await transport.sqlRead('select coalesce(string_agg(project_ref, \',\' order by project_ref), \'\') from public.kabumori_disposable_marker')).trim();
    if (answer !== target.projectRef) throw new IdentityError('the project\'s own marker does not name the target project');
  };

  const ctxFor = (step: Step): Ctx => {
    const mutating = step.access === 'mutate';
    return {
      target,
      runId,
      created,
      memo,
      baseline: { requirements: options.lock.requirements, approvedInventory: options.lock.approvedInventory },
      email: (tag) => `p11-${runId}-${tag}@${target.emailDomain}`,
      log: () => {},
      sql: (query) => transport.sqlRead(query),
      probe: async (path) => {
        // a probe file is read-only SQL the review pinned: it is sent only when its bytes are the pinned bytes, and the
        // bytes that were checked are the bytes that are sent (one read; the transport receives them and reads nothing)
        const pinned = options.lock.files[path];
        if (pinned === undefined) throw new Error(`probe file ${path} is not pinned in the plan lock`);
        const bytes = options.reader.read(path);
        const digest = await sha256Hex(bytes);
        if (digest !== pinned) throw new Error(`probe file ${path} differs from its pinned digest`);
        sentProbes.set(path, digest);
        return transport.sqlProbe(path, bytes);
      },
      hold: async (query, seconds) => {
        if (mutating) {
          if (!step.always) requireBaselineGrant('a held lock');
          await verifyIdentity();
        }
        return transport.sqlHoldLock(query, seconds);
      },
      http: async (request) => {
        if (request.method !== 'GET') {
          if (!mutating) throw new Error(`step ${step.id} is declared read-only and may not send ${request.method}`);
          // teardown (`always`) removes this run's own logins and must stay runnable on its own
          if (!step.always) requireBaselineGrant(`${request.method} ${request.path}`);
          await verifyIdentity();
        }
        return transport.http(request);
      },
      applyFile: async (file) => {
        if (!mutating) throw new Error(`step ${step.id} is declared read-only and may not apply a file`);
        // the mutation boundary itself: a chain file is never sent unless the baseline read-back passed in THIS run, for
        // this project and for the approved digest (a step filter, a custom plan or a direct call cannot get around it)
        // (every file except the operator's baseline itself: the baseline is what the read-back then checks)
        if (file.kind !== 'baseline') requireBaselineGrant(`file ${file.path}`);
        const pinned = options.lock.files[file.path];
        if (pinned === undefined) throw new Error(`file ${file.path} is not pinned in the plan lock`);
        const bytes = options.reader.read(file.path);
        if ((await sha256Hex(bytes)) !== pinned) throw new Error(`file ${file.path} differs from its pinned digest`);
        const refusals = await refusalsFor(bytes, options.lock.reviewed?.[file.path], options.lock.networkFunctions ?? [], target.projectRef, options.lock.dynamicFunctions ?? []);
        if (refusals.length > 0) throw new Error(`file ${file.path} refused: ${refusals.join(',')}`);
        await verifyIdentity();
        return transport.sqlApplyFile(file.path, bytes);
      },
    };
  };

  let stoppedAt: string | undefined;
  for (const step of steps) {
    if (options.only && !options.only.includes(step.id)) {
      results.push({ id: step.id, title: step.title, status: 'NOT_RUN', detail: 'not selected for this run' });
      continue;
    }
    if (stoppedAt && step.always !== true) {
      results.push({ id: step.id, title: step.title, status: 'NOT_RUN', detail: `not run: stopped at ${stoppedAt}` });
      continue;
    }
    const missing = (step.requires ?? []).filter((need) => !passed.has(need));
    if (missing.length > 0) {
      results.push({ id: step.id, title: step.title, status: 'STOP', detail: `not run: ${missing.join(', ')} has not passed in this run` });
      stoppedAt ??= step.id;
      continue;
    }
    try {
      if (step.access === 'mutate') await verifyIdentity();
      let verdict = await step.run(ctxFor(step));
      if (step.id === BASELINE_GATE && verdict.status === 'PASS') {
        const evidence = verdict.evidence;
        const bound = evidence !== undefined && evidence.kind === 'baseline_contract' && options.lock.approvedInventory !== undefined
          && evidence.digest === options.lock.approvedInventory
          && sentProbes.get(evidence.probePath) !== undefined && sentProbes.get(evidence.probePath) === options.lock.files[evidence.probePath];
        if (bound && evidence) baselineGrant = { ref: target.projectRef, digest: evidence.digest };
        else verdict = { status: 'STOP', detail: `${BASELINE_GATE} reported PASS without evidence bound to the approved digest and to a probe this run sent` };
      }
      results.push({ id: step.id, title: step.title, status: verdict.status, detail: redact(verdict.detail), ...(verdict.manual ? { manual: verdict.manual.map(redact) } : {}) });
      if (verdict.status === 'PASS') passed.add(step.id);
      if ((verdict.status === 'FAIL' || verdict.status === 'STOP') && !stoppedAt) stoppedAt = step.id;
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      const stopping = failure instanceof IdentityError || failure instanceof GateError;
      results.push({ id: step.id, title: step.title, status: stopping ? 'STOP' : 'FAIL', detail: redact(message).slice(0, 400) });
      stoppedAt ??= step.id;
    }
  }
  return summarize(stoppedAt);
}

/** Renders a report for a terminal. Every line goes through the redactor first. */
export function render(report: Report, secrets: readonly (string | undefined)[] = []): string {
  const redact = makeRedactor(secrets);
  const lines: string[] = [`mode: ${report.mode}`];
  if (report.refused) {
    lines.push('REFUSED: execution is not permitted');
    for (const item of report.refused) lines.push(`  ${item.code}: ${item.detail}`);
  }
  for (const result of report.results) {
    lines.push(`${result.status.padEnd(7)} ${result.id.padEnd(8)} ${result.title}`);
    lines.push(`          ${result.detail}`);
    for (const item of result.manual ?? []) lines.push(`          MANUAL: ${item}`);
  }
  const s = report.summary;
  lines.push(`summary: pass=${s.pass} fail=${s.fail} stop=${s.stop} warn=${s.warn} manual=${s.manual} not_run=${s.notRun} complete=${report.complete}`);
  if (report.stoppedAt) lines.push(`stopped at ${report.stoppedAt}`);
  return lines.map(redact).join('\n');
}
