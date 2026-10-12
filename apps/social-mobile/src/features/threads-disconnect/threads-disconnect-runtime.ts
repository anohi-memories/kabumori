import { THREADS_DISCONNECT_FUNCTION } from '@/domain/threads-disconnect';
import type { ThreadsDisconnectDeps } from '@/features/threads-disconnect/threads-disconnect-runner';
import { supabase } from '@/lib/supabase';

/** The real dependencies of the disconnect. `session` is read at every call (never cached). */
export function productionThreadsDisconnectDeps(session: () => { userId: string; token: string } | null): ThreadsDisconnectDeps {
  return {
    session,
    async invoke(body, token) {
      if (!supabase) return { ok: false, payload: { ok: false, error: 'AUTH_REQUIRED' } };
      const { data, error } = await supabase.functions.invoke<unknown>(THREADS_DISCONNECT_FUNCTION, {
        body,
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!error) return { ok: true, payload: data };
      const response = (error as { context?: unknown }).context;
      if (response instanceof Response) {
        try {
          return { ok: false, payload: await response.clone().json() };
        } catch {
          /* the generic failure below */
        }
      }
      return { ok: false, payload: null };
    },
  };
}
