# Codex Report

- task_id: kabumori-personal-important-news-v1-review-artifacts
- result: review_required。ローカル実装を変更せず、migration・アプリ呼び出し・画面・タブ差分を実物から採取した。権限要件との不一致が1件あるため本番適用不可の状態。
- changed_files:
  - `.agent/tasks/CODEX_TASK.md`（statusのみ）
  - `.agent/CODEX_REPORT.md`（このレビュー資料）
- tests:
  - `git diff --check`: PASS
  - 対象5ファイルのSHA-256を取得し、下記掲載物の採取元を固定
  - 新規実装・再ビルド・本番接続テストは今回のscope外のため未実施
- commit_hash: `24713ef`（レビュー資料本体とstatus更新）
- push: `24713ef`をorigin/mainへ反映済み。実装コードはlocal onlyのまま
- deploy: 未実施（禁止）
- remaining_issues:
  - private関数はData API非公開スキーマにあるが、現SQLは`authenticated`へ`USAGE`と`EXECUTE`を明示付与している。このため「authenticatedから直接呼べない」という完了条件をDB権限レベルでは満たさない
  - 本番migration適用前に上記権限設計の修正レビューが必要
  - 実装コードはGitHub未共有。今回はレビュー資料として全文/差分をこのReportへ収録
- safety_checks:
  - 本番DB・本番GRANT・本番データ・Edge Function・Cronは変更していない
  - ローカル実装ファイルは変更していない
  - clean temporary worktreeで`.agent/`以外をstageしない
  - secrets、認証情報、ユーザー情報を記載していない
- next_recommendation: `C`でこの資料をレビューし、private関数のauthenticated直接EXECUTEを撤回する設計変更を別タスクで承認してから本番適用可否を判断する

## Review findings

### 認証・権限境界

- SECURITY DEFINER: `private.get_my_important_stock_news(integer)`
- SECURITY DEFINERの`search_path`: 空文字列 `set search_path = ''`
- `auth.uid()`検証: private関数WHERE句でNULL除外後、`tracked.user_id = (select auth.uid())`
- public入口: `public.get_my_important_stock_news(integer)`、SECURITY INVOKER、`search_path = ''`
- PUBLIC/anon: private/public両関数とも`revoke all`
- authenticated:
  - public関数へEXECUTE付与
  - private schemaへUSAGE付与
  - private関数へEXECUTE付与
- 結論: PostgRESTの標準公開schemaがpublicのみならprivate関数はRPC endpointとして直接露出しない。しかしDBロール権限としてauthenticatedに直接EXECUTEがあるため、「直接呼べない」とは評価できない

### 抽出条件

- company_code形式: `news.company_code ~ '^[0-9A-Z]{5}$'`
- 銘柄一致: `left(news.company_code, 4) = stock.ticker_code`
- 対象登録: 本人、`is_active = true`、holding/watch両方
- 重要度: `important`と`most_important`の両方
- status: `ready_for_publish`と`generation_failed`
- duplicate: `duplicate_of is null`
- 最大件数: 1〜50へ強制、最新順

## Artifact hashes

```text
e5b1928564808bb3c5f74307a9eb708e7087052a6fe5d3bca84edc5c6e1341ef  supabase/migrations/20260905042052_get_my_important_stock_news.sql
8431da6182f6376e621b389443022d67b7b0172e6ade0399970d5262cbaff0d6  src/lib/important-news.ts
6acc1d4989e28c7b694ac9e436c6e45b8de38e30fce8c2a8327f423a7b3888c3  src/app/news.tsx
4c2f596a37e92db144bc7e62fe74fddad256b938210b7831935f18db1d8b6351  src/components/app-tabs.tsx
0a310fa8500e5792bc6ab027c56d9e65be874b01c661876c8cc80eda731f926b  src/components/app-tabs.web.tsx
```

## Migration全文

`supabase/migrations/20260905042052_get_my_important_stock_news.sql`

```sql
create or replace function private.get_my_important_stock_news(
  p_limit integer default 50
)
returns table (
  news_id uuid,
  ticker_code text,
  company_name text,
  tracking_type text,
  title text,
  summary text,
  importance text,
  news_time timestamptz,
  source_url text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    news.id as news_id,
    stock.ticker_code,
    stock.company_name,
    tracked.tracking_type,
    news.title,
    news.body_summary as summary,
    news.importance,
    coalesce(news.published_at, news.created_at) as news_time,
    news.source_url
  from public.tracked_stocks as tracked
  inner join public.stocks_master as stock
    on stock.id = tracked.stock_id
  inner join public.important_news_candidates as news
    on news.company_code ~ '^[0-9A-Z]{5}$'
   and left(news.company_code, 4) = stock.ticker_code
  where (select auth.uid()) is not null
    and tracked.user_id = (select auth.uid())
    and tracked.is_active = true
    and news.importance in ('important', 'most_important')
    and news.status in ('ready_for_publish', 'generation_failed')
    and news.duplicate_of is null
  order by coalesce(news.published_at, news.created_at) desc
  limit greatest(1, least(coalesce(p_limit, 50), 50));
$$;

comment on function private.get_my_important_stock_news(integer) is
  'Security-definer implementation for the authenticated user important-news feed.';

revoke all on function private.get_my_important_stock_news(integer)
  from public, anon, authenticated;
grant usage on schema private to authenticated;
grant execute on function private.get_my_important_stock_news(integer)
  to authenticated;

create or replace function public.get_my_important_stock_news(
  p_limit integer default 50
)
returns table (
  news_id uuid,
  ticker_code text,
  company_name text,
  tracking_type text,
  title text,
  summary text,
  importance text,
  news_time timestamptz,
  source_url text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select *
  from private.get_my_important_stock_news(p_limit);
$$;

comment on function public.get_my_important_stock_news(integer) is
  'Returns a minimal important-news feed for the authenticated user active tracked stocks.';

revoke all on function public.get_my_important_stock_news(integer)
  from public, anon, authenticated;
grant execute on function public.get_my_important_stock_news(integer)
  to authenticated;
```

## Expoデータ取得差分（新規ファイル全文）

`src/lib/important-news.ts`

```ts
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
```

## Expo画面差分（新規ファイル全文）

`src/app/news.tsx`

```tsx
import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import {
  ActivityIndicator,
  FlatList,
  Linking,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  fetchMyImportantStockNews,
  ImportantStockNews,
} from '@/lib/important-news';

const trackingLabels = { holding: '保有', watch: '監視' } as const;

function formatNewsTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('ja-JP', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function canOpenSource(url: string | null): url is string {
  return !!url && /^https?:\/\//i.test(url);
}

export default function ImportantNewsScreen() {
  const [items, setItems] = useState<ImportantStockNews[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasTrackedStocks, setHasTrackedStocks] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const feed = await fetchMyImportantStockNews();
      setItems(feed.items);
      setHasTrackedStocks(feed.hasTrackedStocks);
    } catch (loadError) {
      setItems([]);
      setError(
        loadError instanceof Error
          ? loadError.message
          : '重大ニュースを取得できませんでした。',
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const emptyMessage = error
    || (!hasTrackedStocks
      ? '登録銘柄がありません。検索から保有または監視に追加してみましょう。'
      : '登録銘柄に該当する重大ニュースはまだありません。');

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <View style={styles.container}>
        <Text style={styles.eyebrow}>FOR YOUR STOCKS</Text>
        <Text style={styles.title}>あなたの重要ニュース</Text>
        <Text style={styles.description}>
          保有・監視している銘柄の、大切なニュースだけをまとめます。
        </Text>

        {loading && !items.length ? (
          <ActivityIndicator color="#397449" style={styles.status} />
        ) : null}

        <FlatList
          data={items}
          keyExtractor={(item) => item.news_id}
          contentContainerStyle={[styles.list, !items.length && styles.emptyList]}
          refreshControl={
            <RefreshControl refreshing={loading && !!items.length} onRefresh={load} tintColor="#397449" />
          }
          ListEmptyComponent={
            !loading ? (
              <View style={[styles.emptyCard, !!error && styles.errorCard]}>
                <Text style={[styles.emptyText, !!error && styles.errorText]}>{emptyMessage}</Text>
                {!!error && (
                  <Pressable onPress={() => void load()} style={styles.retryButton}>
                    <Text style={styles.retryText}>もう一度試す</Text>
                  </Pressable>
                )}
              </View>
            ) : null
          }
          renderItem={({ item }) => {
            const holding = item.tracking_type === 'holding';
            const sourceAvailable = canOpenSource(item.source_url);
            return (
              <View style={styles.card}>
                <View style={styles.badgeRow}>
                  <View style={[styles.typeBadge, holding ? styles.holdingBadge : styles.watchBadge]}>
                    <Text style={[styles.typeText, holding ? styles.holdingText : styles.watchText]}>
                      {trackingLabels[item.tracking_type]}
                    </Text>
                  </View>
                  <Text style={styles.ticker}>{item.ticker_code}</Text>
                  <View style={styles.importanceBadge}>
                    <Text style={styles.importanceText}>
                      {item.importance === 'most_important' ? '最重要' : '重要'}
                    </Text>
                  </View>
                </View>
                <Text style={styles.company}>{item.company_name}</Text>
                <Text style={styles.newsTitle}>{item.title}</Text>
                {!!item.summary && <Text style={styles.summary} numberOfLines={3}>{item.summary}</Text>}
                <View style={styles.footer}>
                  <Text style={styles.time}>{formatNewsTime(item.news_time)}</Text>
                  {sourceAvailable && (
                    <Pressable onPress={() => void Linking.openURL(item.source_url!)} hitSlop={8}>
                      <Text style={styles.sourceLink}>記事を開く</Text>
                    </Pressable>
                  )}
                </View>
              </View>
            );
          }}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#f7f8f5' },
  container: { flex: 1, width: '100%', maxWidth: 720, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 20 },
  eyebrow: { color: '#548161', fontWeight: '900', letterSpacing: 2, fontSize: 12 },
  title: { color: '#17211a', fontSize: 30, fontWeight: '900', marginTop: 6 },
  description: { color: '#667169', fontSize: 15, lineHeight: 22, marginTop: 8, marginBottom: 12 },
  status: { marginTop: 36 },
  list: { paddingTop: 8, paddingBottom: 110, gap: 12 },
  emptyList: { flexGrow: 1 },
  emptyCard: { marginTop: 24, borderRadius: 18, backgroundColor: '#eef3ed', padding: 22, alignItems: 'center' },
  errorCard: { backgroundColor: '#fff0ef' },
  emptyText: { color: '#5e6d63', textAlign: 'center', lineHeight: 22 },
  errorText: { color: '#9a403b' },
  retryButton: { marginTop: 16, borderRadius: 10, backgroundColor: '#397449', paddingHorizontal: 16, paddingVertical: 10 },
  retryText: { color: '#fff', fontWeight: '800' },
  card: { backgroundColor: '#fff', borderRadius: 18, borderWidth: 1, borderColor: '#e1e5e2', padding: 17 },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  typeBadge: { borderRadius: 99, paddingHorizontal: 10, paddingVertical: 5 },
  holdingBadge: { backgroundColor: '#e4f1e7' },
  watchBadge: { backgroundColor: '#fff0d7' },
  typeText: { fontSize: 12, fontWeight: '900' },
  holdingText: { color: '#2c6940' },
  watchText: { color: '#946222' },
  ticker: { color: '#4b5b51', fontWeight: '900' },
  importanceBadge: { marginLeft: 'auto', borderRadius: 99, backgroundColor: '#fde8e5', paddingHorizontal: 10, paddingVertical: 5 },
  importanceText: { color: '#a23e37', fontSize: 12, fontWeight: '900' },
  company: { color: '#526058', fontWeight: '700', fontSize: 14, marginTop: 11 },
  newsTitle: { color: '#17211a', fontWeight: '900', fontSize: 18, lineHeight: 25, marginTop: 8 },
  summary: { color: '#647068', fontSize: 14, lineHeight: 21, marginTop: 9 },
  footer: { flexDirection: 'row', alignItems: 'center', marginTop: 14 },
  time: { color: '#89918c', fontSize: 12 },
  sourceLink: { color: '#397449', fontSize: 13, fontWeight: '800', marginLeft: 16 },
});
```

## ニュースタブ追加差分

既存ローカルのタブファイルには前workstream差分も含まれるため、今回追加したhunkだけを掲載する。

`src/components/app-tabs.tsx`

```diff
+      <NativeTabs.Trigger name="news">
+        <NativeTabs.Trigger.Label>重要ニュース</NativeTabs.Trigger.Label>
+        <NativeTabs.Trigger.Icon
+          sf={{ default: 'newspaper', selected: 'newspaper.fill' }}
+          src={require('@/assets/images/tabIcons/explore.png')}
+          renderingMode="template"
+        />
+      </NativeTabs.Trigger>
```

`src/components/app-tabs.web.tsx`

```diff
+          <TabTrigger name="news" href="/news" asChild>
+            <TabButton>重要ニュース</TabButton>
+          </TabTrigger>
```
