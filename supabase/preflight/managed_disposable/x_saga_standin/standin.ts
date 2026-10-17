// The X saga STAND-IN of the F5 validation harness (Phase 13, D-2). SOURCE ONLY, TESTING ONLY, PURE.
//
// What it is: a scripted, in-memory answer to the two questions the account-delete lifecycle asks of the X saga
// (`social-mobile-account-delete`): "what would you do for this person?" (preview) and "do it" (run), plus the
// acknowledgement of an unconfirmed-post snapshot. It exists so that the POSTONA service-exit path can be validated on a
// disposable, synthetic database without F3's saga, its Vault, its X API client or its reservations.
//
// What it is NOT -- and the code is built so that it cannot become it:
//   * it performs no effect of any kind: no network, no environment, no file, no database, no timer; every answer is a value
//     computed from the script and the person facts handed in. It imports nothing at all (the harness adapter, which maps
//     answers onto the lifecycle's types, imports TYPES only from production code, and the exclusion check enforces that);
//   * every answer says so, in the same words, forever: `effects_performed: false`, `remote_x_verified: false`,
//     `production_usable: false`. There is no way to build a `simulated` result without them;
//   * it never produces the lifecycle's `XCleanupOutcome` / `XCleanupResult`. The ONE conversion that turns a simulated
//     "clean" into what the lifecycle calls `done` lives in harness.ts, is registered there as simulated, and is the only place
//     in this directory where that word appears (checked by the exclusion test);
//   * it is DISABLED unless it was constructed armed; a disabled stand-in answers `stand_in_disabled` to everything.
// Fail closed: a script that has run out answers `failed`, never `clean`.

export const STAND_IN_MARKERS = Object.freeze({ effects_performed: false, remote_x_verified: false, production_usable: false } as const);
export type StandInMarkers = typeof STAND_IN_MARKERS;

export type StandInScenario = 'clean' | 'blocked' | 'in_progress' | 'reconciliation_required' | 'failed';
/** F3's block reasons (mirrored from account-delete's X_BLOCK_REASONS; the stand-in invents no reason of its own). */
export const STAND_IN_BLOCK_REASONS = [
  'ADMIN_ACCOUNT', 'OWNS_OTHER_WORKSPACE', 'WORKSPACE_NOT_SELF_SERVICE', 'SHARED_WORKSPACE', 'WORKSPACE_ROLE_MISMATCH',
  'POSTING_IN_PROGRESS', 'CREDENTIAL_REFRESH_IN_PROGRESS', 'CREDENTIAL_OWNERSHIP_AMBIGUOUS', 'UNEXPECTED_DEPENDENT_DATA',
  'NON_X_ACCOUNT_PRESENT', 'UNKNOWN',
] as const;
export type StandInBlockReason = (typeof STAND_IN_BLOCK_REASONS)[number];
export const STAND_IN_RECONCILIATION_REASONS = ['X_REVOKE_FAILED', 'CREDENTIALS_CHANGED', 'FINALIZE_FAILED'] as const;
export type StandInReconciliationReason = (typeof STAND_IN_RECONCILIATION_REASONS)[number];

/** One scripted answer of the stand-in to a `run`. */
export type StandInStep =
  | { scenario: 'clean'; /** posts whose publish result was "never known": a count; the snapshot name is derived, never typed */ unconfirmedPosts?: number }
  | { scenario: 'blocked'; reason: StandInBlockReason }
  | { scenario: 'in_progress' }
  | { scenario: 'reconciliation_required'; reason: StandInReconciliationReason }
  | { scenario: 'failed' };

export type StandInFacts = { reason?: string; unconfirmedPosts?: number; unconfirmedSnapshot?: string };

/** What a `run` answered. There is no variant that is not marked simulated, except the disabled one that says nothing at all. */
export type XStandInResult =
  | ({ kind: 'simulated'; scenario: StandInScenario; facts: StandInFacts } & StandInMarkers)
  | { kind: 'stand_in_disabled' };

export type XStandInPreview =
  | ({ kind: 'simulated'; scope: 'social_only' | 'social_and_login'; state: 'none' | 'in_progress' | 'operator_required' } & StandInMarkers)
  | { kind: 'stand_in_disabled' };

/** The saga's answers to the acknowledgement of a snapshot (F3 PR #204 contract), as plain data. */
export type StandInAckBody =
  | { status: 'acknowledged'; cleared: number; replay: boolean }
  | { status: 'snapshot_changed'; x_posts_unconfirmed: number; x_unconfirmed_snapshot: string | null }
  | { status: 'snapshot_required' }
  | { status: 'failed' };
export type XStandInAck = ({ kind: 'simulated'; body: StandInAckBody } & StandInMarkers) | { kind: 'stand_in_disabled' };

export type StandInRecord = {
  n: number;
  call: 'preview' | 'run' | 'ack';
  userId: string;
  /** the scenario that was answered (run), or the scope/state (preview), or the ack status */
  answered: string;
  disabled: boolean;
} & StandInMarkers;

/** What the harness tells the stand-in about the synthetic person. The real saga reads the same fact from the database. */
export type StandInPersons = { hasKabumoriProfile(userId: string): boolean | Promise<boolean> };

export type StandInConfig = {
  /** false (the default of `disabledStandIn`) = every call answers `stand_in_disabled` */
  armed: boolean;
  /** consumed one step per `run`; once exhausted the answer is `failed` (fail closed) */
  script: readonly StandInStep[];
  persons: StandInPersons;
  /** the preview reports `operator_required` (the saga is waiting for an operator) */
  previewOperatorRequired?: boolean;
  /** the first N acknowledgements find that the set changed under them (a stale snapshot): each adds one post */
  staleAcks?: number;
  /** awaited at the entry of every `run` (a barrier for concurrency tests); not an effect of the stand-in */
  onRun?: (userId: string, call: number) => Promise<void>;
};

const SNAPSHOT_RE = /^[0-9a-f]{64}$/u;
export const isStandInSnapshot = (value: unknown): value is string => typeof value === 'string' && SNAPSHOT_RE.test(value);

/** The 64-hex name of an unconfirmed set: a pure function of the person and the generation, prefixed so that it can never equal a real saga snapshot by design. */
export async function standInSnapshot(userId: string, generation: number): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`x-saga-stand-in|${userId}|${generation}`));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export type XSagaStandIn = {
  readonly armed: boolean;
  readonly records: readonly StandInRecord[];
  preview(userId: string): Promise<XStandInPreview>;
  run(userId: string): Promise<XStandInResult>;
  acknowledge(userId: string, snapshot: unknown): Promise<XStandInAck>;
};

/** A stand-in that answers `stand_in_disabled` to everything. This is what the harness holds unless it armed a scenario on purpose. */
export const disabledStandIn = (persons: StandInPersons = { hasKabumoriProfile: () => false }): XSagaStandIn =>
  createXSagaStandIn({ armed: false, script: [], persons });

export function createXSagaStandIn(config: StandInConfig): XSagaStandIn {
  const records: StandInRecord[] = [];
  const queue = [...config.script];
  let runs = 0;
  let staleLeft = Math.max(0, config.staleAcks ?? 0);
  /** per person: the unconfirmed set the last clean run left, and the last one that was cleared (for a replay) */
  const pending = new Map<string, { count: number; generation: number }>();
  const cleared = new Map<string, { snapshot: string; count: number }>();
  const note = (call: StandInRecord['call'], userId: string, answered: string, disabled: boolean) => {
    records.push({ n: records.length + 1, call, userId, answered, disabled, ...STAND_IN_MARKERS });
  };
  return {
    armed: config.armed,
    records,
    async preview(userId) {
      if (!config.armed) {
        note('preview', userId, 'stand_in_disabled', true);
        return { kind: 'stand_in_disabled' };
      }
      // the real saga's rule: the login is kept (scope social_only) only for a person who has a Kabumori profile; a POSTONA-only
      // person gets social_and_login (F3's R2') -- the stand-in reproduces the limitation, it does not paper over it
      const scope = (await config.persons.hasKabumoriProfile(userId)) ? 'social_only' : 'social_and_login';
      const state = config.previewOperatorRequired ? 'operator_required' : queue[0]?.scenario === 'in_progress' ? 'in_progress' : 'none';
      note('preview', userId, `${scope}/${state}`, false);
      return { kind: 'simulated', scope, state, ...STAND_IN_MARKERS };
    },
    async run(userId) {
      runs += 1;
      if (config.onRun) await config.onRun(userId, runs);
      if (!config.armed) {
        note('run', userId, 'stand_in_disabled', true);
        return { kind: 'stand_in_disabled' };
      }
      const step: StandInStep = queue.shift() ?? { scenario: 'failed' };
      const facts: StandInFacts = {};
      if (step.scenario === 'blocked' || step.scenario === 'reconciliation_required') facts.reason = step.reason;
      if (step.scenario === 'clean' && step.unconfirmedPosts !== undefined && step.unconfirmedPosts > 0) {
        const generation = (pending.get(userId)?.generation ?? 0) + 1;
        pending.set(userId, { count: step.unconfirmedPosts, generation });
        facts.unconfirmedPosts = step.unconfirmedPosts;
        facts.unconfirmedSnapshot = await standInSnapshot(userId, generation);
      }
      note('run', userId, step.scenario, false);
      return { kind: 'simulated', scenario: step.scenario, facts, ...STAND_IN_MARKERS };
    },
    async acknowledge(userId, snapshot) {
      if (!config.armed) {
        note('ack', userId, 'stand_in_disabled', true);
        return { kind: 'stand_in_disabled' };
      }
      const answer = (body: StandInAckBody): XStandInAck => {
        note('ack', userId, body.status, false);
        return { kind: 'simulated', body, ...STAND_IN_MARKERS };
      };
      // a count alone names no set: the count-only form clears nothing
      if (!isStandInSnapshot(snapshot)) return answer({ status: 'snapshot_required' });
      const last = cleared.get(userId);
      const current = pending.get(userId);
      if (!current) {
        if (last && last.snapshot === snapshot) return answer({ status: 'acknowledged', cleared: last.count, replay: true });
        return answer({ status: 'snapshot_changed', x_posts_unconfirmed: 0, x_unconfirmed_snapshot: null });
      }
      const currentName = await standInSnapshot(userId, current.generation);
      if (staleLeft > 0 && snapshot === currentName) {
        // the set grew under the caller: the snapshot it recorded is stale; nothing is cleared
        staleLeft -= 1;
        const next = { count: current.count + 1, generation: current.generation + 1 };
        pending.set(userId, next);
        return answer({ status: 'snapshot_changed', x_posts_unconfirmed: next.count, x_unconfirmed_snapshot: await standInSnapshot(userId, next.generation) });
      }
      if (snapshot !== currentName) {
        return answer({ status: 'snapshot_changed', x_posts_unconfirmed: current.count, x_unconfirmed_snapshot: currentName });
      }
      pending.delete(userId);
      cleared.set(userId, { snapshot, count: current.count });
      return answer({ status: 'acknowledged', cleared: current.count, replay: false });
    },
  };
}

/** Every record of a stand-in carries the three markers and nothing else claims a remote effect. */
export function recordsAreSimulated(records: readonly StandInRecord[]): boolean {
  return records.every((record) => record.effects_performed === false && record.remote_x_verified === false && record.production_usable === false);
}
