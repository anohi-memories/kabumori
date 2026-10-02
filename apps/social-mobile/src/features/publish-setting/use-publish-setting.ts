import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import {
  PUBLISH_SETTING_FUNCTION,
  buildPublishSettingRequest,
  parsePublishSettingSuccess,
  publishActionContext,
  publishActionStillValid,
  publishSettingFailure,
  publishSettingSuccessMessage,
  type PublishAction,
} from '@/domain/publish-setting';
import type { SocialAccount } from '@/domain/types';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/providers/auth-provider';

/** Messages carry the account they are about, so they are never shown on another account's card. */
export type PublishSettingState =
  | { kind: 'idle' }
  | { kind: 'submitting'; accountId: string; desired: boolean }
  | { kind: 'success'; accountId: string; message: string }
  | { kind: 'error'; accountId: string; message: string };

/**
 * Sends ONE pinned switch action through the server function. The server (one database transaction)
 * decides who may do it and whether it may be ON. This hook sends only the three pinned fields, refuses
 * to send while a request is in flight, and refuses to send an action whose context is no longer what is
 * on screen: the check runs at submit time against the latest render, so even a callback kept from an
 * older render cannot send for an account, state, preview mode or user that has since changed.
 */
export function usePublishSetting(account: Pick<SocialAccount, 'id' | 'platform' | 'connectionStatus' | 'postingState'>, preview: boolean, reload: () => void) {
  const { session } = useAuth();
  const userId = session?.user?.id ?? null;
  const context = publishActionContext(account, preview, userId);
  const token = session?.access_token ?? null;
  // What is on screen as of the last committed render. Updated synchronously after every commit (before
  // any tap can be handled), and read only inside submit().
  const latest = useRef({ context, token });
  useLayoutEffect(() => {
    latest.current = { context, token };
  });
  const [state, setState] = useState<PublishSettingState>({ kind: 'idle' });
  const inFlight = useRef(false);

  const submit = useCallback(async (action: PublishAction) => {
    if (inFlight.current) return;
    const { context: current, token: currentToken } = latest.current;
    // The screen moved on since this action was pinned: nothing is sent, nothing is shown as changed.
    if (!publishActionStillValid(action, current)) return;
    inFlight.current = true;
    setState({ kind: 'submitting', accountId: action.accountId, desired: action.desiredEnabled });
    try {
      if (!supabase || !currentToken) {
        setState({ kind: 'error', accountId: action.accountId, message: publishSettingFailure({ error: 'AUTH_REQUIRED' }).message });
        return;
      }
      const request = buildPublishSettingRequest(action);
      const { data, error } = await supabase.functions.invoke<unknown>(PUBLISH_SETTING_FUNCTION, {
        body: request,
        headers: { Authorization: `Bearer ${currentToken}` },
      });
      let payload: unknown = data;
      if (error) {
        payload = null;
        const response = (error as { context?: unknown }).context;
        if (response instanceof Response) {
          try { payload = await response.clone().json(); } catch { /* keep the generic error */ }
        }
      }
      const success = error ? null : parsePublishSettingSuccess(payload, request);
      if (success) {
        setState({ kind: 'success', accountId: action.accountId, message: publishSettingSuccessMessage(success.enabled) });
        reload();
        return;
      }
      const failure = publishSettingFailure(payload);
      setState({ kind: 'error', accountId: action.accountId, message: failure.message });
      if (failure.reload) reload();
    } catch {
      setState({ kind: 'error', accountId: action.accountId, message: publishSettingFailure(null).message });
    } finally {
      inFlight.current = false;
    }
  }, [reload]);

  const dismiss = useCallback(() => setState({ kind: 'idle' }), []);
  return { context, state, submit, dismiss, busy: state.kind === 'submitting' };
}
