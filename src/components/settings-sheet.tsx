import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { KABUMORI_COLORS } from '@/constants/kabumori-theme';
import { deleteSignedInAccount } from '@/lib/account-deletion-client';
import { deleteConfirmationIssue } from '@/lib/account-deletion';
import { authErrorMessage, requestPasswordReset, signOut } from '@/lib/auth';
import { legalLinks } from '@/lib/legal-links';
import { settingsEntries, type SettingsEntry } from '@/lib/settings-menu';

const palette = KABUMORI_COLORS.light;

// Settings is presented over the current tab rather than as its own route: the app's navigator is
// expo-router's NativeTabs, where every top-level route becomes a visible tab, so adding
// `app/settings` would add a sixth tab to the bar. The screens below are self-contained, so they
// can move to real routes unchanged once the navigator gains a stack above the tabs.
type SheetView = 'menu' | 'delete';

export function SettingsSheet({
  visible,
  email,
  onClose,
}: {
  visible: boolean;
  email: string | null;
  onClose: () => void;
}) {
  const [view, setView] = useState<SheetView>('menu');

  function close() {
    setView('menu');
    onClose();
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={close} transparent={false}>
      <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
        {view === 'menu' ? (
          <SettingsMenu email={email} onClose={close} onDeleteAccount={() => setView('delete')} />
        ) : (
          <DeleteAccountView email={email} onBack={() => setView('menu')} />
        )}
      </SafeAreaView>
    </Modal>
  );
}

function SettingsMenu({
  email,
  onClose,
  onDeleteAccount,
}: {
  email: string | null;
  onClose: () => void;
  onDeleteAccount: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const entries = settingsEntries(legalLinks(), { email });

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
      onClose();
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
    if (entry.id === 'delete-account') return onDeleteAccount();
  }

  return (
    <>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.eyebrow}>SETTINGS</Text>
          <Text style={styles.title}>設定</Text>
        </View>
        <Pressable onPress={onClose} style={styles.closeButton} accessibilityRole="button" accessibilityLabel="設定を閉じる">
          <Text style={styles.closeText}>閉じる</Text>
        </Pressable>
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

function DeleteAccountView({ email, onBack }: { email: string | null; onBack: () => void }) {
  const [typed, setTyped] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function confirmAndDelete() {
    if (deleting) return;
    const issue = deleteConfirmationIssue(typed, email ?? '');
    if (issue) {
      setMessage(issue);
      return;
    }
    setMessage(null);
    setDeleting(true);
    const outcome = await deleteSignedInAccount();
    if (!outcome.ok) {
      // The server did not confirm the deletion, so nothing here claims it happened.
      setMessage(outcome.message);
      setDeleting(false);
      return;
    }
    // The account is gone; the local session is now meaningless, so it is cleared before the UI
    // returns. signOut() is best-effort: its server call can fail precisely because the user no
    // longer exists, and that must not turn a completed deletion into an error.
    await signOut().catch(() => undefined);
  }

  return (
    <ScrollView contentContainerStyle={styles.deleteContainer}>
      <Pressable onPress={onBack} disabled={deleting} accessibilityRole="button" style={styles.backButton}>
        <Text style={styles.backText}>‹ 設定にもどる</Text>
      </Pressable>
      <Text style={styles.title}>アカウントを削除</Text>
      <Text style={styles.deleteLead}>
        削除すると、登録した銘柄、通知、レポート、プッシュ通知の設定がすべて消えます。元に戻すことはできません。
      </Text>
      <View style={styles.noticeBox}>
        <Text style={styles.noticeText}>削除されるもの</Text>
        <Text style={styles.noticeItem}>・保有／監視している銘柄</Text>
        <Text style={styles.noticeItem}>・通知と通知の設定</Text>
        <Text style={styles.noticeItem}>・あなた向けのレポート</Text>
        <Text style={styles.noticeItem}>・ログイン用のアカウント</Text>
      </View>
      <Text style={styles.label}>確認のため、登録しているメールアドレスを入力してください</Text>
      <TextInput
        value={typed}
        onChangeText={setTyped}
        placeholder={email ?? 'mail@example.com'}
        placeholderTextColor={palette.muted}
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        editable={!deleting}
        style={styles.input}
        accessibilityLabel="確認用のメールアドレス"
      />
      {!!message && (
        <View style={styles.messageBox}>
          <Text style={styles.messageText}>{message}</Text>
        </View>
      )}
      <Pressable
        onPress={() => void confirmAndDelete()}
        disabled={deleting}
        style={[styles.deleteButton, deleting && styles.disabled]}
        accessibilityRole="button"
        accessibilityLabel="アカウントを完全に削除する">
        {deleting ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.deleteButtonText}>アカウントを完全に削除する</Text>
        )}
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: palette.background },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 12, paddingBottom: 6 },
  eyebrow: { color: palette.accent, fontWeight: '900', letterSpacing: 2, fontSize: 11 },
  title: { color: palette.text, fontSize: 26, fontWeight: '900', marginTop: 4 },
  closeButton: { paddingHorizontal: 14, paddingVertical: 9, borderRadius: 10, backgroundColor: palette.accentSoft },
  closeText: { color: palette.muted, fontSize: 12, fontWeight: '800' },
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
  deleteContainer: { padding: 20, gap: 12 },
  backButton: { minHeight: 44, justifyContent: 'center' },
  backText: { color: palette.accent, fontWeight: '800' },
  deleteLead: { color: palette.text, fontSize: 15, lineHeight: 23 },
  noticeBox: { backgroundColor: palette.soft, borderRadius: 14, padding: 16, gap: 4 },
  noticeText: { color: palette.text, fontWeight: '800', marginBottom: 4 },
  noticeItem: { color: palette.muted, fontSize: 14, lineHeight: 21 },
  label: { color: palette.text, fontWeight: '700', marginTop: 8 },
  input: { minHeight: 52, borderWidth: 1, borderColor: palette.border, borderRadius: 13, backgroundColor: palette.card, paddingHorizontal: 15, color: palette.text, fontSize: 16 },
  messageBox: { backgroundColor: '#fff2f1', borderRadius: 12, padding: 13 },
  messageText: { color: '#9a3631', lineHeight: 20 },
  deleteButton: { minHeight: 52, marginTop: 8, borderRadius: 14, backgroundColor: '#9a3631', alignItems: 'center', justifyContent: 'center' },
  deleteButtonText: { color: '#fff', fontSize: 16, fontWeight: '900' },
  disabled: { opacity: 0.55 },
});
