import { getSupabaseConfig, supabase } from '@/lib/supabase';
import { mockRepository } from '@/data/mock-repository';
import { SupabaseSocialRepository } from '@/data/supabase-repository';
import type { SocialOperationsRepository } from '@/data/repository';

export type DataSourceSelection = { kind: 'mock'; repository: SocialOperationsRepository } | { kind: 'supabase'; repository: SupabaseSocialRepository } | { kind: 'blocked'; reason: string };

export function selectDataSource(env: Record<string, string | undefined> = process.env): DataSourceSelection {
  if (env.EXPO_PUBLIC_DATA_SOURCE !== 'supabase') return { kind: 'mock', repository: mockRepository };
  const config = getSupabaseConfig(env);
  if (!config.ok || !supabase) return { kind: 'blocked', reason: config.ok ? 'Supabase clientを作成できません。' : config.reason };
  return { kind: 'supabase', repository: new SupabaseSocialRepository(supabase) };
}
