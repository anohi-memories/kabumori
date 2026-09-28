import { AppState, Platform } from 'react-native';
import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createSanitizingStorage, type KeyValueStore } from '@/lib/session-storage';

export type SupabaseConfig = { url: string; publishableKey: string };
export type SupabaseConfigResult = { ok: true; config: SupabaseConfig } | { ok: false; kind: 'missing' | 'invalid'; reason: string };

// Expo only inlines EXPO_PUBLIC_* values when they are referenced statically.
// Reading the keys through a generic `process.env` object leaves them absent
// from a native bundle, so keep these direct property accesses at module scope.
const expoPublicEnv = {
  EXPO_PUBLIC_SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL,
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
};

export function getSupabaseConfig(env: Record<string, string | undefined> = expoPublicEnv): SupabaseConfigResult {
  const url = env.EXPO_PUBLIC_SUPABASE_URL?.trim();
  const publishableKey = env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !publishableKey) return { ok: false, kind: 'missing', reason: 'Supabase接続設定がありません。apps/social-mobile/.env.exampleを参照してください。' };
  if (!/^https:\/\//u.test(url)) return { ok: false, kind: 'invalid', reason: 'Supabase URLはhttps://で始まる必要があります。' };
  if (/service_role|secret/iu.test(publishableKey)) return { ok: false, kind: 'invalid', reason: '公開クライアントへservice role/secret keyを設定できません。' };
  return { ok: true, config: { url, publishableKey } };
}

function webStorage(): KeyValueStore {
  const local = typeof globalThis.localStorage === 'undefined' ? null : globalThis.localStorage;
  return {
    getItem: (key) => local?.getItem(key) ?? null,
    setItem: (key, value) => { local?.setItem(key, value); },
    removeItem: (key) => { local?.removeItem(key); },
  };
}

export function createSupabaseClient(env: Record<string, string | undefined> = expoPublicEnv): SupabaseClient | null {
  const result = getSupabaseConfig(env);
  if (!result.ok) return null;
  return createClient(result.config.url, result.config.publishableKey, {
    auth: {
      // Session + PKCE verifiers only; provider OAuth credentials are stripped on write.
      storage: createSanitizingStorage(Platform.OS !== 'web' ? AsyncStorage : webStorage()),
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
      // PKCE: OAuth sign-in, e-mail confirmation and recovery links return a
      // one-time code that only this client (holding the verifier) can exchange.
      flowType: 'pkce',
      // Every PKCE redirect carries its own sb_flow_id, so a callback is completed
      // with its own verifier (never the latest one). Requires allow-list entries
      // that match the appended query parameter.
      experimental: { appendPkceFlowIdToRedirects: true },
    },
  });
}

export const supabase = createSupabaseClient();

if (supabase && Platform.OS !== 'web') {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') supabase.auth.startAutoRefresh();
    else supabase.auth.stopAutoRefresh();
  });
}

/** Host of the configured project; only its /auth/v1 endpoints may be opened for sign-in. */
export function getSupabaseHost(env: Record<string, string | undefined> = expoPublicEnv): string | null {
  const result = getSupabaseConfig(env);
  return result.ok ? new URL(result.config.url).host : null;
}
