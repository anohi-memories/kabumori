import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { ActivityIndicator, Alert, Linking, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { DeleteCommonAccountView, WithdrawKabumoriView } from '@/components/account-lifecycle-views';
import { BackButton } from '@/components/back-button';
import { KABUMORI_COLORS } from '@/constants/kabumori-theme';
import { authErrorMessage, requestPasswordReset, signOut } from '@/lib/auth';
import { legalLinks } from '@/lib/legal-links';
import { settingsEntries, type SettingsEntry } from '@/lib/settings-menu';
import { TOPIC_LEVELS, TOPIC_LEVEL_HINT, TOPIC_LEVEL_LABEL, type TopicLevel } from '@/lib/home-topic';
import { readTopicLevel, writeTopicLevel } from '@/lib/topic-level-storage';
import { useAuth } from '@/providers/auth-provider';

const palette = KABUMORI_COLORS.light;

// Settings now lives as a top-level route/tab, per the approved v3 bottom
// navigation, instead of a Modal sheet. The previous Modal + SafeAreaView
// combination did not reliably respect the device's status-bar inset on a
// real iPhone (react-native-safe-area-context's inset measurement is
// unreliable inside RN's own Modal, which renders into a separate native
// window) -- a real screen inside the normal navigation tree does not have
// that problem, so no manual useSafeAreaInsets() patch is needed here.
type View_ = 'menu' | 'withdraw' | 'delete' | 'topic-level';

export default function SettingsScreen() {
  const { session } = useAuth();
  const email = session?.user.email ?? null;
  const [view, setView] = useState<View_>('menu');
  const [topicLevel, setTopicLevel] = useState<TopicLevel>('beginner');

  useEffect(() => {
    let active = true;
    readTopicLevel().then((level) => {
      if (active) setTopicLevel(level);
    });
    return () => {
      active = false;
    };
  }, []);

  // Reset to the menu whenever Settings regains focus (e.g. returning from
  // an account sub-flow via the tab bar rather than its own back button),
  // so the tab never reopens mid-flow unexpectedly.
  useFocusEffect(useCallback(() => {
    return () => setView('menu');
  }, []));

  async function handleTopicLevelChange(level: TopicLevel): Promise<boolean> {
    const ok = await writeTopicLevel(level);
    if (ok) setTopicLevel(level);
    return ok;
  }

  return (
    <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
      {view === 'menu' ? (
        <SettingsMenu
          email={email}
          topicLevel={topicLevel}
          onWithdrawKabumori={() => setView('withdraw')}
          onDeleteCommonAccount={() => setView('delete')}
          onOpenTopicLevel={() => setView('topic-level')}
        />
      ) : view === 'withdraw' ? (
        <WithdrawKabumoriView onBack={() => setView('menu')} />
      ) : view === 'delete' ? (
        <DeleteCommonAccountView onBack={() => setView('menu')} />
      ) : (
        <TopicLevelView current={topicLevel} onChange={handleTopicLevelChange} onBack={() => setView('menu')} />
      )}
    </SafeAreaView>
  );
}

function SettingsMenu({
  email,
  topicLevel,
  onWithdrawKabumori,
  onDeleteCommonAccount,
  onOpenTopicLevel,
}: {
  email: string | null;
  topicLevel: TopicLevel;
  onWithdrawKabumori: () => void;
  onDeleteCommonAccount: () => void;
  onOpenTopicLevel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const entries = settingsEntries(legalLinks(), { email }, TOPIC_LEVEL_LABEL[topicLevel]);

  async function sendPasswordReset() {
    if (!email) {
      Alert.alert('メールアドレスを確認できません', '一度ログインし直してからお試しください。');
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      await requestPasswordReset(email);
      // Deliberately the same message regardless of whether the address has an account.
      Alert.alert(
        '再設定メールを送信しました',
        'メール内のリンクを開くと、新しいパスワードを設定できます。届かない場合は迷惑メールもご確認ください。',
      );
    } catch (error) {
      Alert.alert('送信できませんでした', authErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function logOut() {
    if (busy) return;
    setBusy(true);
    try {
      await signOut();
    } catch (error) {
      Alert.alert('ログアウト失敗', authErrorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function openLink(entry: SettingsEntry) {
    if (!entry.url) {
      Alert.alert(entry.label, entry.unavailableMessage ?? '準備中です。');
      return;
    }
    const supported = await Linking.canOpenURL(entry.url);
    if (!supported) {
      Alert.alert(entry.label, 'この端末では開けませんでした。');
      return;
    }
    await Linking.openURL(entry.url);
  }

  function press(entry: SettingsEntry) {
    if (entry.kind === 'info') return;
    if (entry.kind === 'link') return void openLink(entry);
    if (entry.id === 'password') return void sendPasswordReset();
    if (entry.id === 'logout') return void logOut();
    if (entry.id === 'withdraw-kabumori') return onWithdrawKabumori();
    if (entry.id === 'delete-common-account') return onDeleteCommonAccount();
    if (entry.id === 'topic-level') return onOpenTopicLevel();
  }

  return (
    <>
      <View style={styles.headerRow}>
        <BackButton />
        <Text style={styles.eyebrow}>SETTINGS</Text>
        <Text style={styles.title}>設定</Text>
      </View>
      <ScrollView contentContainerStyle={styles.list}>
        {entries.map((entry) => {
          const interactive = entry.kind !== 'info';
          return (
            <Pressable
              key={entry.id}
              onPress={() => press(entry)}
              disabled={!interactive || busy}
              accessibilityRole={interactive ? 'button' : undefined}
              accessibilityLabel={entry.label}
              style={({ pressed }) => [styles.row, pressed && interactive && styles.pressed]}>
              <View style={styles.rowMain}>
                <Text
                  style={[
                    styles.rowLabel,
                    entry.kind === 'destructive' && styles.destructiveLabel,
                    entry.kind === 'info' && styles.infoLabel,
                  ]}>
                  {entry.label}
                </Text>
                {!!entry.description && <Text style={styles.rowDescription}>{entry.description}</Text>}
              </View>
              {interactive ? <Text style={styles.chevron}>›</Text> : null}
            </Pressable>
          );
        })}
        {busy ? <ActivityIndicator color={palette.accent} style={styles.busy} /> : null}
      </ScrollView>
    </>
  );
}

function TopicLevelView({
  current,
  onChange,
  onBack,
}: {
  current: TopicLevel;
  onChange: (level: TopicLevel) => Promise<boolean>;
  onBack: () => void;
}) {
  const [selected, setSelected] = useState<TopicLevel>(current);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function choose(level: TopicLevel) {
    if (saving || level === selected) return;
    const previous = selected;
    // Optimistic: the UI reflects the choice immediately, but is reverted
    // below if the write actually fails -- never left claiming a save that
    // didn't happen.
    setSelected(level);
    setSaving(true);
    setMessage(null);
    const ok = await onChange(level);
    setSaving(false);
    if (!ok) {
      setSelected(previous);
      setMessage('保存できませんでした。もう一度お試しください。');
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.topicContainer}>
      <Pressable onPress={onBack} disabled={saving} accessibilityRole="button" style={styles.backButton}>
        <Text style={styles.backText}>‹ 設定にもどる</Text>
      </Pressable>
      <Text style={styles.title}>投資知識レベル</Text>
      <Text style={styles.topicLead}>「今日のトピック」の説明の深さを選べます。</Text>
      <View style={styles.topicOptions}>
        {TOPIC_LEVELS.map((level) => {
          const isSelected = level === selected;
          return (
            <Pressable
              key={level}
              onPress={() => void choose(level)}
              disabled={saving}
              style={[styles.topicOption, isSelected && styles.topicOptionSelected]}
              accessibilityRole="button"
              accessibilityState={{ selected: isSelected, disabled: saving }}
              accessibilityLabel={`${TOPIC_LEVEL_LABEL[level]}${isSelected ? '、選択中' : ''}`}>
              <View style={styles.topicOptionMain}>
                <Text style={[styles.topicOptionLabel, isSelected && styles.topicOptionLabelSelected]}>
                  {TOPIC_LEVEL_LABEL[level]}
                </Text>
                <Text style={styles.topicOptionHint}>{TOPIC_LEVEL_HINT[level]}</Text>
              </View>
              {isSelected ? <Text style={styles.topicCheck}>✓</Text> : null}
            </Pressable>
          );
        })}
      </View>
      {saving ? <ActivityIndicator color={palette.accent} style={styles.busy} /> : null}
      {!!message && (
        <View style={styles.messageBox}>
          <Text style={styles.messageText}>{message}</Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: palette.background },
  headerRow: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 6 },
  eyebrow: { color: palette.accent, fontWeight: '900', letterSpacing: 2, fontSize: 11 },
  title: { color: palette.text, fontSize: 26, fontWeight: '900', marginTop: 4 },
  list: { padding: 20, gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: palette.card, borderColor: palette.border, borderWidth: 1, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 14, minHeight: 60 },
  rowMain: { flex: 1, gap: 3 },
  rowLabel: { color: palette.text, fontSize: 15, fontWeight: '800' },
  infoLabel: { color: palette.muted, fontSize: 13, fontWeight: '700' },
  destructiveLabel: { color: '#9a3631' },
  rowDescription: { color: palette.muted, fontSize: 13, lineHeight: 19 },
  chevron: { color: palette.muted, fontSize: 22, marginLeft: 10 },
  pressed: { opacity: 0.7 },
  busy: { marginTop: 14 },
  backButton: { minHeight: 44, justifyContent: 'center' },
  backText: { color: palette.accent, fontWeight: '800' },
  messageBox: { backgroundColor: '#fff2f1', borderRadius: 12, padding: 13 },
  messageText: { color: '#9a3631', lineHeight: 20 },
  topicContainer: { padding: 20, gap: 12 },
  topicLead: { color: palette.muted, fontSize: 14, lineHeight: 20, marginTop: 2, marginBottom: 4 },
  topicOptions: { gap: 10 },
  topicOption: { flexDirection: 'row', alignItems: 'center', backgroundColor: palette.card, borderColor: palette.border, borderWidth: 1, borderRadius: 14, paddingHorizontal: 16, paddingVertical: 14 },
  topicOptionSelected: { borderColor: palette.accent, backgroundColor: palette.accentSoft },
  topicOptionMain: { flex: 1, gap: 3 },
  topicOptionLabel: { color: palette.text, fontSize: 15, fontWeight: '800' },
  topicOptionLabelSelected: { color: palette.accent },
  topicOptionHint: { color: palette.muted, fontSize: 13, lineHeight: 19 },
  topicCheck: { color: palette.accent, fontSize: 18, fontWeight: '900', marginLeft: 10 },
});
