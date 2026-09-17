import { AppState, Platform } from 'react-native';
import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export type SupabaseConfig = { url: string; publishableKey: string };
export type SupabaseConfigResult = { ok: true; config: SupabaseConfig } | { ok: false; reason: string };

export function getSupabaseConfig(env: Record<string, string | undefined> = process.env): SupabaseConfigResult {
  const url = env.EXPO_PUBLIC_SUPABASE_URL?.trim();
  const publishableKey = env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !publishableKey) return { ok: false, reason: 'Supabase接続設定がありません。apps/social-mobile/.env.exampleを参照してください。' };
  if (!/^https:\/\//u.test(url)) return { ok: false, reason: 'Supabase URLはhttps://で始まる必要があります。' };
  if (/service_role|secret/iu.test(publishableKey)) return { ok: false, reason: '公開クライアントへservice role/secret keyを設定できません。' };
  return { ok: true, config: { url, publishableKey } };
}

export function createSupabaseClient(env: Record<string, string | undefined> = process.env): SupabaseClient | null {
  const result = getSupabaseConfig(env);
  if (!result.ok) return null;
  return createClient(result.config.url, result.config.publishableKey, {
    auth: {
      ...(Platform.OS !== 'web' ? { storage: AsyncStorage } : {}),
      autoRefreshToken: true,
      persistSession: true,
      detectSessionInUrl: false,
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
