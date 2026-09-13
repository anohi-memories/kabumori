import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import {
  alertCategories,
  AlertCategory,
  fetchImportantNewsAlertPreferences,
  ImportantNewsAlertPreferences,
  presetOptions,
  saveImportantNewsAlertPreferences,
} from '@/lib/alert-settings';
import { coverageCategoryLabels } from '@/lib/news-labels';

export function ImportantNewsAlertSettings() {
  const [preferences, setPreferences] = useState<ImportantNewsAlertPreferences | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      setPreferences(await fetchImportantNewsAlertPreferences());
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '通知設定を取得できませんでした。');
    }
  }, []);

  useFocusEffect(useCallback(() => {
    void load();
  }, [load]));

  const updateCategory = (category: AlertCategory, enabled: boolean) => {
    setPreferences((current) => current ? {
      ...current,
      enabledCategories: { ...current.enabledCategories, [category]: enabled },
    } : current);
  };

  const save = async () => {
    if (!preferences) return;
    setSaving(true);
    setError('');
    setMessage('');
    try {
      await saveImportantNewsAlertPreferences(preferences);
      setMessage('通知設定を保存しました。');
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '通知設定を保存できませんでした。');
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.card}>
      <Pressable
        onPress={() => setExpanded((value) => !value)}
        style={styles.headingRow}
        accessibilityRole="button"
        accessibilityState={{ expanded }}>
        <View style={styles.headingText}>
          <Text style={styles.title}>重要ニュースの通知</Text>
          <Text style={styles.description}>届くニュースの量や分野を選べます。</Text>
        </View>
        <Text style={styles.expand}>{expanded ? '閉じる' : '設定する'}</Text>
      </Pressable>

      {expanded && !preferences && !error ? <ActivityIndicator color="#397449" style={styles.loader} /> : null}
      {expanded && preferences ? (
        <View style={styles.body}>
          <View style={styles.switchRow}>
            <View style={styles.switchText}>
              <Text style={styles.rowTitle}>重要ニュース通知</Text>
              <Text style={styles.rowDescription}>オフにすると、下の設定に関係なく通知されません。</Text>
            </View>
            <Switch
              value={preferences.importantNews}
              onValueChange={(importantNews) => setPreferences({ ...preferences, importantNews })}
              trackColor={{ true: '#397449', false: '#d7dcd8' }}
            />
          </View>

          <Text style={styles.sectionTitle}>通知の量</Text>
          {presetOptions.map((option) => {
            const selected = preferences.preset === option.value;
            return (
              <Pressable
                key={option.value}
                onPress={() => setPreferences({ ...preferences, preset: option.value })}
                style={[styles.option, selected && styles.selectedOption]}
                accessibilityRole="radio"
                accessibilityState={{ selected }}>
                <View style={[styles.radio, selected && styles.selectedRadio]} />
                <View style={styles.optionText}>
                  <Text style={styles.optionLabel}>{option.label}</Text>
                  <Text style={styles.optionDescription}>{option.description}</Text>
                </View>
              </Pressable>
            );
          })}

          <View style={[styles.switchRow, styles.emergencyRow]}>
            <View style={styles.switchText}>
              <Text style={styles.rowTitle}>緊急ニュース</Text>
              <Text style={styles.rowDescription}>災害や市場停止など。登録銘柄との一致なしでも届きます。</Text>
            </View>
            <Switch
              value={preferences.emergencyAlerts}
              onValueChange={(emergencyAlerts) => setPreferences({ ...preferences, emergencyAlerts })}
              trackColor={{ true: '#a3473e', false: '#d7dcd8' }}
            />
          </View>

          <Text style={styles.sectionTitle}>通知する分野</Text>
          <Text style={styles.categoryHelp}>複数分野のニュースは、どれか1つがオンなら通知対象です。</Text>
          <View style={styles.categories}>
            {alertCategories.map((category) => (
              <View key={category} style={styles.categoryRow}>
                <Text style={styles.categoryLabel}>{coverageCategoryLabels[category]}</Text>
                <Switch
                  value={preferences.enabledCategories[category]}
                  onValueChange={(enabled) => updateCategory(category, enabled)}
                  trackColor={{ true: '#397449', false: '#d7dcd8' }}
                />
              </View>
            ))}
          </View>

          {!!error && <Text style={styles.error}>{error}</Text>}
          {!!message && <Text style={styles.success}>{message}</Text>}
          <Pressable onPress={() => void save()} disabled={saving} style={styles.saveButton}>
            {saving ? <ActivityIndicator color="#fff" /> : <Text style={styles.saveText}>設定を保存</Text>}
          </Pressable>
        </View>
      ) : null}
      {expanded && !!error && !preferences ? (
        <View>
          <Text style={styles.error}>{error}</Text>
          <Pressable onPress={() => void load()} style={styles.retryButton}>
            <Text style={styles.retryText}>もう一度試す</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: '#eef3ed', borderRadius: 18, padding: 15, marginBottom: 12 },
  headingRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  headingText: { flex: 1 },
  title: { color: '#17211a', fontWeight: '900', fontSize: 15 },
  description: { color: '#5e6d63', fontSize: 12, lineHeight: 18, marginTop: 3 },
  expand: { color: '#397449', fontSize: 13, fontWeight: '900' },
  loader: { marginVertical: 18 },
  body: { borderTopWidth: 1, borderTopColor: '#d7dfd6', marginTop: 14, paddingTop: 14 },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  switchText: { flex: 1 },
  rowTitle: { color: '#17211a', fontSize: 14, fontWeight: '800' },
  rowDescription: { color: '#677269', fontSize: 12, lineHeight: 18, marginTop: 2 },
  sectionTitle: { color: '#548161', fontWeight: '900', fontSize: 12, letterSpacing: 1, marginTop: 18, marginBottom: 8 },
  option: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#fff', borderWidth: 1, borderColor: '#dce2dd', borderRadius: 13, padding: 11, marginBottom: 7 },
  selectedOption: { borderColor: '#397449', backgroundColor: '#f8fbf8' },
  radio: { width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: '#aab3ad' },
  selectedRadio: { borderWidth: 5, borderColor: '#397449' },
  optionText: { flex: 1 },
  optionLabel: { color: '#17211a', fontWeight: '900', fontSize: 14 },
  optionDescription: { color: '#667169', fontSize: 12, lineHeight: 17, marginTop: 2 },
  emergencyRow: { marginTop: 13, backgroundColor: '#fff8f6', borderRadius: 13, padding: 11 },
  categoryHelp: { color: '#677269', fontSize: 12, lineHeight: 18, marginBottom: 6 },
  categories: { backgroundColor: '#fff', borderRadius: 13, paddingHorizontal: 12 },
  categoryRow: { minHeight: 47, flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#e2e6e3' },
  categoryLabel: { flex: 1, color: '#27342c', fontSize: 14, fontWeight: '700' },
  error: { color: '#9a403b', fontSize: 12, lineHeight: 18, marginTop: 10 },
  success: { color: '#397449', fontSize: 12, fontWeight: '700', marginTop: 10 },
  saveButton: { minHeight: 46, alignItems: 'center', justifyContent: 'center', backgroundColor: '#397449', borderRadius: 12, marginTop: 14 },
  saveText: { color: '#fff', fontWeight: '900' },
  retryButton: { alignSelf: 'flex-start', marginTop: 10, borderRadius: 10, backgroundColor: '#397449', paddingHorizontal: 13, paddingVertical: 8 },
  retryText: { color: '#fff', fontWeight: '800', fontSize: 12 },
});
