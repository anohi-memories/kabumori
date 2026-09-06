import { supabase } from '@/lib/supabase';

// Mirrors public.alert_settings' column defaults (20260901061217_add_kabumori_mvp_tables.sql)
// for a user who has never saved a row yet -- the row is created lazily on
// first save via upsertMyAlertSettings, not on login.
export type MyAlertSettings = {
  important_news: boolean;
  push_enabled: boolean;
};

const DEFAULT_ALERT_SETTINGS: MyAlertSettings = {
  important_news: true,
  push_enabled: true,
};

export async function fetchMyAlertSettings(): Promise<MyAlertSettings> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    throw new Error('通知設定を見るにはログインが必要です。');
  }

  const { data, error } = await supabase
    .from('alert_settings')
    .select('important_news,push_enabled')
    .eq('user_id', userData.user.id)
    .maybeSingle();
  if (error) throw new Error(`通知設定を取得できませんでした。${error.message}`);

  return data ?? DEFAULT_ALERT_SETTINGS;
}

export async function upsertMyAlertSettings(settings: MyAlertSettings): Promise<void> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    throw new Error('通知設定を保存するにはログインが必要です。');
  }

  const { error } = await supabase
    .from('alert_settings')
    .upsert({ user_id: userData.user.id, ...settings }, { onConflict: 'user_id' });
  if (error) throw new Error(`通知設定を保存できませんでした。${error.message}`);
}
