import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { StockMaster, TrackedStock, TrackedStockInput, TrackingType } from '@/lib/stocks';
import { supabase } from '@/lib/supabase';

type Props = {
  stock: StockMaster | null;
  existing?: TrackedStock | null;
  visible: boolean;
  onClose: () => void;
  onSaved: () => void;
  onDeleted?: () => void;
};

const emptyInput: TrackedStockInput = {
  tracking_type: 'watch',
  quantity: null,
  average_price: null,
  position_type: null,
  side: null,
  target_buy_price: null,
  target_sell_price: null,
  memo: null,
};

function numberValue(value: string, label: string, positive = false) {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed.replace(/,/g, ''));
  if (!Number.isFinite(parsed) || parsed < 0 || (positive && parsed <= 0)) {
    throw new Error(`${label}は${positive ? '0より大きい' : '0以上の'}数値で入力してください。`);
  }
  return parsed;
}

function Choice<T extends string>({ value, options, onChange }: {
  value: T | null;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <View style={styles.choiceRow}>
      {options.map((option) => (
        <Pressable
          key={option.value}
          onPress={() => onChange(option.value)}
          style={[styles.choice, value === option.value && styles.choiceSelected]}>
          <Text style={[styles.choiceText, value === option.value && styles.choiceTextSelected]}>
            {option.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

export function TrackedStockEditor({ stock, existing, visible, onClose, onSaved, onDeleted }: Props) {
  const [trackingType, setTrackingType] = useState<TrackingType>('watch');
  const [quantity, setQuantity] = useState('');
  const [averagePrice, setAveragePrice] = useState('');
  const [positionType, setPositionType] = useState<'cash' | 'margin' | null>(null);
  const [side, setSide] = useState<'long' | 'short' | null>(null);
  const [targetBuyPrice, setTargetBuyPrice] = useState('');
  const [targetSellPrice, setTargetSellPrice] = useState('');
  const [memo, setMemo] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  useEffect(() => {
    const input = existing ?? emptyInput;
    setTrackingType(input.tracking_type);
    setQuantity(input.quantity?.toString() ?? '');
    setAveragePrice(input.average_price?.toString() ?? '');
    setPositionType(input.position_type);
    setSide(input.side);
    setTargetBuyPrice(input.target_buy_price?.toString() ?? '');
    setTargetSellPrice(input.target_sell_price?.toString() ?? '');
    setMemo(input.memo ?? '');
    setConfirmingDelete(false);
  }, [existing, stock, visible]);

  async function requireUser() {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw new Error('ログインが必要です。ログイン後にもう一度お試しください。');
    return data.user;
  }

  async function save() {
    if (!stock || saving) return;
    setSaving(true);
    try {
      const user = await requireUser();
      const holding = trackingType === 'holding';
      const input: TrackedStockInput = {
        tracking_type: trackingType,
        quantity: holding ? numberValue(quantity, '保有株数', true) : null,
        average_price: holding ? numberValue(averagePrice, '平均取得価格') : null,
        position_type: holding ? positionType : null,
        side: holding ? side : null,
        target_buy_price: numberValue(targetBuyPrice, '買いたい価格'),
        target_sell_price: numberValue(targetSellPrice, '売りたい価格'),
        memo: memo.trim() || null,
      };

      if (existing) {
        const { error } = await supabase
          .from('tracked_stocks')
          .update(input)
          .eq('id', existing.id)
          .eq('user_id', user.id);
        if (error) throw new Error(`更新できませんでした。${error.message}`);
      } else {
        const { data: duplicate, error: duplicateError } = await supabase
          .from('tracked_stocks')
          .select('id')
          .eq('user_id', user.id)
          .eq('stock_id', stock.id)
          .maybeSingle();
        if (duplicateError) throw new Error(`登録状況を確認できませんでした。${duplicateError.message}`);
        if (duplicate) throw new Error('この銘柄はすでに登録済みです。一覧から編集できます。');

        const { error } = await supabase.from('tracked_stocks').insert({
          ...input,
          user_id: user.id,
          stock_id: stock.id,
        });
        if (error?.code === '23505') {
          throw new Error('この銘柄はすでに登録済みです。一覧から編集できます。');
        }
        if (error) throw new Error(`登録できませんでした。${error.message}`);
      }
      onSaved();
    } catch (error) {
      Alert.alert(
        existing ? '更新失敗' : '登録失敗',
        error instanceof Error ? error.message : '時間をおいて再度お試しください。',
      );
    } finally {
      setSaving(false);
    }
  }

  async function deleteItem() {
    if (!existing) return;
    setSaving(true);
    try {
      const user = await requireUser();
      const { error } = await supabase
        .from('tracked_stocks')
        .delete()
        .eq('id', existing.id)
        .eq('user_id', user.id);
      if (error) throw new Error(`登録を解除できませんでした。${error.message}`);
      onDeleted?.();
    } catch (error) {
      Alert.alert(
        '削除失敗',
        error instanceof Error ? error.message : '時間をおいて再度お試しください。',
      );
    } finally {
      setSaving(false);
    }
  }

  if (!stock) return null;

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          style={styles.screen}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled">
          <View style={styles.header}>
            <View style={styles.headerText}>
              <Text style={styles.ticker}>{stock.ticker_code}</Text>
              <Text style={styles.company}>{stock.company_name}</Text>
              <Text style={styles.market}>{stock.market}</Text>
            </View>
            <Pressable onPress={onClose} accessibilityRole="button">
              <Text style={styles.close}>閉じる</Text>
            </Pressable>
          </View>

          <Text style={styles.label}>登録方法</Text>
          <Choice
            value={trackingType}
            options={[{ value: 'holding', label: '保有' }, { value: 'watch', label: '監視' }]}
            onChange={setTrackingType}
          />

          {trackingType === 'holding' && (
            <>
              <Text style={styles.sectionTitle}>保有情報（すべて任意）</Text>
              <Text style={styles.label}>保有株数</Text>
              <TextInput value={quantity} onChangeText={setQuantity} keyboardType="decimal-pad" placeholder="例：100" style={styles.input} />
              <Text style={styles.label}>平均取得価格</Text>
              <TextInput value={averagePrice} onChangeText={setAveragePrice} keyboardType="decimal-pad" placeholder="例：5200" style={styles.input} />
              <Text style={styles.label}>現物 / 信用</Text>
              <Choice value={positionType} options={[{ value: 'cash', label: '現物' }, { value: 'margin', label: '信用' }]} onChange={setPositionType} />
              <Text style={styles.label}>買い / 売り</Text>
              <Choice value={side} options={[{ value: 'long', label: '買い' }, { value: 'short', label: '売り' }]} onChange={setSide} />
            </>
          )}

          <Text style={styles.sectionTitle}>目標価格・メモ（任意）</Text>
          <Text style={styles.label}>買いたい価格</Text>
          <TextInput value={targetBuyPrice} onChangeText={setTargetBuyPrice} keyboardType="decimal-pad" placeholder="未入力でも登録できます" style={styles.input} />
          <Text style={styles.label}>売りたい価格</Text>
          <TextInput value={targetSellPrice} onChangeText={setTargetSellPrice} keyboardType="decimal-pad" placeholder="未入力でも登録できます" style={styles.input} />
          <Text style={styles.label}>メモ</Text>
          <TextInput value={memo} onChangeText={setMemo} placeholder="気になった理由など" multiline style={[styles.input, styles.memo]} />

          <Pressable onPress={save} disabled={saving} style={[styles.primaryButton, saving && styles.disabled]}>
            {saving ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.primaryButtonText}>
                {existing ? '変更を保存' : `${trackingType === 'holding' ? '保有' : '監視'}に登録`}
              </Text>
            )}
          </Pressable>
          {existing && (
            confirmingDelete ? (
              <View style={styles.deleteConfirmation}>
                <Text style={styles.deleteQuestion}>本当に登録を解除しますか？</Text>
                <Text style={styles.deleteDescription}>この操作は取り消せません。</Text>
                <View style={styles.choiceRow}>
                  <Pressable onPress={() => setConfirmingDelete(false)} disabled={saving} style={styles.choice}>
                    <Text style={styles.choiceText}>キャンセル</Text>
                  </Pressable>
                  <Pressable onPress={() => void deleteItem()} disabled={saving} style={styles.deleteConfirmButton}>
                    <Text style={styles.deleteConfirmText}>解除する</Text>
                  </Pressable>
                </View>
              </View>
            ) : (
              <Pressable onPress={() => setConfirmingDelete(true)} disabled={saving} style={styles.deleteButton}>
                <Text style={styles.deleteText}>登録を解除</Text>
              </Pressable>
            )
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: '#f7f8f5' },
  content: { padding: 24, paddingBottom: 48, gap: 10, maxWidth: 640, width: '100%', alignSelf: 'center' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18 },
  headerText: { flex: 1 },
  ticker: { color: '#54745d', fontWeight: '800', fontSize: 16 },
  company: { color: '#17211a', fontWeight: '800', fontSize: 25, marginTop: 2 },
  market: { color: '#738078', marginTop: 4 },
  close: { color: '#54745d', fontWeight: '700', padding: 8 },
  sectionTitle: { color: '#17211a', fontWeight: '800', fontSize: 18, marginTop: 18 },
  label: { color: '#38453d', fontWeight: '700', marginTop: 6 },
  input: { minHeight: 48, borderWidth: 1, borderColor: '#d7ddd8', borderRadius: 12, backgroundColor: '#fff', paddingHorizontal: 14, fontSize: 16, color: '#17211a' },
  memo: { minHeight: 96, paddingTop: 14, textAlignVertical: 'top' },
  choiceRow: { flexDirection: 'row', gap: 10 },
  choice: { flex: 1, alignItems: 'center', paddingVertical: 13, borderRadius: 12, borderWidth: 1, borderColor: '#d7ddd8', backgroundColor: '#fff' },
  choiceSelected: { borderColor: '#477554', backgroundColor: '#e7f2e9' },
  choiceText: { color: '#5e6862', fontWeight: '700' },
  choiceTextSelected: { color: '#285c37' },
  primaryButton: { minHeight: 52, marginTop: 22, borderRadius: 14, backgroundColor: '#397449', alignItems: 'center', justifyContent: 'center' },
  primaryButtonText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  disabled: { opacity: 0.55 },
  deleteButton: { minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  deleteText: { color: '#b33c38', fontWeight: '700' },
  deleteConfirmation: { marginTop: 8, padding: 16, borderRadius: 14, borderWidth: 1, borderColor: '#e7b9b6', backgroundColor: '#fff7f6', gap: 8 },
  deleteQuestion: { color: '#792d2a', fontWeight: '800', fontSize: 16 },
  deleteDescription: { color: '#8b625f', marginBottom: 4 },
  deleteConfirmButton: { flex: 1, alignItems: 'center', paddingVertical: 13, borderRadius: 12, backgroundColor: '#b33c38' },
  deleteConfirmText: { color: '#fff', fontWeight: '800' },
});
