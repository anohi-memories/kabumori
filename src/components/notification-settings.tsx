import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Modal, Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { fetchMyAlertSettings, MyAlertSettings, upsertMyAlertSettings } from '@/lib/alert-settings';

type Props = {
  visible: boolean;
  onClose: () => void;
};

export function NotificationSettings({ visible, onClose }: Props) {
  const [settings, setSettings] = useState<MyAlertSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    setError('');
    fetchMyAlertSettings()
      .then(setSettings)
      .catch((fetchError) => {
        setError(fetchError instanceof Error ? fetchError.message : '通知設定を取得できませんでした。');
      })
      .finally(() => setLoading(false));
  }, [visible]);

  async function save(next: MyAlertSettings) {
    setSettings(next);
    setSaving(true);
    try {
      await upsertMyAlertSettings(next);
    } catch (saveError) {
      Alert.alert('保存失敗', saveError instanceof Error ? saveError.message : '時間をおいて再度お試しください。');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={styles.screen}>
        <View style={styles.header}>
          <Text style={styles.title}>通知設定</Text>
          <Pressable onPress={onClose} accessibilityRole="button">
            <Text style={styles.close}>閉じる</Text>
          </Pressable>
        </View>

        {loading && <ActivityIndicator color="#397449" style={styles.status} />}
        {!!error && <Text style={styles.error}>{error}</Text>}

        {settings && (
          <View style={styles.list}>
            <View style={styles.row}>
              <View style={styles.rowText}>
                <Text style={styles.rowLabel}>重要ニュースの通知</Text>
                <Text style={styles.rowDescription}>保有・監視銘柄の重要ニュースをお知らせします。</Text>
              </View>
              <Switch
                value={settings.important_news}
                onValueChange={(value) => void save({ ...settings, important_news: value })}
                disabled={saving}
              />
            </View>
            <View style={styles.row}>
              <View style={styles.rowText}>
                <Text style={styles.rowLabel}>プッシュ通知</Text>
                <Text style={styles.rowDescription}>この端末にプッシュ通知を送ります。</Text>
              </View>
              <Switch
                value={settings.push_enabled}
                onValueChange={(value) => void save({ ...settings, push_enabled: value })}
                disabled={saving}
              />
            </View>
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f7f8f5', padding: 24 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 22 },
  title: { color: '#17211a', fontWeight: '800', fontSize: 22 },
  close: { color: '#54745d', fontWeight: '700', padding: 8 },
  status: { marginTop: 24 },
  error: { color: '#9a3631', marginTop: 8 },
  list: { gap: 14 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#fff',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: '#e1e5e2',
    padding: 16,
    gap: 12,
  },
  rowText: { flex: 1 },
  rowLabel: { color: '#17211a', fontWeight: '800', fontSize: 16 },
  rowDescription: { color: '#667169', fontSize: 13, marginTop: 4, lineHeight: 18 },
});
