// Deny-by-default project guard for a FUTURE disposable-Supabase proof run (Phase 3c, offline readiness).
// It validates a run request, a standalone project marker and a used-project ledger, and answers which reasons
// refuse the run. Pure: no file, network or environment access here (the CLI reads the three files and passes
// their contents). Even an allowed request only unlocks the dry-run plan: there is no executor in this stage.
import { EXPERIMENT_IDS, experiment, type ExperimentId } from './catalog.ts';

export const REQUEST_SCHEMA = 'kabumori.common-account.disposable-e2e.run-request.v1';
export const MARKER_SCHEMA = 'kabumori.common-account.disposable-e2e.project-marker.v1';
export const LEDGER_SCHEMA = 'kabumori.common-account.disposable-e2e.used-projects.v1';
/** Production / shared projects that may never be targeted (the Kabumori + POSTONA project, also used by G3). */
export const PRODUCTION_PROJECT_REFS: readonly string[] = ['wsmznyzcvmuitkglfeuj'];
export const PROJECT_NAME_PREFIX = 'kabumori-disposable-proof-';
const PRODUCTION_LIKE = /(^|[^a-z])(prod|production|live|staging|stage|main|release|shared)([^a-z]|$)/u;
const REQUEST_KEYS = ['schema', 'task_id', 'run_id', 'project_ref', 'project_marker_path', 'typed_confirmation', 'user_approval', 'scenarios', 'destructive_consents', 'extra_approvals'];
const MARKER_KEYS = ['schema', 'project_ref', 'project_name', 'environment', 'created_for_task', 'contains_production_data', 'production_clone', 'expires_at'];
const OVERRIDE_LIKE = /force|skip|override|bypass|unsafe|yes|assume|ignore/iu;

export const typedConfirmation = (ref: string, runId: string) =>
  `I CONFIRM ${ref} IS A DISPOSABLE PROJECT WITHOUT PRODUCTION DATA FOR RUN ${runId}`;
export const destructiveConsent = (id: ExperimentId, ref: string, runId: string) => `DESTROY-${id}-${ref}-${runId}`;

export interface GuardInput {
  request: unknown;
  marker: unknown;
  /** Absolute, normalized path the marker was read from. */
  markerPath: string | null;
  ledger: unknown;
  /** Absolute path of the repository root (the marker must live outside it). */
  repoRoot: string;
  now: Date;
}
export interface GuardResult {
  allowed: boolean;
  reasons: string[];
  scenarios: ExperimentId[];
  /** Always the same in this stage: nothing can be executed. */
  execution: 'NOT_AVAILABLE_IN_THIS_STAGE';
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

function strictKeys(value: Record<string, unknown>, allowed: string[], label: string, reasons: string[]) {
  for (const key of Object.keys(value).sort()) {
    if (!allowed.includes(key)) reasons.push(OVERRIDE_LIKE.test(key) ? `OVERRIDE_NOT_SUPPORTED:${label}.${key}` : `UNKNOWN_FIELD:${label}.${key}`);
  }
}

function validIsoInstant(value: unknown): Date | null {
  if (!isString(value) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/u.test(value)) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

export function validateRunRequest(input: GuardInput): GuardResult {
  const reasons: string[] = [];
  const scenarios: ExperimentId[] = [];
  const done = (): GuardResult => ({ allowed: reasons.length === 0, reasons, scenarios, execution: 'NOT_AVAILABLE_IN_THIS_STAGE' });
  const request = input.request;
  if (request === undefined || request === null) {
    reasons.push('REQUEST_MISSING');
    return done();
  }
  if (!isObject(request)) {
    reasons.push('REQUEST_NOT_OBJECT');
    return done();
  }
  strictKeys(request, REQUEST_KEYS, 'request', reasons);
  if (request.schema !== REQUEST_SCHEMA) reasons.push('REQUEST_SCHEMA');

  // --- the project reference: explicit, well-formed, never production, never reused ------------------
  const ref = request.project_ref;
  const refOk = isString(ref) && /^[a-z]{20}$/u.test(ref);
  if (!isString(ref)) reasons.push('PROJECT_REF_MISSING');
  else if (!refOk) reasons.push('PROJECT_REF_FORMAT');
  if (refOk && PRODUCTION_PROJECT_REFS.includes(ref)) reasons.push('PROJECT_REF_PRODUCTION');
  const runId = request.run_id;
  const runOk = isString(runId) && /^p3c-run-\d{8}-\d{2}$/u.test(runId);
  if (!runOk) reasons.push('RUN_ID_INVALID');
  if (!isString(request.task_id)) reasons.push('TASK_ID_MISSING');

  const ledger = input.ledger;
  if (!isObject(ledger)) reasons.push('LEDGER_MISSING');
  else if (ledger.schema !== LEDGER_SCHEMA || !Array.isArray(ledger.used_project_refs) || !ledger.used_project_refs.every(isString)) reasons.push('LEDGER_SCHEMA');
  else if (refOk && (ledger.used_project_refs as string[]).includes(ref)) reasons.push('PROJECT_REF_REUSED');

  // --- the standalone marker: outside the repository, not the CLI link, same ref, disposable, fresh ---
  const markerPath = input.markerPath;
  if (!isString(request.project_marker_path)) reasons.push('MARKER_PATH_MISSING');
  else if (markerPath !== request.project_marker_path) reasons.push('MARKER_PATH_MISMATCH');
  if (isString(markerPath)) {
    if (!markerPath.startsWith('/')) reasons.push('MARKER_PATH_NOT_ABSOLUTE');
    if (markerPath.split('/').some((part) => part === '..' || part === '.')) reasons.push('MARKER_PATH_NOT_NORMALIZED');
    const root = input.repoRoot.replace(/\/+$/u, '');
    if (markerPath === root || markerPath.startsWith(`${root}/`)) reasons.push('MARKER_PATH_INSIDE_REPOSITORY');
    if (/(^|\/)supabase\/\.temp(\/|$)/u.test(markerPath) || /(^|\/)project-ref$/u.test(markerPath)) reasons.push('MARKER_PATH_IS_CLI_LINK');
  }
  const marker = input.marker;
  if (!isObject(marker)) {
    reasons.push('MARKER_MISSING');
  } else {
    strictKeys(marker, MARKER_KEYS, 'marker', reasons);
    if (marker.schema !== MARKER_SCHEMA) reasons.push('MARKER_SCHEMA');
    if (marker.project_ref !== ref) reasons.push('MARKER_REF_MISMATCH');
    if (marker.environment !== 'disposable' || marker.contains_production_data !== false || marker.production_clone !== false) {
      reasons.push('MARKER_NOT_DISPOSABLE');
    }
    const name = marker.project_name;
    if (!isString(name) || !name.startsWith(PROJECT_NAME_PREFIX) || PRODUCTION_LIKE.test(name.slice(PROJECT_NAME_PREFIX.length).toLowerCase())) {
      reasons.push('MARKER_NAME_NOT_DISPOSABLE');
    }
    if (marker.created_for_task !== request.task_id) reasons.push('MARKER_TASK_MISMATCH');
    const expires = validIsoInstant(marker.expires_at);
    if (!expires) reasons.push('MARKER_EXPIRY_INVALID');
    else if (expires.getTime() <= input.now.getTime()) reasons.push('MARKER_EXPIRED');
  }

  // --- the person typed the exact sentence and approved this exact project ----------------------------
  if (!refOk || !runOk || request.typed_confirmation !== typedConfirmation(ref as string, runId as string)) reasons.push('CONFIRMATION_MISMATCH');
  const approval = request.user_approval;
  if (!isObject(approval) || !isString(approval.approval_reference) || !validIsoInstant(approval.approved_at)) reasons.push('APPROVAL_MISSING');
  else {
    strictKeys(approval, ['approved_project_ref', 'approval_reference', 'approved_at'], 'user_approval', reasons);
    if (approval.approved_project_ref !== ref) reasons.push('APPROVAL_REF_MISMATCH');
  }

  // --- scenarios: known, unique, and every destructive one consented for this project and run ---------
  const requested = request.scenarios;
  if (!Array.isArray(requested) || requested.length === 0) reasons.push('SCENARIOS_EMPTY');
  else {
    for (const id of requested) {
      if (!isString(id) || !experiment(id)) reasons.push(`SCENARIO_UNKNOWN:${String(id)}`);
      else if (scenarios.includes(id as ExperimentId)) reasons.push(`SCENARIO_DUPLICATE:${id}`);
      else scenarios.push(id as ExperimentId);
    }
  }
  const consents = request.destructive_consents ?? {};
  if (!isObject(consents)) reasons.push('CONSENTS_NOT_OBJECT');
  const extras = request.extra_approvals ?? {};
  if (!isObject(extras)) reasons.push('EXTRA_APPROVALS_NOT_OBJECT');
  if (isObject(consents)) {
    for (const key of Object.keys(consents).sort()) {
      const e = experiment(key);
      if (!e) reasons.push(`CONSENT_UNKNOWN_SCENARIO:${key}`);
      else if (!scenarios.includes(e.id)) reasons.push(`CONSENT_FOR_UNREQUESTED:${key}`);
      else if (e.kind === 'observation') reasons.push(`CONSENT_NOT_APPLICABLE:${key}`);
    }
  }
  for (const id of [...scenarios].sort((a, b) => EXPERIMENT_IDS.indexOf(a) - EXPERIMENT_IDS.indexOf(b))) {
    const e = experiment(id)!;
    if (e.kind === 'destructive') {
      const given = isObject(consents) ? consents[id] : undefined;
      if (given === undefined) reasons.push(`CONSENT_MISSING:${id}`);
      else if (!refOk || !runOk || given !== destructiveConsent(id, ref as string, runId as string)) reasons.push(`CONSENT_MISMATCH:${id}`);
    }
    for (const kind of e.extraApprovals) {
      const extra = isObject(extras) ? extras[kind] : undefined;
      const ok = isObject(extra) && (kind === 'option_d_security_approval'
        ? isString(extra.user_approval_reference) && isString(extra.independent_security_review_reference)
        : isString(extra.approval_reference));
      if (!ok) reasons.push(`EXTRA_APPROVAL_MISSING:${id}:${kind}`);
    }
  }
  if (isObject(extras)) {
    for (const key of Object.keys(extras).sort()) {
      if (key !== 'option_d_security_approval' && key !== 'project_auth_config_change') {
        reasons.push(OVERRIDE_LIKE.test(key) ? `OVERRIDE_NOT_SUPPORTED:extra_approvals.${key}` : `UNKNOWN_FIELD:extra_approvals.${key}`);
      }
    }
  }
  return done();
}
