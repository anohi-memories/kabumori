import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { KABUMORI_COLORS } from '@/constants/kabumori-theme';
import {
  deletionAvailability,
  DELETE_TYPED_PHRASE,
  SERVICE_LABEL,
  type DeletionPreview,
} from '@/lib/account-deletion';
import {
  deleteSignedInCommonAccount,
  previewSignedInDeletion,
  withdrawSignedInKabumori,
} from '@/lib/account-deletion-client';
import { signOutThisDevice } from '@/lib/auth';

const palette = KABUMORI_COLORS.light;

// The two account choices of the common-account model, kept apart on purpose:
//   かぶモリの利用を終了 -- ends Kabumori only; the login (共通ID) and every other service stay.
//   共通アカウントを削除 -- the whole person: every service, then the login itself.
// Both ask for the password again (the server requires a recent sign-in) and only ever report what the
// server confirmed. After either one this device is signed out, so nothing of Kabumori stays open.

function confirm(title: string, message: string, action: string): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(title, message, [
      { text: 'キャンセル', style: 'cancel', onPress: () => resolve(false) },
      { text: action, style: 'destructive', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
}

function notifyThenSignOut(title: string, message: string) {
  Alert.alert(title, message);
  void signOutThisDevice();
}

function PasswordField({ value, onChange, editable }: { value: string; onChange: (value: string) => void; editable: boolean }) {
  return (
    <>
      <Text style={styles.label}>本人確認のため、ログイン中のアカウントのパスワードを入力してください</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        secureTextEntry
        textContentType="password"
        autoComplete="current-password"
        autoCapitalize="none"
        autoCorrect={false}
        editable={editable}
        style={styles.input}
        accessibilityLabel="パスワード"
      />
    </>
  );
}

function Message({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <View style={styles.messageBox}>
      <Text style={styles.messageText}>{text}</Text>
    </View>
  );
}

export function WithdrawKabumoriView({ onBack }: { onBack: () => void }) {
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    if (busy) return;
    if (!password) {
      setMessage('パスワードを入力してください。');
      return;
    }
    const ok = await confirm(
      'かぶモリの利用を終了しますか？',
      'かぶモリのデータはすべて削除され、元に戻せません。共通IDとほかのサービスはそのまま残ります。',
      '終了する',
    );
    if (!ok) return;
    setMessage(null);
    setBusy(true);
    const outcome = await withdrawSignedInKabumori(password);
    setPassword('');
    if (!outcome.ok) {
      setMessage(outcome.message);
      setBusy(false);
      return;
    }
    notifyThenSignOut(
      'かぶモリの利用を終了しました',
      '共通ID（ログイン）とX自動投稿などほかのサービスは、そのまま使えます。もう一度かぶモリを使うときは、ログインして利用登録をやり直してください。',
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <Pressable onPress={onBack} disabled={busy} accessibilityRole="button" style={styles.backButton}>
        <Text style={styles.backText}>‹ 設定にもどる</Text>
      </Pressable>
      <Text style={styles.title}>かぶモリの利用を終了</Text>
      <Text style={styles.lead}>かぶモリで登録したデータを削除し、かぶモリの利用を終了します。元に戻すことはできません。</Text>
      <View style={styles.noticeBox}>
        <Text style={styles.noticeTitle}>削除されるもの</Text>
        <Text style={styles.noticeItem}>・保有／監視している銘柄</Text>
        <Text style={styles.noticeItem}>・通知と通知の設定</Text>
        <Text style={styles.noticeItem}>・あなた向けのレポート</Text>
        <Text style={styles.noticeItem}>・すべての端末のかぶモリのプッシュ通知の登録</Text>
      </View>
      <View style={styles.keepBox}>
        <Text style={styles.noticeTitle}>残るもの</Text>
        <Text style={styles.noticeItem}>・共通ID（ログイン用のメールアドレスとパスワード）</Text>
        <Text style={styles.noticeItem}>・X自動投稿など、ほかのサービスの利用とデータ</Text>
      </View>
      <Text style={styles.note}>ログインそのものも削除したい場合は、設定の「共通アカウントを削除」を選んでください。</Text>
      <PasswordField value={password} onChange={setPassword} editable={!busy} />
      <Message text={message} />
      <Pressable
        onPress={() => void run()}
        disabled={busy}
        style={[styles.destructiveButton, busy && styles.disabled]}
        accessibilityRole="button"
        accessibilityLabel="かぶモリの利用を終了する">
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.destructiveText}>かぶモリの利用を終了する</Text>}
      </Pressable>
    </ScrollView>
  );
}

export function DeleteCommonAccountView({ onBack, backLabel = '‹ 設定にもどる' }: { onBack: () => void; backLabel?: string }) {
  const [preview, setPreview] = useState<DeletionPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [password, setPassword] = useState('');
  const [typed, setTyped] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setPreviewError(null);
    const result = await previewSignedInDeletion();
    if (result.ok) setPreview(result.preview);
    else {
      setPreview(null);
      setPreviewError(result.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const availability = preview ? deletionAvailability(preview) : null;
  const canDelete = !!preview && availability?.available === true && !busy;

  async function run() {
    if (!preview || !canDelete) return;
    const ok = await confirm(
      '共通アカウントを削除しますか？',
      'このIDで使っているすべてのサービスのデータと、ログイン用のアカウントが削除されます。元に戻せません。',
      '削除する',
    );
    if (!ok) return;
    setMessage(null);
    setBusy(true);
    const outcome = await deleteSignedInCommonAccount({ password, typed, preview });
    setPassword('');
    if (outcome.ok) {
      notifyThenSignOut('共通アカウントを削除しました', 'これまでご利用いただき、ありがとうございました。');
      return;
    }
    if (outcome.pending || outcome.signedOut) {
      notifyThenSignOut(outcome.pending ? '削除の確認中です' : '削除を完了できませんでした', outcome.message);
      return;
    }
    setMessage(outcome.message);
    setBusy(false);
    if (outcome.refreshPreview) void load();
  }

  return (
    <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
      <Pressable onPress={onBack} disabled={busy} accessibilityRole="button" style={styles.backButton}>
        <Text style={styles.backText}>{backLabel}</Text>
      </Pressable>
      <Text style={styles.title}>共通アカウントを削除</Text>
      <View style={styles.warningBox}>
        <Text style={styles.warningTitle}>このIDで使っているすべてのサービスに影響します</Text>
        <Text style={styles.warningText}>
          かぶモリとX自動投稿など、共通ID（共通アカウント）で利用しているすべてのサービスのデータと、ログイン用のアカウントそのものが削除されます。元に戻すことはできません。
        </Text>
      </View>
      {loading ? (
        <ActivityIndicator color={palette.accent} style={styles.busy} />
      ) : previewError ? (
        <>
          <Message text={previewError} />
          <Pressable onPress={() => void load()} accessibilityRole="button" style={styles.secondaryButton}>
            <Text style={styles.secondaryText}>もう一度確認する</Text>
          </Pressable>
        </>
      ) : preview ? (
        <>
          <View style={styles.noticeBox}>
            <Text style={styles.noticeTitle}>このIDで利用中のサービス</Text>
            {preview.services.length === 0 ? (
              <Text style={styles.noticeItem}>・利用中のサービスはありません（ログインのみ）</Text>
            ) : (
              preview.services.map((service) => (
                <Text key={service} style={styles.noticeItem}>・{SERVICE_LABEL[service]}（データを削除し、利用を終了します）</Text>
              ))
            )}
            {preview.services.includes('x_autopost') ? (
              <Text style={styles.noticeItem}>・Xアカウントとの連携（自動投稿の許可）も解除されます</Text>
            ) : null}
            <Text style={styles.noticeItem}>・ログイン用のアカウント（メールアドレス、パスワード）</Text>
            <Text style={styles.noticeItem}>・すべての端末のログイン状態</Text>
          </View>
          {preview.deletionInProgress ? (
            <Text style={styles.note}>削除手続きの途中です。パスワードを入力すると、続きから再開します。</Text>
          ) : null}
          {availability && !availability.available ? (
            <Message text={availability.message} />
          ) : (
            <>
              <PasswordField value={password} onChange={setPassword} editable={!busy} />
              <Text style={styles.label}>確認のため「{DELETE_TYPED_PHRASE}」と入力してください</Text>
              <TextInput
                value={typed}
                onChangeText={setTyped}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!busy}
                style={styles.input}
                accessibilityLabel="確認用の入力"
              />
              <Message text={message} />
              <Pressable
                onPress={() => void run()}
                disabled={!canDelete}
                style={[styles.destructiveButton, !canDelete && styles.disabled]}
                accessibilityRole="button"
                accessibilityLabel="共通アカウントを完全に削除する">
                {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.destructiveText}>共通アカウントを完全に削除する</Text>}
              </Pressable>
            </>
          )}
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, gap: 12 },
  backButton: { minHeight: 44, justifyContent: 'center' },
  backText: { color: palette.accent, fontWeight: '800' },
  title: { color: palette.text, fontSize: 26, fontWeight: '900', marginTop: 4 },
  lead: { color: palette.text, fontSize: 15, lineHeight: 23 },
  note: { color: palette.muted, fontSize: 14, lineHeight: 21 },
  noticeBox: { backgroundColor: palette.soft, borderRadius: 14, padding: 16, gap: 4 },
  keepBox: { backgroundColor: palette.blueSoft, borderRadius: 14, padding: 16, gap: 4 },
  noticeTitle: { color: palette.text, fontWeight: '800', marginBottom: 4 },
  noticeItem: { color: palette.muted, fontSize: 14, lineHeight: 21 },
  warningBox: { backgroundColor: palette.errorSoft, borderRadius: 14, padding: 16, gap: 6, borderWidth: 1, borderColor: '#f0c9c5' },
  warningTitle: { color: palette.errorText, fontWeight: '900', fontSize: 15 },
  warningText: { color: palette.errorText, fontSize: 14, lineHeight: 21 },
  label: { color: palette.text, fontWeight: '700', marginTop: 8 },
  input: { minHeight: 52, borderWidth: 1, borderColor: palette.border, borderRadius: 13, backgroundColor: palette.card, paddingHorizontal: 15, color: palette.text, fontSize: 16 },
  messageBox: { backgroundColor: '#fff2f1', borderRadius: 12, padding: 13 },
  messageText: { color: '#9a3631', lineHeight: 20 },
  destructiveButton: { minHeight: 52, marginTop: 8, borderRadius: 14, backgroundColor: '#9a3631', alignItems: 'center', justifyContent: 'center' },
  destructiveText: { color: '#fff', fontSize: 16, fontWeight: '900' },
  secondaryButton: { minHeight: 48, borderRadius: 14, borderWidth: 1, borderColor: palette.border, alignItems: 'center', justifyContent: 'center' },
  secondaryText: { color: palette.accent, fontWeight: '800' },
  disabled: { opacity: 0.55 },
  busy: { marginTop: 14 },
});
