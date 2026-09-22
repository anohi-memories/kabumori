import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { TrackedStockEditor } from '@/components/tracked-stock-editor';
import { KABUMORI_COLORS } from '@/constants/kabumori-theme';
import { authErrorMessage, signOut } from '@/lib/auth';
import { StockMaster, TrackedStock } from '@/lib/stocks';
import { stockScreenMode } from '@/lib/stock-search';
import { supabase } from '@/lib/supabase';

const colors = KABUMORI_COLORS.light;
const positionLabels = { cash: '現物', margin: '信用', long: '買い', short: '売り' } as const;

export default function TrackedStocksScreen() {
  const { focus } = useLocalSearchParams<{ focus?: string }>();
  const searchInput = useRef<TextInput>(null);
  const requestId = useRef(0);
  const [items, setItems] = useState<TrackedStock[]>([]);
  const [selectedStock, setSelectedStock] = useState<StockMaster | null>(null);
  const [selectedTracked, setSelectedTracked] = useState<TrackedStock | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<StockMaster[]>([]);
  const [registeredIds, setRegisteredIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [searchLoading, setSearchLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [searchMessage, setSearchMessage] = useState('銘柄コードまたは会社名を入力してください。');

  const load = useCallback(async () => {
    setLoading(true);
    setMessage('');
    const { data: authData, error: authError } = await supabase.auth.getUser();
    if (authError || !authData.user) {
      setItems([]);
      setLoading(false);
      setMessage('一覧を見るにはログインが必要です。');
      return;
    }
    const { data, error } = await supabase
      .from('tracked_stocks')
      .select('id,user_id,stock_id,tracking_type,quantity,average_price,position_type,side,target_buy_price,target_sell_price,memo,stocks_master!inner(id,ticker_code,company_name,market)')
      .eq('user_id', authData.user.id)
      .eq('is_active', true)
      .order('created_at', { ascending: false });
    if (error) {
      setItems([]);
      setMessage('一覧を読み込めませんでした。');
    } else {
      setItems((data ?? []) as unknown as TrackedStock[]);
      setMessage(data?.length ? '' : 'まだ登録銘柄がありません。上の検索から追加してみましょう。');
    }
    setLoading(false);
  }, []);

  async function search(term: string) {
    const currentRequest = ++requestId.current;
    setSearchLoading(true);
    setSearchMessage('');
    const { data: authData, error: authError } = await supabase.auth.getUser();
    if (currentRequest !== requestId.current) return;
    if (authError || !authData.user) {
      setResults([]);
      setSearchLoading(false);
      setSearchMessage('検索するにはログインが必要です。');
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
      setSearchLoading(false);
      setSearchMessage('検索できませんでした。');
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
      if (trackedError) setSearchMessage('登録状況を確認できませんでした。');
    } else {
      setRegisteredIds(new Set());
    }
    setSearchLoading(false);
    if (!stocks.length) setSearchMessage('該当する銘柄が見つかりませんでした。');
  }

  useEffect(() => {
    const term = query.trim();
    if (!term) {
      requestId.current += 1;
      setResults([]);
      setRegisteredIds(new Set());
      setSearchLoading(false);
      setSearchMessage('銘柄コードまたは会社名を入力してください。');
      return;
    }
    const timer = setTimeout(() => void search(term), 350);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (focus !== 'search') return undefined;
    const timer = setTimeout(() => searchInput.current?.focus(), 120);
    return () => clearTimeout(timer);
  }, [focus]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  async function logOut() {
    try {
      await signOut();
    } catch (error) {
      Alert.alert('ログアウト失敗', authErrorMessage(error));
    }
  }

  const searchMode = stockScreenMode(query) === 'search';
  const selected = selectedTracked ?? selectedStock;

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <View style={styles.container}>
        <View style={styles.headingRow}>
          <View>
            <Text style={styles.eyebrow}>MY STOCKS</Text>
            <Text style={styles.title}>銘柄</Text>
          </View>
          <Pressable onPress={() => void logOut()} style={styles.logoutButton} accessibilityRole="button">
            <Text style={styles.logoutText}>ログアウト</Text>
          </Pressable>
        </View>
        <Text style={styles.description}>登録銘柄の確認と、銘柄の検索・追加ができます。</Text>
        <TextInput
          ref={searchInput}
          value={query}
          onChangeText={setQuery}
          placeholder="銘柄コードまたは会社名（例：8136、サンリオ）"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          style={styles.searchInput}
          accessibilityLabel="銘柄コードまたは会社名で検索"
        />

        {searchMode ? (
          <View style={styles.listArea}>
            {searchLoading ? <ActivityIndicator color={colors.accent} style={styles.status} /> : null}
            {!searchLoading && !!searchMessage ? <Text style={styles.message}>{searchMessage}</Text> : null}
            <FlatList
              data={results}
              keyExtractor={(item) => item.id}
              contentContainerStyle={styles.list}
              keyboardShouldPersistTaps="handled"
              renderItem={({ item }) => {
                const registered = registeredIds.has(item.id);
                return (
                  <Pressable
                    onPress={() => { if (!registered) setSelectedStock(item); }}
                    style={({ pressed }) => [styles.card, pressed && !registered && styles.pressed]}
                    accessibilityRole="button"
                    accessibilityLabel={`${item.ticker_code} ${item.company_name}`}
                    accessibilityHint={registered ? '登録済みです' : '保有または監視に登録します'}>
                    <View style={styles.cardMain}>
                      <Text style={styles.ticker}>{item.ticker_code}</Text>
                      <Text style={styles.company}>{item.company_name}</Text>
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
        ) : (
          <View style={styles.listArea}>
            {loading && !items.length ? <ActivityIndicator color={colors.accent} style={styles.status} /> : null}
            {!loading && !!message ? <Text style={styles.message}>{message}</Text> : null}
            <FlatList
              data={items}
              keyExtractor={(item) => item.id}
              contentContainerStyle={styles.list}
              refreshControl={<RefreshControl refreshing={loading && !!items.length} onRefresh={load} tintColor={colors.accent} />}
              renderItem={({ item }) => {
                const holding = item.tracking_type === 'holding';
                return (
                  <Pressable onPress={() => setSelectedTracked(item)} style={({ pressed }) => [styles.card, pressed && styles.pressed]}>
                    <View style={styles.topRow}>
                      <View style={[styles.typeBadge, holding ? styles.holdingBadge : styles.watchBadge]}>
                        <Text style={[styles.typeText, holding ? styles.holdingText : styles.watchText]}>{holding ? '保有' : '監視'}</Text>
                      </View>
                      <Text style={styles.ticker}>{item.stocks_master.ticker_code}</Text>
                      <Text style={styles.market}>{item.stocks_master.market}</Text>
                    </View>
                    <Text style={styles.company}>{item.stocks_master.company_name}</Text>
                    <View style={styles.details}>
                      {holding && item.quantity != null && <Text style={styles.detail}>保有株数 {item.quantity.toLocaleString()}</Text>}
                      {holding && item.average_price != null && <Text style={styles.detail}>平均取得価格 ¥{item.average_price.toLocaleString()}</Text>}
                      {holding && item.position_type && <Text style={styles.detail}>{positionLabels[item.position_type]}</Text>}
                      {holding && item.side && <Text style={styles.detail}>{positionLabels[item.side]}</Text>}
                      {!holding && item.target_buy_price != null && <Text style={styles.detail}>買いたい ¥{item.target_buy_price.toLocaleString()}</Text>}
                      {!holding && item.target_sell_price != null && <Text style={styles.detail}>売りたい ¥{item.target_sell_price.toLocaleString()}</Text>}
                    </View>
                    <Text style={styles.editHint}>タップして編集</Text>
                  </Pressable>
                );
              }}
            />
          </View>
        )}
      </View>
      <TrackedStockEditor
        stock={selectedTracked?.stocks_master ?? selectedStock}
        existing={selectedTracked}
        visible={!!selected}
        onClose={() => { setSelectedTracked(null); setSelectedStock(null); }}
        onSaved={() => {
          if (selectedStock) setRegisteredIds((ids) => new Set(ids).add(selectedStock.id));
          setSelectedTracked(null);
          setSelectedStock(null);
          void load();
        }}
        onDeleted={() => { setSelectedTracked(null); setSelectedStock(null); void load(); }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  container: { flex: 1, width: '100%', maxWidth: 720, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 20 },
  headingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  eyebrow: { color: colors.accent, fontWeight: '900', letterSpacing: 2, fontSize: 12 },
  title: { color: colors.text, fontSize: 30, fontWeight: '900', marginTop: 6 },
  logoutButton: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, backgroundColor: colors.accentSoft },
  logoutText: { color: colors.muted, fontSize: 12, fontWeight: '800' },
  description: { color: colors.muted, fontSize: 15, lineHeight: 22, marginTop: 8, marginBottom: 14 },
  searchInput: { minHeight: 52, backgroundColor: colors.card, borderWidth: 1, borderColor: colors.inputBorder, borderRadius: 16, paddingHorizontal: 17, fontSize: 16, color: colors.text },
  listArea: { flex: 1 },
  status: { marginTop: 28 },
  message: { color: colors.muted, textAlign: 'center', marginTop: 22, lineHeight: 22 },
  list: { paddingTop: 14, paddingBottom: 100, gap: 12 },
  card: { backgroundColor: colors.card, borderRadius: 18, borderWidth: 1, borderColor: colors.border, padding: 17 },
  pressed: { opacity: 0.65 },
  cardMain: { flex: 1, gap: 3 },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  typeBadge: { borderRadius: 99, paddingHorizontal: 10, paddingVertical: 5 },
  holdingBadge: { backgroundColor: colors.accentSoft },
  watchBadge: { backgroundColor: colors.warningSoft },
  typeText: { fontSize: 12, fontWeight: '900' },
  holdingText: { color: colors.accent },
  watchText: { color: colors.warningText },
  ticker: { color: colors.accent, fontWeight: '900', fontSize: 14 },
  market: { color: colors.muted, fontSize: 13 },
  company: { color: colors.text, fontWeight: '800', fontSize: 18, marginTop: 8 },
  details: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 12 },
  detail: { color: colors.muted, backgroundColor: colors.accentSoft, borderRadius: 8, paddingHorizontal: 9, paddingVertical: 6, fontSize: 13 },
  editHint: { color: colors.muted, fontSize: 12, marginTop: 14, textAlign: 'right' },
  badge: { backgroundColor: colors.accentSoft, borderRadius: 99, paddingHorizontal: 12, paddingVertical: 8 },
  badgeText: { color: colors.accent, fontWeight: '800', fontSize: 12 },
  registeredBadge: { backgroundColor: colors.border },
  registeredText: { color: colors.muted },
});
