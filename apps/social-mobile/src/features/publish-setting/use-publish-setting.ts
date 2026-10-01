import { useCallback, useRef, useState } from 'react';
import {
  PUBLISH_SETTING_FUNCTION,
  buildPublishSettingRequest,
  parsePublishSettingSuccess,
  publishSettingFailure,
  publishSettingSuccessMessage,
} from '@/domain/publish-setting';
import type { SocialAccount } from '@/domain/types';
import { supabase } from '@/lib/supabase';
import { useAuth } from '@/providers/auth-provider';

export type PublishSettingState =
  | { kind: 'idle' }
  | { kind: 'submitting'; desired: boolean }
  | { kind: 'success'; message: string }
  | { kind: 'error'; message: string };

/**
 * Switches automatic publishing for ONE exact account through the server function. The server decides
 * who may do it and whether it may be ON; this hook only sends the three fields, refuses to send twice
 * while a request is in flight, and reloads the shared data after any outcome that changed or outdated it.
 */
export function usePublishSetting(account: Pick<SocialAccount, 'id' | 'postingState'> | undefined, reload: () => void) {
  const { session } = useAuth();
  const [state, setState] = useState<PublishSettingState>({ kind: 'idle' });
  const inFlight = useRef(false);

  const submit = useCallback(async (desiredEnabled: boolean) => {
    if (inFlight.current || !account) return;
    inFlight.current = true;
    setState({ kind: 'submitting', desired: desiredEnabled });
    try {
      if (!supabase || !session?.access_token) {
        setState({ kind: 'error', message: publishSettingFailure({ error: 'AUTH_REQUIRED' }).message });
        return;
      }
      const request = buildPublishSettingRequest(account, desiredEnabled);
      const { data, error } = await supabase.functions.invoke<unknown>(PUBLISH_SETTING_FUNCTION, {
        body: request,
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      let payload: unknown = data;
      if (error) {
        payload = null;
        const context = (error as { context?: unknown }).context;
        if (context instanceof Response) {
          try { payload = await context.clone().json(); } catch { /* keep the generic error */ }
        }
      }
      const success = error ? null : parsePublishSettingSuccess(payload, request);
      if (success) {
        setState({ kind: 'success', message: publishSettingSuccessMessage(success.enabled) });
        reload();
        return;
      }
      const failure = publishSettingFailure(payload);
      setState({ kind: 'error', message: failure.message });
      if (failure.reload) reload();
    } catch {
      setState({ kind: 'error', message: publishSettingFailure(null).message });
    } finally {
      inFlight.current = false;
    }
  }, [account, reload, session]);

  const dismiss = useCallback(() => setState({ kind: 'idle' }), []);
  return { state, submit, dismiss, busy: state.kind === 'submitting' };
}
