import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as Crypto from 'expo-crypto';
import {
  THREADS_MANUAL_PUBLISH_UI_ENABLED,
  THREADS_PUBLISH_FUNCTION,
  buildAttemptRequest,
  buildPermissionRequest,
  buildPublishRequest,
  buildStateRequest,
  parseAccountState,
  parseAttemptResponse,
  parsePermissionResponse,
  pinThreadsPublish,
  pinnedStillValid,
  threadsCardMode,
  threadsRefusal,
  type PinnedThreadsPublish,
  type ThreadsAttemptView,
  type ThreadsCardContext,
  type ThreadsServerState,
} from '@/domain/threads-manual-publish';
import type { SocialAccount } from '@/domain/types';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/providers/auth-provider';

/**
 * Messages carry the account and the person they are about, so they are never shown on another account's card or to another person
 * (G1 TASK 48). A refusal also carries its code and the action it answered, so the card can offer the way out G4's contract names.
 */
export type ThreadsPublishMessage = {
  accountId: string;
  userId: string | null;
  tone: 'success' | 'danger' | 'neutral';
  text: string;
  code?: string;
  action?: 'publish' | 'resume' | 'reconcile' | 'permission';
  /** The screen's account-data read the message belongs to (`refreshKey` when it was written). */
  read?: number;
};

/**
 * The Threads "post now" card's state and actions. The server (and the database behind it) decides
 * everything; this hook sends only pinned, explicitly confirmed actions, never more than one at a time,
 * never for an account, user or screen that has changed since the person confirmed, and never resends
 * a publish on its own: after an unclear answer it re-reads the account state instead.
 */
export function useThreadsManualPublish(
  account: Pick<SocialAccount, 'id' | 'platform' | 'connectionStatus'>,
  preview: boolean,
  // G1 TASK 48: `refreshKey` changes when the screen read the account data again (a reconnect, a reload): the state is read again.
  options: { releaseEnabled?: boolean; refreshKey?: number } = {},
) {
  const releaseEnabled = options.releaseEnabled ?? THREADS_MANUAL_PUBLISH_UI_ENABLED;
  const { session } = useAuth();
  const userId = session?.user?.id ?? null;
  const token = session?.access_token ?? null;
  const [server, setServer] = useState<{ accountId: string; userId: string | null; state: ThreadsServerState }>({ accountId: account.id, userId, state: { kind: 'loading' } });
  const serverState: ThreadsServerState = server.accountId === account.id && server.userId === userId ? server.state : { kind: 'loading' };
  const mode = threadsCardMode(account, { releaseEnabled, preview, server: serverState });
  const context: ThreadsCardContext = { accountId: account.id, mode, userId };
  const refreshKey = options.refreshKey ?? 0;
  const latest = useRef({ context, token, refreshKey });
  useLayoutEffect(() => {
    latest.current = { context, token, refreshKey };
  });
  const [message, setMessage] = useState<ThreadsPublishMessage | null>(null);
  const [answer, setAnswer] = useState<{ userId: string | null; attempt: ThreadsAttemptView } | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const call = useCallback(async (body: Record<string, unknown>, bearer: string): Promise<{ ok: boolean; payload: unknown }> => {
    if (!supabase) return { ok: false, payload: { error: 'AUTH_REQUIRED' } };
    try {
      const { data, error } = await supabase.functions.invoke<unknown>(THREADS_PUBLISH_FUNCTION, { body, headers: { Authorization: `Bearer ${bearer}` } });
      if (!error) return { ok: true, payload: data };
      const response = (error as { context?: unknown }).context as { clone?: () => { json: () => Promise<unknown> }; json?: () => Promise<unknown> } | null | undefined;
      // G1 TASK 49 (found on the iOS Simulator): Expo's fetch answers with a Response that is not `instanceof Response`, so every refusal
      // read as the generic failure. Any context that reads as JSON is read; anything else stays the generic failure.
      if (response && typeof response.json === 'function') {
        try { return { ok: false, payload: typeof response.clone === 'function' ? await response.clone().json() : await response.json() }; } catch { /* generic below */ }
      }
      return { ok: false, payload: null };
    } catch {
      return { ok: false, payload: null };
    }
  }, []);

  const loadState = useCallback(async (accountId: string) => {
    const bearer = latest.current.token;
    const reader = latest.current.context.userId;
    if (!bearer) return;
    const { ok, payload } = await call(buildStateRequest(accountId), bearer);
    if (latest.current.context.accountId !== accountId || latest.current.context.userId !== reader) return;
    setServer({ accountId, userId: reader, state: ok ? parseAccountState(payload, accountId) : { kind: 'unavailable' } });
  }, [call]);

  const shouldLoad = releaseEnabled && !preview && account.platform === 'threads' && account.connectionStatus === 'connected' && Boolean(token);
  useEffect(() => {
    if (shouldLoad) void loadState(account.id);
  }, [shouldLoad, account.id, userId, loadState, refreshKey]);

  /** Runs one request at a time, for the account and user it was started for. */
  const run = useCallback(async (accountId: string, body: Record<string, unknown>, onAnswer: (payload: unknown, ok: boolean, by: string | null) => void) => {
    if (inFlight.current) return;
    const bearer = latest.current.token;
    const by = latest.current.context.userId;
    if (!bearer) {
      setMessage({ read: latest.current.refreshKey, accountId, userId: by, tone: 'danger', text: threadsRefusal({ error: 'AUTH_REQUIRED' }).message, code: 'AUTH_REQUIRED' });
      return;
    }
    inFlight.current = true;
    setBusy(true);
    try {
      const { ok, payload } = await call(body, bearer);
      // An answer for another account, or for a person who is no longer the one signed in, is dropped (G1 TASK 48).
      if (latest.current.context.accountId !== accountId || latest.current.context.userId !== by) return;
      onAnswer(payload, ok, by);
    } finally {
      inFlight.current = false;
      setBusy(false);
      // Whatever happened, the shown state comes from the server, not from a guess.
      if (latest.current.context.accountId === accountId) void loadState(accountId);
    }
  }, [call, loadState]);

  const pin = useCallback((text: string): PinnedThreadsPublish | null => pinThreadsPublish(latest.current.context, text, () => Crypto.randomUUID()), []);

  /** Resolves true when the server answered with an attempt for this account (the text may be cleared). */
  const publish = useCallback(async (pinned: PinnedThreadsPublish): Promise<boolean> => {
    // The screen moved on since the person confirmed: nothing is sent.
    if (!pinnedStillValid(pinned, latest.current.context)) return false;
    let accepted = false;
    await run(pinned.accountId, buildPublishRequest(pinned), (payload, ok, by) => {
      const attempt = ok ? parseAttemptResponse(payload, pinned.accountId) : null;
      if (attempt) {
        accepted = true;
        setAnswer({ userId: by, attempt });
        setMessage(null);
        return;
      }
      const refusal = threadsRefusal(payload);
      setMessage({ read: latest.current.refreshKey, accountId: pinned.accountId, userId: by, tone: 'danger', text: refusal.message, code: refusal.code, action: 'publish' });
    });
    return accepted;
  }, [run]);

  const followUp = useCallback(async (action: 'resume' | 'reconcile', attempt: ThreadsAttemptView) => {
    if (attempt.accountId !== latest.current.context.accountId) return;
    await run(attempt.accountId, buildAttemptRequest(action, attempt.id), (payload, ok, by) => {
      const next = ok ? parseAttemptResponse(payload, attempt.accountId) : null;
      if (next && next.id === attempt.id) {
        setAnswer({ userId: by, attempt: next });
        setMessage(null);
        return;
      }
      const refusal = threadsRefusal(payload);
      setMessage({ read: latest.current.refreshKey, accountId: attempt.accountId, userId: by, tone: 'danger', text: refusal.message, code: refusal.code, action });
    });
  }, [run]);

  const setPermission = useCallback(async (desired: boolean) => {
    const { context: current } = latest.current;
    const state = server.accountId === current.accountId ? server.state : null;
    if (!state || state.kind !== 'loaded' || state.permitted === desired) return;
    if (desired ? current.mode !== 'consent_required' : current.mode !== 'ready') return;
    const accountId = current.accountId;
    await run(accountId, buildPermissionRequest(accountId, desired, state.permitted), (payload, ok, by) => {
      const confirmed = ok ? parsePermissionResponse(payload, accountId, desired) : null;
      const refusal = confirmed === null ? threadsRefusal(payload) : null;
      setMessage(refusal
        ? { read: latest.current.refreshKey, accountId, userId: by, tone: 'danger', text: refusal.message, code: refusal.code, action: 'permission' }
        : { read: latest.current.refreshKey, accountId, userId: by, tone: 'success', text: desired ? 'このThreadsアカウントへの投稿を許可しました。' : '投稿の許可を取り消しました。' });
    });
  }, [run, server]);

  const shownAnswer = answer && answer.attempt.accountId === account.id && answer.userId === userId ? answer.attempt : null;
  // A new read of the account data (a reconnect, a reload) replaces what the last answer said: the state read now is what is shown.
  const shownMessage = message && message.accountId === account.id && message.userId === userId && (message.read ?? 0) === refreshKey ? message : null;
  return { context, server: serverState, answer: shownAnswer, message: shownMessage, busy, pin, publish, followUp, setPermission };
}
