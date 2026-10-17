// The TEST-ONLY adapters of the X saga stand-in (Phase 13, D-2): they map the stand-in's simulated answers onto the shapes the
// account-delete lifecycle consumes, at the F5 validation harness' dependency boundary and nowhere else.
//
//   LifecycleDeps.x   (preview / run)                      -> syntheticXCleaner
//   LifecycleDeps.rpc (ack_x_unconfirmed)                  -> withStandInAck
//   the fake network  (/functions/v1/social-mobile-...)    -> sagaResponder / ackResponder   (the production http.ts stays in the loop)
//
// This file imports TYPES from production code (`import type`: erased, no runtime import) and nothing else; it must never be
// imported by production code. Both rules are checked by exclusion.ts / exclusion_test.ts, not left to a comment.
//
// THE ONE CONVERSION: `toLifecycleResult` is the only place that turns a simulated "clean" into what the lifecycle calls
// `done`. It exists because the lifecycle must be able to run past the X step inside a SYNTHETIC database; the result it
// returns is registered as simulated (a WeakSet and a non-enumerable symbol), every report line says SIMULATED, and nothing
// here can produce a real revoke, a purge, a Vault read, an OAuth call or an acknowledgement a real saga would accept.
import type { LifecycleDeps, XCleanupResult, XServiceCleaner } from '../../../functions/account-delete/lifecycle_logic.ts';
import {
  STAND_IN_MARKERS, recordsAreSimulated, type StandInRecord, type XSagaStandIn, type XStandInResult,
} from './standin.ts';

export const SIMULATED_RESULT = Symbol('simulated-x-stand-in-result');
const registered = new WeakSet<object>();

/** True for an object that `toLifecycleResult` produced. */
export const isSimulatedLifecycleResult = (value: unknown): boolean => typeof value === 'object' && value !== null && registered.has(value);

function simulatedResult(result: XCleanupResult): XCleanupResult {
  Object.defineProperty(result, SIMULATED_RESULT, { value: STAND_IN_MARKERS, enumerable: false });
  registered.add(result);
  return Object.freeze(result);
}

/** The one success-equivalent conversion. It stays inside the synthetic harness: see the file header. */
export function toLifecycleResult(result: XStandInResult): XCleanupResult {
  if (result.kind === 'stand_in_disabled') return simulatedResult({ outcome: 'failed' });
  switch (result.scenario) {
    case 'clean':
      // the single literal of the outcome `done` in this directory (exclusion.ts, E5)
      return simulatedResult({
        outcome: 'done',
        ...(result.facts.unconfirmedPosts !== undefined && result.facts.unconfirmedSnapshot !== undefined
          ? { unconfirmedPosts: result.facts.unconfirmedPosts, unconfirmedSnapshot: result.facts.unconfirmedSnapshot } : {}),
      });
    case 'blocked': return simulatedResult({ outcome: 'blocked', reason: result.facts.reason });
    case 'in_progress': return simulatedResult({ outcome: 'in_progress' });
    case 'reconciliation_required': return simulatedResult({ outcome: 'failed', reason: result.facts.reason });
    case 'failed': return simulatedResult({ outcome: 'failed' });
  }
}

export type CleanerOptions = {
  /** The person a token belongs to, as the synthetic harness knows it (the real lifecycle verified the token before this runs). */
  userOf(token: string): string | null;
  /** Awaited around every `run` (the synthetic database observer: it proves the stand-in call changed nothing). */
  around?: <T>(run: () => Promise<T>) => Promise<T>;
};

/** The stand-in as the lifecycle's X dependency. A disabled stand-in is "unsupported" for the preview and "failed" for the run. */
export function syntheticXCleaner(standIn: XSagaStandIn, options: CleanerOptions): XServiceCleaner {
  const around = options.around ?? (<T>(run: () => Promise<T>) => run());
  return {
    async preview(token) {
      const userId = options.userOf(token);
      if (userId === null) return null;
      const answer = await standIn.preview(userId);
      return answer.kind === 'simulated' ? { scope: answer.scope, state: answer.state } : null;
    },
    async run(token) {
      const userId = options.userOf(token);
      if (userId === null) return simulatedResult({ outcome: 'failed' });
      return toLifecycleResult(await around(() => standIn.run(userId)));
    },
  };
}

/** `ack_x_unconfirmed` answered by the stand-in: a synthetic acknowledgement, never a call to the real saga's function. */
export function withStandInAck(rpc: LifecycleDeps['rpc'], standIn: XSagaStandIn): LifecycleDeps['rpc'] {
  return async (name, args) => {
    if (name !== 'ack_x_unconfirmed') return await rpc(name, args);
    const answer = await standIn.acknowledge(String(args.p_user_id), args.p_snapshot);
    return answer.kind === 'simulated' ? { ok: true, data: { ...answer.body } } : { ok: false };
  };
}

// ---- the same answers as HTTP, for the fake network of a database-backed harness (production http.ts stays in the loop) -------

const claimsOf = (header: string | null): { sub?: string } => {
  const token = header?.replace(/^Bearer\s+/iu, '') ?? '';
  try {
    return JSON.parse(atob(token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/'))) as { sub?: string };
  } catch {
    return {};
  }
};
const tagged = (body: Record<string, unknown>) => ({ ...body, stand_in: { simulated: true, ...STAND_IN_MARKERS } });
const respond = (body: Record<string, unknown>, status: number) => Response.json(tagged(body), { status });

/** The body the X saga would answer to an `{action}` request, from the stand-in's answer. Production's xResultOf reads it. */
export function sagaResponder(standIn: XSagaStandIn, around?: CleanerOptions['around']): (request: Request) => Promise<Response> {
  const wrap = around ?? (<T>(run: () => Promise<T>) => run());
  return async (request) => {
    const userId = claimsOf(request.headers.get('Authorization')).sub;
    const body = await request.json().catch(() => null) as { action?: unknown } | null;
    if (!userId) return respond({ ok: false, error: 'AUTH_REQUIRED' }, 401);
    if (body?.action === 'preview') {
      const answer = await standIn.preview(userId);
      return answer.kind === 'simulated' ? respond({ ok: true, scope: answer.scope, state: answer.state }, 200) : respond({ ok: false, error: 'STAND_IN_DISABLED' }, 404);
    }
    if (body?.action !== 'delete') return respond({ ok: false, error: 'ACTION_REQUIRED' }, 400);
    const result = await wrap(() => standIn.run(userId));
    if (result.kind === 'stand_in_disabled') return respond({ ok: false, error: 'STAND_IN_DISABLED' }, 404);
    switch (result.scenario) {
      case 'clean':
        return respond({
          ok: true, login_deleted: false,
          ...(result.facts.unconfirmedPosts !== undefined ? { x_posts_unconfirmed: result.facts.unconfirmedPosts, x_unconfirmed_snapshot: result.facts.unconfirmedSnapshot } : {}),
        }, 200);
      case 'blocked': return respond({ ok: false, error: `DELETION_BLOCKED_${result.facts.reason}` }, 409);
      case 'in_progress': return respond({ ok: false, error: 'DELETION_IN_PROGRESS' }, 409);
      case 'reconciliation_required': return respond({ ok: false, error: String(result.facts.reason) }, 502);
      case 'failed': return respond({ ok: false, error: 'FAILED' }, 500);
    }
  };
}

/** The acknowledgement RPC (`social_mobile_account_deletion_x_unconfirmed_ack`) as the fake Data API answers it. */
export function ackResponder(standIn: XSagaStandIn): (args: Record<string, unknown>) => Promise<Response> {
  return async (args) => {
    const answer = await standIn.acknowledge(String(args.p_user_id), args.p_snapshot);
    return answer.kind === 'simulated' ? Response.json(tagged({ ...answer.body }), { status: 200 }) : Response.json({ message: 'STAND_IN_DISABLED' }, { status: 404 });
  };
}

// ---- the report: the marker is in every line ---------------------------------------------------------------------------------

export const REPORT_BANNER = 'SIMULATED X SAGA STAND-IN: no remote effect, no Vault, no OAuth, no network; a PASS here is NOT a real revoke / purge / managed M12';
/** One line per call, each carrying the three markers. */
export function simulatedReport(records: readonly StandInRecord[]): string[] {
  return [REPORT_BANNER, ...records.map((r) =>
    `SIMULATED X #${r.n} ${r.call} -> ${r.answered}${r.disabled ? ' (stand-in disabled)' : ''} | effects_performed=${r.effects_performed} remote_x_verified=${r.remote_x_verified} production_usable=${r.production_usable}`)];
}
/** Throws unless every record is marked simulated. */
export function assertSimulated(records: readonly StandInRecord[]): void {
  if (!recordsAreSimulated(records)) throw new Error('a stand-in record is not marked simulated');
}
/** A label for an assertion made on a simulated outcome. */
export const simulated = (label: string): string => `[SIMULATED X] ${label}`;
