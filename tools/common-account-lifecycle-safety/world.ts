// A synthetic world for the closure decision logic (Phase 3i, G5). SYNTHETIC / OFFLINE ONLY.
//
// It reproduces the Phase 3h local observations as ADVERSARY BEHAVIOUR so the decision logic can be checked against
// them: a manual link completes after a ban and mints a session (F1/F2), an automatic link in flight commits after
// the ban (F3), old stateless tokens keep being accepted where nothing gates the request (F4), an Auth delete does not
// clean Storage and leaves rows without a foreign key (F6), a response can be lost. It is a model of the PROPOSED
// logic's environment, not a model of managed Supabase.
import {
  BOUNDARIES, decide, gate,
  type BoundaryName, type BoundaryStatus, type Decision, type Facts, type ProviderState, type StepState,
} from './protocol.ts';

export type AdversaryEvent =
  | 'manual_link_start' | 'manual_link_complete'      // F1, F2
  | 'auto_link_start' | 'auto_link_commit'            // F3
  | 'write_with_old_token' | 'upload_with_old_token'  // F4
  | 'write_start' | 'inflight_write_commit'           // a straggler that started before the freeze
  | 'delete_response_lost' | 'delete_fails_once' | 'read_failure';

export const ADVERSARY_EVENTS: readonly AdversaryEvent[] = [
  'manual_link_start', 'manual_link_complete', 'auto_link_start', 'auto_link_commit', 'write_with_old_token',
  'upload_with_old_token', 'write_start', 'inflight_write_commit', 'delete_response_lost', 'delete_fails_once', 'read_failure',
];

export interface Effect {
  tick: number;
  step: string;
  result: 'applied' | 'lost' | 'failed' | 'replay' | 'read';
  /** True when the facts the decision was made from contained an unknown. */
  factsUnknown: boolean;
}

export interface World {
  tick: number;
  boundaries: Record<BoundaryName, BoundaryStatus>;
  accountStatus: 'active' | 'deleting';
  operationOpen: boolean;
  entitlementActive: boolean;
  userPresent: boolean;
  reauthFresh: boolean;
  sessions: { id: number; live: boolean }[];
  /** Stateless tokens: valid for the whole scenario (their expiry is longer than any run). */
  tokens: { id: number; sessionId: number }[];
  banned: boolean;
  identities: string[];
  audit: { action: 'identity_linked'; provider: string; tick: number }[];
  /** Rows without a foreign key to the login (the worst case from F4) and Storage objects (F6). */
  serviceRows: number;
  storageObjects: number;
  manualLinksPending: number;
  autoLinksInflight: number;
  writesInflight: number;
  // durable closure bookkeeping (what the orchestrator would persist)
  containment: { sessions: StepState; ban: StepState };
  providers: Record<string, ProviderState>;
  snapshot: string[] | null;
  snapshotTick: number | null;
  storageZeroReads: number;
  attempts: { cleanup: number; delete: number; orphan: number };
  authDelete: Facts['authDelete'];
  userAbsentKnown: boolean;
  /** Test switch: verification is cached by the verify step instead of read in the decision's own snapshot. */
  cachedVerification: boolean;
  postDeleteCache: Facts['postDelete'];
  freezeTick: number | null;
  // adversary switches
  deleteResponseLostNext: boolean;
  deleteFailsNext: boolean;
  unreadableNext: boolean;
  // evidence
  effects: Effect[];
  accepted: { writes: number; writesAfterFreeze: number; stragglersAfterFreeze: number; uploads: number; uploadsAfterFreeze: number };
  nextId: number;
}

export function newWorld(options: { boundaries?: Partial<Record<BoundaryName, BoundaryStatus>>; identities?: string[]; reauth?: boolean; cachedVerification?: boolean } = {}): World {
  const boundaries = Object.fromEntries(BOUNDARIES.map((b) => [b, 'attested'])) as Record<BoundaryName, BoundaryStatus>;
  Object.assign(boundaries, options.boundaries ?? {});
  return {
    tick: 0, boundaries, accountStatus: 'active', operationOpen: false, entitlementActive: true, userPresent: true,
    reauthFresh: options.reauth ?? true, sessions: [{ id: 1, live: true }], tokens: [{ id: 1, sessionId: 1 }], banned: false,
    identities: options.identities ?? ['email'], audit: [], serviceRows: 3, storageObjects: 2,
    manualLinksPending: 0, autoLinksInflight: 0, writesInflight: 0,
    containment: { sessions: 'not_attempted', ban: 'not_attempted' }, providers: {}, snapshot: null, snapshotTick: null,
    storageZeroReads: 0, attempts: { cleanup: 0, delete: 0, orphan: 0 }, authDelete: 'not_attempted', userAbsentKnown: false,
    cachedVerification: options.cachedVerification ?? false, postDeleteCache: { serviceResidue: null, storageResidue: null, lateIdentityEvents: null },
    freezeTick: null,
    deleteResponseLostNext: false, deleteFailsNext: false, unreadableNext: false,
    effects: [], accepted: { writes: 0, writesAfterFreeze: 0, stragglersAfterFreeze: 0, uploads: 0, uploadsAfterFreeze: 0 }, nextId: 2,
  };
}

function addIdentity(w: World, provider: string) {
  if (!w.identities.includes(provider)) w.identities.push(provider);
  w.audit.push({ action: 'identity_linked', provider, tick: w.tick });
}

export function applyEvent(w: World, e: AdversaryEvent) {
  w.tick += 1;
  switch (e) {
    case 'manual_link_start':
      if (w.userPresent) w.manualLinksPending += 1;
      break;
    case 'manual_link_complete':
      // F1: the callback does not check the ban. F2: the code exchange mints a session and an access token.
      if (w.userPresent && w.manualLinksPending > 0) {
        w.manualLinksPending -= 1;
        addIdentity(w, 'google');
        const id = w.nextId++;
        w.sessions.push({ id, live: true });
        w.tokens.push({ id, sessionId: id });
      }
      break;
    case 'auto_link_start':
      if (w.userPresent) w.autoLinksInflight += 1;
      break;
    case 'auto_link_commit':
      // F3: a callback that started before the ban commits its identity afterwards.
      if (w.userPresent && w.autoLinksInflight > 0) {
        w.autoLinksInflight -= 1;
        addIdentity(w, 'apple');
      }
      break;
    case 'write_with_old_token':
    case 'upload_with_old_token': {
      const upload = e === 'upload_with_old_token';
      const token = w.tokens[w.tokens.length - 1];
      if (!token) break;
      const session = w.sessions.find((s) => s.id === token.sessionId);
      const boundary = upload ? w.boundaries.storage_write_policy : w.boundaries.state_predicate;
      const answer = gate(boundary, {
        account: w.userPresent ? w.accountStatus : 'absent',
        entitlement: w.entitlementActive ? 'active' : 'ended',
        sessionLive: session ? session.live : false,
      });
      // The platform accepts whatever no attested boundary denies (F4): a stateless token is valid until it expires.
      if (answer === 'ALLOW' || answer === 'NO_BOUNDARY') {
        if (upload) {
          w.storageObjects += 1;
          w.accepted.uploads += 1;
          if (w.freezeTick !== null) w.accepted.uploadsAfterFreeze += 1;
        } else {
          w.serviceRows += 1;
          w.accepted.writes += 1;
          if (w.freezeTick !== null) w.accepted.writesAfterFreeze += 1;
        }
      }
      break;
    }
    case 'write_start':
      if (w.accountStatus === 'active' && w.userPresent) w.writesInflight += 1;
      break;
    case 'inflight_write_commit':
      if (w.writesInflight > 0) {
        w.writesInflight -= 1;
        w.serviceRows += 1;
        w.accepted.writes += 1;
        if (w.freezeTick !== null) {
          w.accepted.writesAfterFreeze += 1;
          w.accepted.stragglersAfterFreeze += 1;
        }
      }
      break;
    case 'delete_response_lost':
      w.deleteResponseLostNext = true;
      break;
    case 'delete_fails_once':
      w.deleteFailsNext = true;
      break;
    case 'read_failure':
      w.unreadableNext = true;
      break;
  }
}

export function observe(w: World): { facts: Facts; unknown: boolean } {
  const unreadable = w.unreadableNext;
  w.unreadableNext = false;
  const absentView = !w.userPresent && (w.authDelete === 'confirmed' || w.userAbsentKnown);
  const account: Facts['account'] = absentView ? 'absent' : w.accountStatus;
  const facts: Facts = {
    boundaries: { ...w.boundaries },
    account,
    operation: w.operationOpen ? 'open' : 'none',
    reauth: w.reauthFresh ? 'fresh' : 'stale',
    containment: { ...w.containment },
    serviceData: unreadable ? 'unknown' : (w.serviceRows > 0 ? 'residue' : 'clean'),
    storage: { remaining: unreadable ? null : w.storageObjects, consecutiveZeroReads: w.storageZeroReads },
    providers: { ...w.providers },
    identities: { snapshot: w.snapshot ? [...w.snapshot] : null, current: w.userPresent ? [...w.identities] : [] },
    authDelete: w.authDelete,
    // Post-delete facts are read in the SAME snapshot as the decision (the completion step re-checks under lock in
    // the real system). A cached verification would let a straggler land between the read and the verdict.
    postDelete: w.cachedVerification
      ? { ...w.postDeleteCache }
      : absentView && !unreadable
      ? {
        serviceResidue: w.serviceRows,
        storageResidue: w.storageObjects,
        lateIdentityEvents: w.snapshotTick === null ? 0 : w.audit.filter((a) => a.tick > w.snapshotTick!).length,
      }
      : { serviceResidue: null, storageResidue: null, lateIdentityEvents: null },
    attempts: { ...w.attempts },
    elapsedSinceFreezeSec: w.freezeTick === null ? 0 : (w.tick - w.freezeTick) * 10,
  };
  return { facts, unknown: unreadable };
}

export function execute(w: World, step: string, factsUnknown: boolean) {
  const log = (result: Effect['result']) => w.effects.push({ tick: w.tick, step, result, factsUnknown });
  switch (true) {
    case step === 'freeze':
      if (w.accountStatus === 'active') {
        w.accountStatus = 'deleting';
        w.operationOpen = true;
        w.entitlementActive = false;
        w.freezeTick = w.tick;
      }
      log('applied');
      break;
    case step === 'revoke_sessions':
      w.sessions.forEach((s) => { s.live = false; });
      w.containment.sessions = 'done';
      log('applied');
      break;
    case step === 'ban':
      w.banned = true;
      w.containment.ban = 'done';
      log('applied');
      break;
    case step === 'read_footprint':
      w.attempts.cleanup += 1;
      log('read');
      break;
    case step === 'cleanup_service_data':
      w.serviceRows = 0;
      w.attempts.cleanup += 1;
      log('applied');
      break;
    case step.startsWith('revoke_provider:'): {
      const provider = step.slice('revoke_provider:'.length);
      if (w.providers[provider] === 'revoked') {
        log('replay');
      } else {
        w.providers[provider] = provider === 'email' ? 'not_applicable' : 'revoked';
        log('applied');
      }
      w.attempts.cleanup += 1;
      break;
    }
    case step === 'cleanup_storage': {
      const before = w.storageObjects;
      w.storageObjects = 0;
      w.storageZeroReads = before === 0 ? w.storageZeroReads + 1 : 1;
      if (before > 0) w.attempts.cleanup += 1;
      log('applied');
      break;
    }
    case step === 'record_snapshot':
      if (w.snapshot !== null) w.attempts.cleanup += 1;
      w.snapshot = [...w.identities];
      w.snapshotTick = w.tick;
      log('applied');
      break;
    case step === 'auth_delete':
      w.attempts.delete += 1;
      if (w.deleteFailsNext) {
        w.deleteFailsNext = false;
        w.authDelete = 'failed_before_commit';
        log('failed');
        break;
      }
      // The delete takes effect: sessions and identities cascade; rows without a foreign key and Storage remain (F6).
      w.userPresent = false;
      w.identities = [];
      w.sessions = [];
      if (w.deleteResponseLostNext) {
        w.deleteResponseLostNext = false;
        w.authDelete = 'ambiguous';
        log('lost');
      } else {
        w.authDelete = 'confirmed';
        log('applied');
      }
      break;
    case step === 'readback_user':
      w.userAbsentKnown = !w.userPresent;
      w.authDelete = w.userPresent ? 'failed_before_commit' : 'confirmed';
      log('read');
      break;
    case step === 'verify':
      if (w.cachedVerification) {
        w.postDeleteCache = {
          serviceResidue: w.serviceRows,
          storageResidue: w.storageObjects,
          lateIdentityEvents: w.snapshotTick === null ? 0 : w.audit.filter((a) => a.tick > w.snapshotTick!).length,
        };
      }
      log('read'); // otherwise the next observation carries the fresh post-delete facts
      break;
    case step === 'cleanup_orphans':
      w.serviceRows = 0;
      w.storageObjects = 0;
      w.attempts.orphan += 1;
      if (w.cachedVerification) w.postDeleteCache = { serviceResidue: null, storageResidue: null, lateIdentityEvents: null };
      log('applied');
      break;
    default:
      throw new Error(`unknown step ${step}`);
  }
}

export interface RunResult {
  world: World;
  decision: Decision | null;
  iterations: number;
  capped: boolean;
  decisions: Decision[];
}

/** schedule: iteration index -> events injected just before that iteration's observation. */
export function runClosure(w: World, schedule: Record<number, AdversaryEvent[]> = {}, maxIterations = 80): RunResult {
  const decisions: Decision[] = [];
  for (let i = 0; i < maxIterations; i += 1) {
    for (const e of schedule[i] ?? []) applyEvent(w, e);
    const { facts, unknown } = observe(w);
    const decision = decide(facts);
    decisions.push(decision);
    if (decision.kind !== 'RUN') return { world: w, decision, iterations: i + 1, capped: false, decisions };
    execute(w, decision.step, unknown);
    w.tick += 1;
  }
  return { world: w, decision: null, iterations: maxIterations, capped: true, decisions };
}

/** The properties that must hold for every run. Returns the list of violations (empty = all hold). */
export function violations(r: RunResult): string[] {
  const w = r.world;
  const out: string[] = [];
  if (r.capped) out.push('NOT_TERMINATING');
  const start = r.decisions[0];
  if (start && start.kind === 'STOP' && r.decisions.length === 1 && w.effects.length > 0) out.push('EFFECTS_AFTER_STOP');

  // A guarded boundary admits nothing for the subject after the freeze, except a statement that began before it.
  if (w.boundaries.state_predicate === 'attested' && w.accepted.writesAfterFreeze - w.accepted.stragglersAfterFreeze > 0) out.push('WRITE_ACCEPTED_AFTER_FREEZE');
  if (w.boundaries.storage_write_policy === 'attested' && w.accepted.uploadsAfterFreeze > 0) out.push('UPLOAD_ACCEPTED_AFTER_FREEZE');

  // No blind retry: after a lost delete response nothing may delete again before a read-back.
  let lost = false;
  for (const e of w.effects) {
    if (e.step === 'auth_delete') {
      if (lost) out.push('BLIND_DELETE_RETRY');
      lost = e.result === 'lost';
    }
    if (e.step === 'readback_user') lost = false;
    if (e.result === 'replay') out.push('SINGLE_USE_STEP_REPLAYED');
    if (e.step === 'auth_delete' && e.factsUnknown) out.push('DELETE_ON_UNKNOWN_FACTS');
  }

  if (r.decision?.kind === 'COMPLETE') {
    if (w.userPresent) out.push('COMPLETE_WITH_LOGIN_PRESENT');
    if (w.serviceRows > 0) out.push('COMPLETE_WITH_SERVICE_RESIDUE');
    if (w.storageObjects > 0) out.push('COMPLETE_WITH_STORAGE_RESIDUE');
    const late = w.snapshotTick === null ? 0 : w.audit.filter((a) => a.tick > w.snapshotTick!).length;
    if (late > 0) out.push('COMPLETE_WITH_LATE_IDENTITY');
    for (const p of w.snapshot ?? []) {
      const s = w.providers[p];
      if (!(s === 'revoked' || s === 'remote_unverified' || s === 'not_applicable')) out.push(`COMPLETE_WITH_UNRESOLVED_PROVIDER:${p}`);
    }
  }
  return out;
}
