import Constants from 'expo-constants';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { Platform } from 'react-native';
import { THREADS_CONNECT_FUNCTION } from '@/domain/threads-connect';
import type { ThreadsConnectStarterDeps } from '@/features/threads-connect/threads-connect-starter';
import { supabase } from '@/lib/supabase';

/**
 * The registered HTTPS callback, from app config (`expo.extra.threadsConnectCallbackUrl`). Not set today: it
 * must be the exact URL registered in the Meta app AND a verified app link (Associated Domains / Android
 * App Links) of this app, which is an operator step. Until then the flow answers CALLBACK_NOT_CONFIGURED.
 */
export function configuredThreadsCallback(): string | null {
  const extra = Constants.expoConfig?.extra as Record<string, unknown> | undefined;
  const value = extra?.threadsConnectCallbackUrl;
  return typeof value === 'string' ? value : null;
}

/** The real dependencies of the connect flow. `session` is read at every step (never cached). */
export function productionThreadsConnectDeps(session: () => { userId: string; token: string } | null): ThreadsConnectStarterDeps {
  return {
    registeredCallback: configuredThreadsCallback(),
    session,
    async invoke(body, token) {
      if (!supabase) return { ok: false, payload: { error: 'AUTH_REQUIRED' } };
      const { data, error } = await supabase.functions.invoke<unknown>(THREADS_CONNECT_FUNCTION, {
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
    // iOS: a private auth session, so the person picks the Threads account instead of silently reusing the
    // last one (the same choice as the X connect flow; the browser may decline it).
    openAuthSession: (url, redirectUrl) =>
      WebBrowser.openAuthSessionAsync(url, redirectUrl, Platform.OS === 'ios' ? { preferEphemeralSession: true } : undefined),
    dismissAuthSession: () => {
      try {
        WebBrowser.dismissAuthSession();
      } catch {
        /* already closed */
      }
    },
    onAppLink(listener) {
      const subscription = Linking.addEventListener('url', (event) => listener(event.url));
      return () => subscription.remove();
    },
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
  };
}
