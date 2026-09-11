import { supabase } from '@/lib/supabase';

export type ImportantStockNews = {
  news_id: string;
  // null for market-wide news, which is shown through a matching sector instead of a ticker.
  ticker_code: string | null;
  company_name: string;
  tracking_type: 'holding' | 'watch';
  title: string;
  summary: string | null;
  // X-oriented tier. Items shown for app relevance only (severity 'medium') can be 'no_post'.
  importance: 'important' | 'most_important' | 'no_post';
  news_time: string;
  source_url: string | null;
  // App-facing severity from get_my_important_stock_news. Optional so an
  // older RPC without the column still renders.
  severity?: 'critical' | 'high' | 'medium';
  // Market-wide items only: the tracked sector that made the item relevant, and
  // the transmission themes (e.g. "fx,rates"). null for per-stock items.
  matched_sector?: string | null;
  relevance_reason?: string | null;
  // 'tdnet' / 'company_ir' / 'market_macro' / 'breaking_market'.
  source_type?: string | null;
  // Japanese post text generated at publish time; the RPC returns it only when
  // its Fact check passed, otherwise null.
  verified_text?: string | null;
};

// The detail screen reuses the feed RPC so it inherits exactly the same access
// boundary (own active tracked stocks / related market items); an id outside the
// user's feed simply is not found.
export async function fetchMyImportantNewsItem(newsId: string): Promise<ImportantStockNews | null> {
  const feed = await fetchMyImportantStockNews();
  return feed.items.find((item) => item.news_id === newsId) ?? null;
}

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
