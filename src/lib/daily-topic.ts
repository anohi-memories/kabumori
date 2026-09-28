import { supabase } from '@/lib/supabase';
import { parseDailyTipRow, type HomeTopic, type TopicLevel } from '@/lib/home-topic';

// Reads one deterministic row from the read-only get_daily_kabumori_tip RPC
// (public.tips, unrelated to public.useful_tips / the X scheduler). No LLM
// call, no write, no use_count/last_used_at mutation -- the RPC itself is
// STABLE SQL. The same (level, jstDate) always returns the same tip, so a
// pull-to-refresh never changes today's topic.
export async function fetchDailyTopic(level: TopicLevel, jstDate: string): Promise<HomeTopic | null> {
  const { data, error } = await supabase.rpc('get_daily_kabumori_tip', {
    p_level: level,
    p_jst_date: jstDate,
  });
  if (error) throw new Error(`今日のトピックを取得できませんでした。${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  return parseDailyTipRow(row);
}
