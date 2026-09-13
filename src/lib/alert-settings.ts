import { supabase } from '@/lib/supabase';

export const notificationPresets = ['quiet', 'standard', 'many', 'all_useful'] as const;
export type NotificationPreset = typeof notificationPresets[number];

export const presetOptions: Array<{
  value: NotificationPreset;
  label: string;
  description: string;
}> = [
  { value: 'quiet', label: '静かめ', description: '保有・監視は最重要、市場は緊急だけ' },
  { value: 'standard', label: '標準', description: '保有・監視は重要以上、市場は最重要以上' },
  { value: 'many', label: '多め', description: '保有・監視は注目以上、市場は重要以上' },
  { value: 'all_useful', label: 'かなり多め', description: '注目以上の役立つニュースを幅広く' },
];

export const alertCategories = [
  'geopolitics', 'disaster', 'monetary_policy', 'fx', 'rates', 'oil_energy',
  'commodities', 'shipping_logistics', 'semiconductors', 'ai_tech', 'us_market',
  'japan_market', 'regulation_policy', 'corporate', 'earnings', 'financial_system',
] as const;

export type AlertCategory = typeof alertCategories[number];

export type ImportantNewsAlertPreferences = {
  importantNews: boolean;
  preset: NotificationPreset;
  emergencyAlerts: boolean;
  enabledCategories: Record<AlertCategory, boolean>;
};

function isNotificationPreset(value: unknown): value is NotificationPreset {
  return typeof value === 'string' && (notificationPresets as readonly string[]).includes(value);
}

function defaultCategories(): Record<AlertCategory, boolean> {
  return Object.fromEntries(alertCategories.map((category) => [category, true])) as Record<AlertCategory, boolean>;
}

export async function fetchImportantNewsAlertPreferences(): Promise<ImportantNewsAlertPreferences> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) throw new Error('通知設定を見るにはログインが必要です。');

  const [settingsResult, categoriesResult] = await Promise.all([
    supabase
      .from('alert_settings')
      .select('important_news,market_critical_news,notification_preset,emergency_alerts')
      .eq('user_id', userData.user.id)
      .maybeSingle(),
    supabase
      .from('alert_category_settings')
      .select('category,enabled')
      .eq('user_id', userData.user.id),
  ]);
  if (settingsResult.error) throw new Error(`通知設定を取得できませんでした。${settingsResult.error.message}`);
  if (categoriesResult.error) throw new Error(`カテゴリ設定を取得できませんでした。${categoriesResult.error.message}`);

  const row = settingsResult.data;
  const preset = isNotificationPreset(row?.notification_preset)
    ? row.notification_preset
    : !row || row.market_critical_news === true ? 'standard' : 'quiet';
  const enabledCategories = defaultCategories();
  for (const setting of categoriesResult.data ?? []) {
    if ((alertCategories as readonly string[]).includes(setting.category)) {
      enabledCategories[setting.category as AlertCategory] = setting.enabled !== false;
    }
  }
  return {
    importantNews: row?.important_news !== false,
    preset,
    // Existing rows stay fail-closed until the user explicitly saves this setting.
    emergencyAlerts: row ? row.emergency_alerts === true : true,
    enabledCategories,
  };
}

export async function saveImportantNewsAlertPreferences(
  preferences: ImportantNewsAlertPreferences,
): Promise<void> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) throw new Error('通知設定を変更するにはログインが必要です。');
  const categorySettings = Object.fromEntries(
    alertCategories.map((category) => [category, preferences.enabledCategories[category]]),
  );
  const { error } = await supabase.rpc('set_my_important_news_alert_preferences', {
    p_important_news: preferences.importantNews,
    p_notification_preset: preferences.preset,
    p_emergency_alerts: preferences.emergencyAlerts,
    p_category_settings: categorySettings,
  });
  if (error) throw new Error(`通知設定を保存できませんでした。${error.message}`);
}

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
