import { supabase } from '@/lib/supabase';

// The push-sending function (supabase/functions/send-push-notifications)
// writes to public.notifications with source_type='important_news' whenever
// it delivers an important-news push. Viewing the important-news feed is
// treated as having seen those notifications, so this bulk-marks them read
// -- authenticated only has UPDATE(read_at) on this table (GRANT hardening
// in 20260903150000_kabumori_grants.sql), so title/summary/push_status stay
// untouched here.
export async function markImportantNewsNotificationsRead(): Promise<void> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) return;

  const { error } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('user_id', userData.user.id)
    .eq('source_type', 'important_news')
    .is('read_at', null);
  // Best-effort: a failure here must never block the news feed itself.
  if (error) console.warn('[notifications] mark-read failed:', error.message);
}
