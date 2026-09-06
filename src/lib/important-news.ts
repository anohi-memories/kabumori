import { supabase } from '@/lib/supabase';

export type ImportantStockNews = {
  news_id: string;
  ticker_code: string;
  company_name: string;
  tracking_type: 'holding' | 'watch';
  title: string;
  summary: string | null;
  importance: 'important' | 'most_important';
  news_time: string;
  source_url: string | null;
};

export type ImportantNewsFeed = {
  hasTrackedStocks: boolean;
  items: ImportantStockNews[];
};

export async function fetchMyImportantStockNews(): Promise<ImportantNewsFeed> {
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData.user) {
    throw new Error('重大ニュースを見るにはログインが必要です。');
  }

  const { data: tracked, error: trackedError } = await supabase
    .from('tracked_stocks')
    .select('id')
    .eq('user_id', userData.user.id)
    .eq('is_active', true)
    .limit(1);
  if (trackedError) {
    throw new Error(`登録銘柄を確認できませんでした。${trackedError.message}`);
  }

  const hasTrackedStocks = !!tracked?.length;
  if (!hasTrackedStocks) return { hasTrackedStocks, items: [] };

  const { data, error } = await supabase.rpc('get_my_important_stock_news', {
    p_limit: 50,
  });
  if (error) {
    throw new Error(`重大ニュースを取得できませんでした。${error.message}`);
  }

  return {
    hasTrackedStocks,
    items: (data ?? []) as ImportantStockNews[],
  };
}
