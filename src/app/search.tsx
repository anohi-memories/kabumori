import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { BackButton } from '@/components/back-button';
import { StockAvatar } from '@/components/portfolio/stock-avatar';
import { TrackedStockEditor } from '@/components/tracked-stock-editor';
import { KABUMORI_COLORS } from '@/constants/kabumori-theme';
import { avatarLabel } from '@/lib/portfolio-view';
import {
  STOCK_SEARCH_DEBOUNCE_MS,
  STOCK_SEARCH_LIMIT,
  STOCK_SEARCH_PROMPT,
  stockSearchFilter,
} from '@/lib/stock-search';
import type { StockMaster } from '@/lib/stocks';
import { supabase } from '@/lib/supabase';

const colors = KABUMORI_COLORS.light;

// Stock search as its own screen (a root Stack route; it used to redirect into the 銘柄 tab). Same behaviour
// as before: code / company-name search, debounced, sanitized, at most 30 results, a registered-state check,
// and an unregistered result opens the editor so it can be added as a holding or a watch stock.
export default function SearchScreen() {
  const input = useRef<TextInput>(null);
  const requestId = useRef(0);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<StockMaster[]>([]);
  const [registeredIds, setRegisteredIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(STOCK_SEARCH_PROMPT);
  const [selected, setSelected] = useState<StockMaster | null>(null);

  async function search(term: string) {
    const currentRequest = ++requestId.current;
    setLoading(true);
    setMessage('');
    const { data: authData, error: authError } = await supabase.auth.getUser();
    if (currentRequest !== requestId.current) return;
    if (authError || !authData.user) {
      setResults([]);
      setLoading(false);
      setMessage('検索するにはログインが必要です。');
      return;
    }

    const { data, error } = await supabase
      .from('stocks_master')
      .select('id,ticker_code,company_name,market')
      .eq('is_listed', true)
      .or(stockSearchFilter(term))
      .order('ticker_code')
      .limit(STOCK_SEARCH_LIMIT);
    if (currentRequest !== requestId.current) return;
    if (error) {
      setResults([]);
      setLoading(false);
      setMessage('検索できませんでした。');
      return;
    }

    const stocks = (data ?? []) as StockMaster[];
    setResults(stocks);
    if (stocks.length) {
      const { data: tracked, error: trackedError } = await supabase
        .from('tracked_stocks')
        .select('stock_id')
        .eq('user_id', authData.user.id)
        .in('stock_id', stocks.map((stock) => stock.id));
      if (currentRequest !== requestId.current) return;
      setRegisteredIds(new Set((tracked ?? []).map((item) => item.stock_id as string)));
      if (trackedError) setMessage('登録状況を確認できませんでした。');
    } else {
      setRegisteredIds(new Set());
    }
    setLoading(false);
    if (!stocks.length) setMessage('該当する銘柄が見つかりませんでした。');
  }

  useEffect(() => {
    const term = query.trim();
    if (!term) {
      requestId.current += 1;
      setResults([]);
      setRegisteredIds(new Set());
      setLoading(false);
      setMessage(STOCK_SEARCH_PROMPT);
      return;
    }
    const timer = setTimeout(() => void search(term), STOCK_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const timer = setTimeout(() => input.current?.focus(), 150);
    return () => clearTimeout(timer);
  }, []);

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      <View style={styles.container}>
        <BackButton />
        <Text style={styles.eyebrow}>SEARCH</Text>
        <Text style={styles.title}>銘柄を探す</Text>
        <TextInput
          ref={input}
          value={query}
          onChangeText={setQuery}
          placeholder="銘柄コードまたは会社名（例：8136）"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          style={styles.searchInput}
          accessibilityLabel="銘柄コードまたは会社名で検索"
        />
        {loading ? <ActivityIndicator color={colors.accent} style={styles.status} /> : null}
        {!loading && !!message ? <Text style={styles.message}>{message}</Text> : null}
        <FlatList
          data={results}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => {
            const registered = registeredIds.has(item.id);
            return (
              <Pressable
                onPress={() => { if (!registered) setSelected(item); }}
                style={({ pressed }) => [styles.card, pressed && !registered && styles.pressed]}
                accessibilityRole="button"
                accessibilityLabel={`${item.ticker_code} ${item.company_name}`}
                accessibilityHint={registered ? '登録済みです' : '保有または監視に登録します'}>
                <StockAvatar label={avatarLabel(item.company_name, item.ticker_code)} name={item.company_name} size={40} />
                <View style={styles.cardMain}>
                  <Text style={styles.ticker}>{item.ticker_code}</Text>
                  <Text style={styles.company} numberOfLines={2}>{item.company_name}</Text>
                  <Text style={styles.market}>{item.market}</Text>
                </View>
                <View style={[styles.badge, registered && styles.registeredBadge]}>
                  <Text style={[styles.badgeText, registered && styles.registeredText]}>{registered ? '登録済み' : '登録する'}</Text>
                </View>
              </Pressable>
            );
          }}
        />
      </View>
      <TrackedStockEditor
        stock={selected}
        existing={null}
        visible={!!selected}
        onClose={() => setSelected(null)}
        onSaved={() => {
          if (selected) setRegisteredIds((ids) => new Set(ids).add(selected.id));
          setSelected(null);
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  container: { flex: 1, width: '100%', maxWidth: 720, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 8 },
  eyebrow: { color: colors.accent, fontWeight: '900', letterSpacing: 2, fontSize: 11, marginTop: 4 },
  title: { color: colors.text, fontSize: 26, fontWeight: '900', marginTop: 4, marginBottom: 12 },
  searchInput: { minHeight: 52, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.inputBorder, borderRadius: 16, paddingHorizontal: 17, fontSize: 16, color: colors.text },
  status: { marginTop: 24 },
  message: { color: colors.muted, textAlign: 'center', marginTop: 22, lineHeight: 22 },
  list: { paddingTop: 14, paddingBottom: 60, gap: 10 },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: colors.card, borderRadius: 18, borderWidth: 1, borderColor: colors.border, padding: 14 },
  pressed: { opacity: 0.65 },
  cardMain: { flex: 1, minWidth: 0, gap: 2 },
  ticker: { color: colors.accent, fontWeight: '900', fontSize: 13 },
  company: { color: colors.text, fontWeight: '800', fontSize: 16, lineHeight: 21 },
  market: { color: colors.muted, fontSize: 12 },
  badge: { backgroundColor: colors.accentSoft, borderRadius: 99, paddingHorizontal: 12, paddingVertical: 8 },
  badgeText: { color: colors.accent, fontWeight: '800', fontSize: 12 },
  registeredBadge: { backgroundColor: colors.border },
  registeredText: { color: colors.muted },
});
