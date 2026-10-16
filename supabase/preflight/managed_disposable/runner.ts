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
import { type Decision, makeRedactor, scanSqlForForeignTargets, type Target } from './guard.ts';

export type Status = 'PASS' | 'FAIL' | 'STOP' | 'WARN' | 'INFO' | 'MANUAL' | 'NOT_RUN';
export type Verdict = { status: Exclude<Status, 'NOT_RUN'>; detail: string; manual?: string[] };

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
  /** runs the read-only release probe file with its disposable session setting; returns its lines */
  sqlProbe(path: string): Promise<string>;
  /** holds a row lock for `seconds` from a second connection; resolves when it is held */
  sqlHoldLock(query: string, seconds: number): Promise<{ release(): Promise<void> }>;
}

export type PlanFile = { id: string; path: string; kind: 'chain' | 'baseline' };
export type Lock = { files: Record<string, string> };

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

const sha256Hex = async (text: string) => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

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
  const target = options.decision.target;
  const transport = options.transport;
  if (!transport) throw new Error('execute needs a transport');
  const runId = options.runId ?? crypto.randomUUID().replaceAll('-', '').slice(0, 12);
  const created: CreatedUser[] = [];
  const memo: Record<string, unknown> = {};

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
      email: (tag) => `p11-${runId}-${tag}@${target.emailDomain}`,
      log: () => {},
      sql: (query) => transport.sqlRead(query),
      probe: (path) => transport.sqlProbe(path),
      hold: async (query, seconds) => {
        if (mutating) await verifyIdentity();
        return transport.sqlHoldLock(query, seconds);
      },
      http: async (request) => {
        if (request.method !== 'GET') {
          if (!mutating) throw new Error(`step ${step.id} is declared read-only and may not send ${request.method}`);
          await verifyIdentity();
        }
        return transport.http(request);
      },
      applyFile: async (file) => {
        if (!mutating) throw new Error(`step ${step.id} is declared read-only and may not apply a file`);
        const pinned = options.lock.files[file.path];
        if (pinned === undefined) throw new Error(`file ${file.path} is not pinned in the plan lock`);
        const bytes = options.reader.read(file.path);
        if ((await sha256Hex(bytes)) !== pinned) throw new Error(`file ${file.path} differs from its pinned digest`);
        const findings = scanSqlForForeignTargets(bytes, target.projectRef);
        if (findings.length > 0) throw new Error(`file ${file.path} refused: ${findings.map((f) => f.code).join(',')}`);
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
    try {
      if (step.access === 'mutate') await verifyIdentity();
      const verdict = await step.run(ctxFor(step));
      results.push({ id: step.id, title: step.title, status: verdict.status, detail: redact(verdict.detail), ...(verdict.manual ? { manual: verdict.manual.map(redact) } : {}) });
      if ((verdict.status === 'FAIL' || verdict.status === 'STOP') && !stoppedAt) stoppedAt = step.id;
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      results.push({ id: step.id, title: step.title, status: failure instanceof IdentityError ? 'STOP' : 'FAIL', detail: redact(message).slice(0, 400) });
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
