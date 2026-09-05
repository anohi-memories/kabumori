import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { TrackedStockEditor } from '@/components/tracked-stock-editor';
import { StockMaster } from '@/lib/stocks';
import { supabase } from '@/lib/supabase';

export default function StockSearchScreen() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<StockMaster[]>([]);
  const [selected, setSelected] = useState<StockMaster | null>(null);
  const [registeredIds, setRegisteredIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('銘柄コードまたは会社名を入力してください。');
  const requestId = useRef(0);

  useEffect(() => {
    const term = query.trim();
    if (!term) {
      requestId.current += 1;
      setResults([]);
      setRegisteredIds(new Set());
      setLoading(false);
      setMessage('銘柄コードまたは会社名を入力してください。');
      return;
    }
    const timer = setTimeout(() => void search(term), 350);
    return () => clearTimeout(timer);
  }, [query]);

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

    const escaped = term.replace(/[,%()]/g, ' ').trim();
    const { data, error } = await supabase
      .from('stocks_master')
      .select('id,ticker_code,company_name,market')
      .eq('is_listed', true)
      .or(`ticker_code.ilike.%${escaped}%,company_name.ilike.%${escaped}%`)
      .order('ticker_code')
      .limit(30);
    if (currentRequest !== requestId.current) return;
    if (error) {
      setResults([]);
      setLoading(false);
      setMessage(`検索できませんでした。${error.message}`);
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
      if (trackedError) {
        setMessage(`登録状況を確認できませんでした。${trackedError.message}`);
      }
      setRegisteredIds(new Set((tracked ?? []).map((item) => item.stock_id as string)));
    } else {
      setRegisteredIds(new Set());
    }
    setLoading(false);
    if (!stocks.length) setMessage('該当する銘柄が見つかりませんでした。');
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <View style={styles.container}>
        <Text style={styles.eyebrow}>KABUMORI</Text>
        <Text style={styles.title}>株を検索</Text>
        <Text style={styles.description}>気になる会社を探して、保有または監視に登録できます。</Text>
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="例：8136 または サンリオ"
          placeholderTextColor="#8a958e"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          style={styles.searchInput}
        />
        {loading && <ActivityIndicator color="#397449" style={styles.status} />}
        {!loading && !!message && <Text style={styles.message}>{message}</Text>}
        <FlatList
          data={results}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => {
            const registered = registeredIds.has(item.id);
            return (
              <Pressable
                onPress={() => !registered && setSelected(item)}
                style={({ pressed }) => [styles.card, pressed && !registered && styles.pressed]}>
                <View style={styles.cardMain}>
                  <Text style={styles.ticker}>{item.ticker_code}</Text>
                  <Text style={styles.company}>{item.company_name}</Text>
                  <Text style={styles.market}>{item.market}</Text>
                </View>
                <View style={[styles.badge, registered && styles.registeredBadge]}>
                  <Text style={[styles.badgeText, registered && styles.registeredText]}>
                    {registered ? '登録済み' : '登録する'}
                  </Text>
                </View>
              </Pressable>
            );
          }}
        />
      </View>
      <TrackedStockEditor
        stock={selected}
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
  safeArea: { flex: 1, backgroundColor: '#f7f8f5' },
  container: { flex: 1, width: '100%', maxWidth: 720, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 20 },
  eyebrow: { color: '#548161', fontWeight: '900', letterSpacing: 2, fontSize: 12 },
  title: { color: '#17211a', fontSize: 32, fontWeight: '900', marginTop: 6 },
  description: { color: '#667169', fontSize: 15, lineHeight: 22, marginTop: 8, marginBottom: 20 },
  searchInput: { minHeight: 54, backgroundColor: '#fff', borderWidth: 1, borderColor: '#d9dfda', borderRadius: 16, paddingHorizontal: 17, fontSize: 17, color: '#17211a' },
  status: { marginTop: 28 },
  message: { color: '#6f7972', textAlign: 'center', marginTop: 28, lineHeight: 22 },
  list: { paddingTop: 14, paddingBottom: 100, gap: 10 },
  card: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', borderRadius: 16, borderWidth: 1, borderColor: '#e1e5e2', padding: 16 },
  pressed: { opacity: 0.65 },
  cardMain: { flex: 1, gap: 3 },
  ticker: { color: '#447052', fontWeight: '900', fontSize: 14 },
  company: { color: '#17211a', fontWeight: '800', fontSize: 17 },
  market: { color: '#7a857e', fontSize: 13 },
  badge: { backgroundColor: '#e7f2e9', borderRadius: 99, paddingHorizontal: 12, paddingVertical: 8 },
  badgeText: { color: '#2f6b3e', fontWeight: '800', fontSize: 12 },
  registeredBadge: { backgroundColor: '#eef0ee' },
  registeredText: { color: '#7a817c' },
});
