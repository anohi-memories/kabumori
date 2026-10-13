import { sameDeletionContext, type DeletionContext } from '../domain/account-deletion.ts';
import { endFailure, parseEndPreview, parseEndResult, POSTONA_END_CONFIRMATION, POSTONA_END_CONFIRM_PHRASE, type EndFailure, type EndPreview, type EndResult } from '../domain/postona-service-end.ts';

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
  async function preview(): Promise<BoundEndPreview | EndFailure> {
    if (!deps.enabled) return endFailure('POSTONA_END_UNAVAILABLE');
    try {
      const current = await deps.session();
      if (!current?.sessionId || !current.userId) return endFailure('AUTH_REQUIRED');
      const response = await deps.call({ action: 'preview' }, current.accessToken);
      const after = await deps.session();
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
  async function end(input: EndInput): Promise<EndResult | EndFailure> {
    if (!deps.enabled) return endFailure('POSTONA_END_UNAVAILABLE');
    if (busy) return endFailure('DELETION_IN_PROGRESS');
    busy = true;
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
      // A mutation consumes its preview/consent. Every retry needs another preview.
      issued.delete(input.preview);
      const response = await deps.call({ action: 'withdraw_postona', confirmation: POSTONA_END_CONFIRMATION, acknowledged_remote_unverified: [...input.acknowledged] }, current.accessToken);
      const after = await deps.session();
      if (!sameDeletionContext(input.context, after ?? { userId: null, sessionId: null })) return endFailure('SESSION_CHANGED', response.body);
      const result = parseEndResult(response.status, response.body, input.acknowledged);
      if (!result.ok) return result;
      // Read-only definitive read-back: account + Kabumori unchanged, only POSTONA ended/absent.
      const verified = await preview();
      if (!verified.ok || !sameDeletionContext(input.context, verified.context)) return endFailure('RESULT_UNCONFIRMED', response.body);
      const postona = verified.services.find((s) => s.service === 'x_autopost');
      const oldKabumori = input.preview.services.find((s) => s.service === 'kabumori')?.status;
      const kabumori = verified.services.find((s) => s.service === 'kabumori')?.status;
      if (verified.accountStatus !== 'active' || kabumori !== oldKabumori || verified.deletionInProgress
        || (result.outcome === 'not_registered' ? postona !== undefined : postona?.status !== 'ended')) return endFailure('RESULT_UNCONFIRMED', response.body);
      return result;
    } catch { return endFailure('RESULT_UNCONFIRMED'); }
    finally { busy = false; }
  }
  return { preview, end };
}
