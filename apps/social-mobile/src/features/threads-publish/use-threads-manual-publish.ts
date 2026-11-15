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

/** Messages carry the account they are about, so they are never shown on another account's card. */
export type ThreadsPublishMessage = { accountId: string; tone: 'success' | 'danger' | 'neutral'; text: string };

/**
 * The Threads "post now" card's state and actions. The server (and the database behind it) decides
 * everything; this hook sends only pinned, explicitly confirmed actions, never more than one at a time,
 * never for an account, user or screen that has changed since the person confirmed, and never resends
 * a publish on its own: after an unclear answer it re-reads the account state instead.
 */
export function useThreadsManualPublish(
  account: Pick<SocialAccount, 'id' | 'platform' | 'connectionStatus'>,
  preview: boolean,
  options: { releaseEnabled?: boolean } = {},
) {
  const releaseEnabled = options.releaseEnabled ?? THREADS_MANUAL_PUBLISH_UI_ENABLED;
  const { session } = useAuth();
  const userId = session?.user?.id ?? null;
  const token = session?.access_token ?? null;
  const [server, setServer] = useState<{ accountId: string; state: ThreadsServerState }>({ accountId: account.id, state: { kind: 'loading' } });
  const serverState: ThreadsServerState = server.accountId === account.id ? server.state : { kind: 'loading' };
  const mode = threadsCardMode(account, { releaseEnabled, preview, server: serverState });
  const context: ThreadsCardContext = { accountId: account.id, mode, userId };
  const latest = useRef({ context, token });
  useLayoutEffect(() => {
    latest.current = { context, token };
  });
  const [message, setMessage] = useState<ThreadsPublishMessage | null>(null);
  const [answer, setAnswer] = useState<ThreadsAttemptView | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);

  const call = useCallback(async (body: Record<string, unknown>, bearer: string): Promise<{ ok: boolean; payload: unknown }> => {
    if (!supabase) return { ok: false, payload: { error: 'AUTH_REQUIRED' } };
    try {
      const { data, error } = await supabase.functions.invoke<unknown>(THREADS_PUBLISH_FUNCTION, { body, headers: { Authorization: `Bearer ${bearer}` } });
      if (!error) return { ok: true, payload: data };
      const response = (error as { context?: unknown }).context;
      if (response instanceof Response) {
        try { return { ok: false, payload: await response.clone().json() }; } catch { /* generic below */ }
      }
      return { ok: false, payload: null };
    } catch {
      return { ok: false, payload: null };
    }
  }, []);

  const loadState = useCallback(async (accountId: string) => {
    const bearer = latest.current.token;
    if (!bearer) return;
    const { ok, payload } = await call(buildStateRequest(accountId), bearer);
    if (latest.current.context.accountId !== accountId) return;
    setServer({ accountId, state: ok ? parseAccountState(payload, accountId) : { kind: 'unavailable' } });
  }, [call]);

  const shouldLoad = releaseEnabled && !preview && account.platform === 'threads' && account.connectionStatus === 'connected' && Boolean(token);
  useEffect(() => {
    if (shouldLoad) void loadState(account.id);
  }, [shouldLoad, account.id, userId, loadState]);

  /** Runs one request at a time, for the account and user it was started for. */
  const run = useCallback(async (accountId: string, body: Record<string, unknown>, onAnswer: (payload: unknown, ok: boolean) => void) => {
    if (inFlight.current) return;
    const bearer = latest.current.token;
    if (!bearer) {
      setMessage({ accountId, tone: 'danger', text: threadsRefusal({ error: 'AUTH_REQUIRED' }).message });
      return;
    }
    inFlight.current = true;
    setBusy(true);
    try {
      const { ok, payload } = await call(body, bearer);
      if (latest.current.context.accountId !== accountId) return;
      onAnswer(payload, ok);
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
    await run(pinned.accountId, buildPublishRequest(pinned), (payload, ok) => {
      const attempt = ok ? parseAttemptResponse(payload, pinned.accountId) : null;
      if (attempt) {
        accepted = true;
        setAnswer(attempt);
        setMessage(null);
        return;
      }
      setMessage({ accountId: pinned.accountId, tone: 'danger', text: threadsRefusal(payload).message });
    });
    return accepted;
  }, [run]);

  const followUp = useCallback(async (action: 'resume' | 'reconcile', attempt: ThreadsAttemptView) => {
    if (attempt.accountId !== latest.current.context.accountId) return;
    await run(attempt.accountId, buildAttemptRequest(action, attempt.id), (payload, ok) => {
      const next = ok ? parseAttemptResponse(payload, attempt.accountId) : null;
      if (next && next.id === attempt.id) {
        setAnswer(next);
        setMessage(null);
        return;
      }
      setMessage({ accountId: attempt.accountId, tone: 'danger', text: threadsRefusal(payload).message });
    });
  }, [run]);

  const setPermission = useCallback(async (desired: boolean) => {
    const { context: current } = latest.current;
    const state = server.accountId === current.accountId ? server.state : null;
    if (!state || state.kind !== 'loaded' || state.permitted === desired) return;
    if (desired ? current.mode !== 'consent_required' : current.mode !== 'ready') return;
    const accountId = current.accountId;
    await run(accountId, buildPermissionRequest(accountId, desired, state.permitted), (payload, ok) => {
      const confirmed = ok ? parsePermissionResponse(payload, accountId, desired) : null;
      setMessage(confirmed === null
        ? { accountId, tone: 'danger', text: threadsRefusal(payload).message }
        : { accountId, tone: 'success', text: desired ? 'このThreadsアカウントへの投稿を許可しました。' : '投稿の許可を取り消しました。' });
    });
  }, [run, server]);

  const shownAnswer = answer && answer.accountId === account.id ? answer : null;
  const shownMessage = message && message.accountId === account.id ? message : null;
  return { context, server: serverState, answer: shownAnswer, message: shownMessage, busy, pin, publish, followUp, setPermission };
}
