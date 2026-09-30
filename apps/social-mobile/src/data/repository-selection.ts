import { getSupabaseConfig, supabase } from '@/lib/supabase';
import { mockRepository } from '@/data/mock-repository';
import { SupabaseSocialRepository } from '@/data/supabase-repository';
import type { SocialOperationsRepository } from '@/data/repository';
import { dataSourceMode, INVALID_DATA_SOURCE_REASON, initialDataStatusFor, type InitialDataStatus } from '@/data/data-source-mode';

export type DataSourceSelection = { kind: 'mock'; repository: SocialOperationsRepository } | { kind: 'supabase'; repository: SupabaseSocialRepository } | { kind: 'blocked'; reason: string };

// Expo only inlines EXPO_PUBLIC_* values that are referenced statically. Passing
// the whole `process.env` object around leaves every key absent from a native
// (iOS/Android) bundle, which silently turned real-data builds into the mock
// preview. These direct property accesses are the single source for both this
// selection and the provider's initial status.
const staticPublicEnv: Record<string, string | undefined> = {
  EXPO_PUBLIC_DATA_SOURCE: process.env.EXPO_PUBLIC_DATA_SOURCE,
  EXPO_PUBLIC_SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL,
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
};

export function selectDataSource(env: Record<string, string | undefined> = staticPublicEnv): DataSourceSelection {
  const mode = dataSourceMode(env.EXPO_PUBLIC_DATA_SOURCE);
  if (mode === 'mock') return { kind: 'mock', repository: mockRepository };
  if (mode === 'invalid') return { kind: 'blocked', reason: INVALID_DATA_SOURCE_REASON };
  const config = getSupabaseConfig(env);
  if (!config.ok || !supabase) return { kind: 'blocked', reason: config.ok ? 'Supabase clientを作成できません。' : config.reason };
  return { kind: 'supabase', repository: new SupabaseSocialRepository(supabase) };
}

/** Status before the first load, derived from the same source as selectDataSource(). */
export function initialDataStatus(env: Record<string, string | undefined> = staticPublicEnv): InitialDataStatus {
  return initialDataStatusFor(dataSourceMode(env.EXPO_PUBLIC_DATA_SOURCE));
}
