import { sameDeletionContext, type DeletionContext } from '../domain/account-deletion.ts';
import { endFactsOf, endFailure, parseEndPreview, parseEndResult, POSTONA_END_CONFIRMATION, POSTONA_END_CONFIRM_PHRASE, type EndFacts, type EndFailure, type EndPreview, type EndResult } from '../domain/postona-service-end.ts';

type SessionView = { userId: string; sessionId: string | null; accessToken: string };
export type BoundEndPreview = EndPreview & { context: DeletionContext };
export type EndInput = { context: DeletionContext; preview: BoundEndPreview; phrase: string; acknowledged: readonly string[] };
type Deps = {
  enabled: boolean;
  session: () => Promise<SessionView | null>;
  call: (payload: { action: 'preview' } | { action: 'withdraw_postona'; confirmation: 'END_POSTONA_SERVICE'; acknowledged_remote_unverified: string[] }, token: string) => Promise<{ status: number; body: unknown }>;
};
/** What the session reads made while one end was in flight positively saw. Both flags only ever go from false to true. */
type Fence = { context: DeletionContext; switched: boolean; drifted: boolean };
/** No full-account action, direct RPC, legacy endpoint or disconnect operation exists here. */
export function createPostonaEndClient(deps: Deps) {
  const issued = new WeakSet<BoundEndPreview>();
  let busy = false;
  /**
   * The identity fence of the end in flight (at most one: `busy`), shared by EVERY session read of this client instance:
   * the end's own reads, its read-back, and any public preview() running at the same time (J4 concurrency P2).
   *   another person or nobody seen -> `switched`; this person on another session seen -> `drifted`.
   * No later read (a switch back, a stale read arriving out of order) clears them. A read that throws saw nobody
   * (unknown), never a logout. A read reports to the fence in flight when it STARTED, so a read begun inside one end never
   * touches a later end; a read begun while no end was in flight reports to the end in flight when it answers (it cannot
   * be ordered against that end's own reads: fail closed). The fence is dropped when its end returns.
   */
  let fence: Fence | null = null;
  async function lookup(): Promise<SessionView | null> {
    const startedUnder = fence;
    const view = await deps.session();
    const target = startedUnder ?? fence;
    if (target) {
      if (view === null || view.userId !== target.context.userId) target.switched = true;
      else if (!sameDeletionContext(target.context, view)) target.drifted = true;
    }
    return view;
  }
  /**
   * The preview. With `expected` (the end's own read-back), no request is made unless the login is exactly that end's
   * and its fence saw nothing else.
   */
  async function readPreview(expected?: Fence): Promise<BoundEndPreview | EndFailure> {
    if (!deps.enabled) return endFailure('POSTONA_END_UNAVAILABLE');
    try {
      const current = await lookup();
      if (!current?.sessionId || !current.userId) return endFailure('AUTH_REQUIRED');
      if (expected && (expected.switched || expected.drifted || !sameDeletionContext(expected.context, current))) return endFailure('SESSION_CHANGED');
      const response = await deps.call({ action: 'preview' }, current.accessToken);
      const after = await lookup();
      if (!sameDeletionContext({ userId: current.userId, sessionId: current.sessionId }, after ?? { userId: null, sessionId: null })) return endFailure('SESSION_CHANGED');
      const parsed = parseEndPreview(response.status, response.body);
      if (!parsed.ok) return parsed;
      const bound = { ...parsed, context: { userId: current.userId, sessionId: current.sessionId } };
      bound.services.forEach((service) => Object.freeze(service));
      Object.freeze(bound.services); Object.freeze(bound.acknowledgementRequired);
      Object.freeze(bound.context); Object.freeze(bound);
      issued.add(bound);
      return bound;
    } catch { return endFailure('RESULT_UNCONFIRMED'); }
  }
  const preview = () => readPreview();
  async function end(input: EndInput): Promise<EndResult | EndFailure> {
    if (!deps.enabled) return endFailure('POSTONA_END_UNAVAILABLE');
    if (busy) return endFailure('DELETION_IN_PROGRESS');
    busy = true;
    const own: Fence = { context: input.context, switched: false, drifted: false };
    fence = own;
    // What this person's own, validated answer stated, and that answer's body. Kept on every path after the answer
    // arrived (an exception while confirming never drops them) -- but handed back only while no read of this client
    // has seen another person or nobody since this end began (P2-R2c + concurrency): otherwise none of it is returned.
    let facts: EndFacts | undefined;
    let body: unknown;
    let answered = false;
    const samePerson = () => !own.switched;
    /**
     * The last step of every answer after the mutation: one more session read, then
     *   another person / nobody seen by any read since this end began -> SESSION_CHANGED with nothing of this person's;
     *   only exactly this login seen, the last read included -> the answer as it is;
     *   this person on another session, or the last read failed (unknown) -> never a completion: a success becomes
     *   RESULT_UNCONFIRMED carrying this person's validated warnings.
     */
    const settle = async (outcome: EndResult | EndFailure): Promise<EndResult | EndFailure> => {
      let last: SessionView | null | undefined;
      try { last = await lookup(); } catch { last = undefined; }
      if (!samePerson()) return endFailure('SESSION_CHANGED');
      if (outcome.ok && (!last || own.drifted || !sameDeletionContext(input.context, last))) return endFailure('RESULT_UNCONFIRMED', body, facts);
      return outcome;
    };
    const unconfirmed = () => settle(endFailure('RESULT_UNCONFIRMED', body, facts));
    try {
      if (!issued.has(input.preview) || !sameDeletionContext(input.context, input.preview.context)) return endFailure('LIFECYCLE_CHANGED');
      if (!input.preview.postonaAvailable) return endFailure('POSTONA_END_UNAVAILABLE');
      if (input.phrase.trim() !== POSTONA_END_CONFIRM_PHRASE) return endFailure('CONFIRMATION_REQUIRED');
      const required = input.preview.acknowledgementRequired;
      if (input.acknowledged.length !== new Set(input.acknowledged).size || input.acknowledged.some((p) => !required.includes(p))) return endFailure('ACKNOWLEDGEMENT_INVALID');
      if (required.some((p) => !input.acknowledged.includes(p))) return endFailure('REMOTE_UNVERIFIED_ACK_REQUIRED');
      const current = await lookup();
      if (!current?.sessionId) return endFailure('AUTH_REQUIRED');
      if (!sameDeletionContext(input.context, current)) return endFailure('SESSION_CHANGED');
      // Another login already seen by a concurrent read of this client: nothing is sent.
      if (own.switched || own.drifted) return endFailure('SESSION_CHANGED');
      // A mutation consumes its preview/consent. Every retry needs another preview.
      issued.delete(input.preview);
      const response = await deps.call({ action: 'withdraw_postona', confirmation: POSTONA_END_CONFIRMATION, acknowledged_remote_unverified: [...input.acknowledged] }, current.accessToken);
      answered = true;
      body = response.body;
      // Parsed first (pure): only a fully valid answer yields facts; a truncated or inconsistent one never does.
      const result = parseEndResult(response.status, response.body, input.acknowledged);
      if (result.ok) facts = endFactsOf(result);
      let after: SessionView | null;
      try {
        after = await lookup();
      } catch {
        return await unconfirmed();
      }
      if (!after || !sameDeletionContext(input.context, after)) {
        // Another person (or nobody): SESSION_CHANGED with nothing of this person's (settle decides it again).
        const mine = samePerson();
        return await settle(endFailure('SESSION_CHANGED', mine ? body : undefined, mine ? facts : undefined));
      }
      if (!result.ok) return await settle(result);
      // Read-only definitive read-back of THIS login: account + Kabumori unchanged, only POSTONA ended/absent.
      const verified = await readPreview(own);
      if (!verified.ok || !sameDeletionContext(input.context, verified.context)) return await unconfirmed();
      const postona = verified.services.find((s) => s.service === 'x_autopost');
      const oldKabumori = input.preview.services.find((s) => s.service === 'kabumori')?.status;
      const kabumori = verified.services.find((s) => s.service === 'kabumori')?.status;
      if (verified.accountStatus !== 'active' || kabumori !== oldKabumori || verified.deletionInProgress
        || (result.outcome === 'not_registered' ? postona !== undefined : postona?.status !== 'ended')) return await unconfirmed();
      return await settle(result);
    } catch {
      // Before the answer: nothing of this person's is known. After it: the same identity rule as everywhere else.
      if (!answered) return endFailure('RESULT_UNCONFIRMED');
      return samePerson() ? endFailure('RESULT_UNCONFIRMED', body, facts) : endFailure('SESSION_CHANGED');
    }
    finally {
      busy = false;
      if (fence === own) fence = null;
    }
  }
  return { preview, end };
}
