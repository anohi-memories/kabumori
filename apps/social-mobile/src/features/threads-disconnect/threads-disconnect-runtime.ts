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
      const response = (error as { context?: unknown }).context as { clone?: () => { json: () => Promise<unknown> }; json?: () => Promise<unknown> } | null | undefined;
      // G1 TASK 49 (found on the iOS Simulator): Expo's fetch answers with a Response that is not `instanceof Response`, so every refusal
      // read as the generic failure. Any context that reads as JSON is read; anything else stays the generic failure.
      if (response && typeof response.json === 'function') {
        try {
          return { ok: false, payload: typeof response.clone === 'function' ? await response.clone().json() : await response.json() };
        } catch {
          /* the generic failure below */
        }
      }
      return { ok: false, payload: null };
    },
  };
}
