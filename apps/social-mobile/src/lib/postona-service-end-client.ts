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
/** No full-account action, direct RPC, legacy endpoint or disconnect operation exists here. */
export function createPostonaEndClient(deps: Deps) {
  const issued = new WeakSet<BoundEndPreview>();
  let busy = false;
  /**
   * The preview. `seen` hears every session read that answered (a read that throws observes nobody: unknown).
   * With `expected` (the end's own read-back), a login other than that exact one makes no request at all.
   */
  async function readPreview(seen?: (view: SessionView | null) => void, expected?: DeletionContext): Promise<BoundEndPreview | EndFailure> {
    if (!deps.enabled) return endFailure('POSTONA_END_UNAVAILABLE');
    const read = async () => { const view = await deps.session(); seen?.(view); return view; };
    try {
      const current = await read();
      if (!current?.sessionId || !current.userId) return endFailure('AUTH_REQUIRED');
      if (expected && !sameDeletionContext(expected, current)) return endFailure('SESSION_CHANGED');
      const response = await deps.call({ action: 'preview' }, current.accessToken);
      const after = await read();
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
    // What this person's own, validated answer stated, and that answer's body. Kept on every path after the answer
    // arrived (an exception while confirming never drops them) -- but handed back only while THIS person is the one
    // last observed signed in (P2-R2c): once another person or nobody is positively observed, none of it is returned.
    let facts: EndFacts | undefined;
    let body: unknown;
    let answered = false;
    // The last login a session read actually answered with (a read that throws leaves it unchanged: unknown), and
    // whether ANY read since the mutation started saw another person or nobody. That is sticky: a later read that
    // shows this person again (a switch back, or a stale read arriving out of order) never brings the facts back.
    let lastSeen: SessionView | null = null;
    let switched = false;
    const see = (view: SessionView | null) => {
      if (view === null || view.userId !== input.context.userId) switched = true;
      lastSeen = view;
    };
    const samePerson = () => !switched && lastSeen !== null && lastSeen.userId === input.context.userId;
    const exactLogin = () => lastSeen !== null && sameDeletionContext(input.context, lastSeen);
    /**
     * The last step of every answer after the mutation: one more session read, then
     *   another person / nobody seen at any read since the mutation -> SESSION_CHANGED with nothing of this person's;
     *   this person, exactly this login -> the answer as it is;
     *   this person on another session, or the read failed (unknown) -> never a completion: a success becomes
     *   RESULT_UNCONFIRMED carrying this person's validated warnings.
     */
    const settle = async (outcome: EndResult | EndFailure): Promise<EndResult | EndFailure> => {
      let observed = true;
      try { see(await deps.session()); } catch { observed = false; }
      if (!samePerson()) return endFailure('SESSION_CHANGED');
      if (outcome.ok && !(observed && exactLogin())) return endFailure('RESULT_UNCONFIRMED', body, facts);
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
      const current = await deps.session();
      if (!current?.sessionId) return endFailure('AUTH_REQUIRED');
      if (!sameDeletionContext(input.context, current)) return endFailure('SESSION_CHANGED');
      see(current);
      // A mutation consumes its preview/consent. Every retry needs another preview.
      issued.delete(input.preview);
      const response = await deps.call({ action: 'withdraw_postona', confirmation: POSTONA_END_CONFIRMATION, acknowledged_remote_unverified: [...input.acknowledged] }, current.accessToken);
      answered = true;
      body = response.body;
      // Parsed first (pure): only a fully valid answer yields facts; a truncated or inconsistent one never does.
      const result = parseEndResult(response.status, response.body, input.acknowledged);
      if (result.ok) facts = endFactsOf(result);
      try {
        see(await deps.session());
      } catch {
        return await unconfirmed();
      }
      if (!exactLogin()) {
        // Another person (or nobody): SESSION_CHANGED with nothing of this person's (settle decides it again).
        return await settle(endFailure('SESSION_CHANGED', samePerson() ? body : undefined, samePerson() ? facts : undefined));
      }
      if (!result.ok) return await settle(result);
      // Read-only definitive read-back of THIS login: account + Kabumori unchanged, only POSTONA ended/absent.
      const verified = await readPreview(see, input.context);
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
    finally { busy = false; }
  }
  return { preview, end };
}
