import { supabase } from '@/lib/supabase';

// Opt-in for pushes about market-wide Critical news (tariffs, wars, FX
// intervention, surprise central-bank moves, oil/shipping disruptions) that
// relate to a sector the user tracks. Off by default: a user without an
// alert_settings row, or with the flag off, never receives them.
export async function fetchMarketCriticalAlert(): Promise<boolean> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) return false;
  const { data, error } = await supabase
    .from('alert_settings')
    .select('market_critical_news')
    .eq('user_id', userData.user.id)
    .maybeSingle();
  if (error) throw new Error(`通知設定を取得できませんでした。${error.message}`);
  return data?.market_critical_news === true;
}

export async function setMarketCriticalAlert(enabled: boolean): Promise<void> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) throw new Error('通知設定を変更するにはログインが必要です。');
  // Only this column is written; a new row keeps every other setting at its default.
  const { error } = await supabase
    .from('alert_settings')
    .upsert({ user_id: userData.user.id, market_critical_news: enabled }, { onConflict: 'user_id' });
  if (error) throw new Error(`通知設定を保存できませんでした。${error.message}`);
}
