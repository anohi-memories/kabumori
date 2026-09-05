import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { TrackedStockEditor } from '@/components/tracked-stock-editor';
import { authErrorMessage, signOut } from '@/lib/auth';
import { TrackedStock } from '@/lib/stocks';
import { supabase } from '@/lib/supabase';

const positionLabels = { cash: '現物', margin: '信用', long: '買い', short: '売り' } as const;

export default function TrackedStocksScreen() {
  const [items, setItems] = useState<TrackedStock[]>([]);
  const [selected, setSelected] = useState<TrackedStock | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');

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
      setMessage(`一覧を取得できませんでした。${error.message}`);
    } else {
      setItems((data ?? []) as unknown as TrackedStock[]);
      setMessage(data?.length ? '' : 'まだ登録銘柄がありません。検索から追加してみましょう。');
    }
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  async function logOut() {
    try {
      await signOut();
    } catch (error) {
      Alert.alert('ログアウト失敗', authErrorMessage(error));
    }
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <View style={styles.container}>
        <View style={styles.headingRow}>
          <Text style={styles.eyebrow}>MY STOCKS</Text>
          <Pressable onPress={() => void logOut()} style={styles.logoutButton}>
            <Text style={styles.logoutText}>ログアウト</Text>
          </Pressable>
        </View>
        <Text style={styles.title}>登録銘柄</Text>
        <Text style={styles.description}>保有株と、気になる監視銘柄をまとめて確認できます。</Text>
        {loading && !items.length ? <ActivityIndicator color="#397449" style={styles.status} /> : null}
        {!loading && !!message ? <Text style={styles.message}>{message}</Text> : null}
        <FlatList
          data={items}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl refreshing={loading && !!items.length} onRefresh={load} tintColor="#397449" />
          }
          renderItem={({ item }) => {
            const holding = item.tracking_type === 'holding';
            return (
              <Pressable
                onPress={() => setSelected(item)}
                style={({ pressed }) => [styles.card, pressed && styles.pressed]}>
                <View style={styles.topRow}>
                  <View style={[styles.typeBadge, holding ? styles.holdingBadge : styles.watchBadge]}>
                    <Text style={[styles.typeText, holding ? styles.holdingText : styles.watchText]}>
                      {holding ? '保有' : '監視'}
                    </Text>
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
      <TrackedStockEditor
        stock={selected?.stocks_master ?? null}
        existing={selected}
        visible={!!selected}
        onClose={() => setSelected(null)}
        onSaved={() => { setSelected(null); void load(); }}
        onDeleted={() => { setSelected(null); void load(); }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#f7f8f5' },
  container: { flex: 1, width: '100%', maxWidth: 720, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 20 },
  eyebrow: { color: '#548161', fontWeight: '900', letterSpacing: 2, fontSize: 12 },
  headingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  logoutButton: { paddingHorizontal: 12, paddingVertical: 8, borderRadius: 10, backgroundColor: '#e9ede9' },
  logoutText: { color: '#526058', fontSize: 12, fontWeight: '800' },
  title: { color: '#17211a', fontSize: 32, fontWeight: '900', marginTop: 6 },
  description: { color: '#667169', fontSize: 15, lineHeight: 22, marginTop: 8, marginBottom: 12 },
  status: { marginTop: 28 },
  message: { color: '#6f7972', textAlign: 'center', marginTop: 28, lineHeight: 22 },
  list: { paddingTop: 8, paddingBottom: 100, gap: 12 },
  card: { backgroundColor: '#fff', borderRadius: 18, borderWidth: 1, borderColor: '#e1e5e2', padding: 17 },
  pressed: { opacity: 0.65 },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  typeBadge: { borderRadius: 99, paddingHorizontal: 10, paddingVertical: 5 },
  holdingBadge: { backgroundColor: '#e4f1e7' },
  watchBadge: { backgroundColor: '#fff0d7' },
  typeText: { fontSize: 12, fontWeight: '900' },
  holdingText: { color: '#2c6940' },
  watchText: { color: '#946222' },
  ticker: { color: '#4b5b51', fontWeight: '900' },
  market: { color: '#89918c', fontSize: 12 },
  company: { color: '#17211a', fontWeight: '800', fontSize: 19, marginTop: 10 },
  details: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 12 },
  detail: { color: '#536058', backgroundColor: '#f2f4f2', borderRadius: 8, paddingHorizontal: 9, paddingVertical: 6, fontSize: 13 },
  editHint: { color: '#728078', fontSize: 12, marginTop: 14, textAlign: 'right' },
});
