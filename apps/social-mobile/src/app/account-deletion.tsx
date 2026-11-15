import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Pressable, ScrollView, Text, TextInput } from 'react-native';
import { colors } from '@/constants/theme';
import { Card, Pill, Screen, SectionTitle, styles } from '@/components/ui';
import { reauthMethods, sameDeletionContext, type DeletionContext, type ReauthMethod } from '@/domain/account-deletion';
import { COMMON_DELETE_CONFIRM_PHRASE, endFailure, POSTONA_END_CONFIRM_PHRASE, POSTONA_END_SOURCE_ENABLED, type EndFailure, type EndResult } from '@/domain/postona-service-end';
import { POSTONA_END_VS_ACCOUNT_DELETE, REMOTE_UNVERIFIED } from '@/domain/postona-end-notices';
import { PROVIDER_LABELS } from '@/domain/auth-flows';
import { sessionIdOf } from '@/domain/recovery-binding';
import { LEGAL_LINK_LABELS } from '@/domain/legal-links';
import { LEGAL_LINKS } from '@/lib/legal-config';
import type { BoundEndPreview } from '@/lib/postona-service-end-client';
import { useAuth } from '@/providers/auth-provider';

const inputStyle = { borderColor: colors.border, borderWidth: 1, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 9, color: colors.ink, backgroundColor: '#FFFFFF' };

/** Service ending never selects whole-login deletion from a legacy scope preview. */
export default function AccountDeletionScreen() {
  const { session, backendAvailable, readiness, email, reauthenticate, previewPostonaEnd, endPostonaService } = useAuth();
  const [preview, setPreview] = useState<BoundEndPreview | EndFailure | null>(null);
  const [reauthed, setReauthed] = useState<DeletionContext | null>(null);
  const [password, setPassword] = useState('');
  const [phrase, setPhrase] = useState('');
  const [acknowledged, setAcknowledged] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const [result, setResult] = useState<(EndResult | EndFailure) & { context: DeletionContext } | null>(null);
  const [commonOpen, setCommonOpen] = useState(false);
  const [commonAcknowledged, setCommonAcknowledged] = useState(false);
  const [commonPhrase, setCommonPhrase] = useState('');
  const userId = session?.user.id ?? null;
  const sessionId = sessionIdOf(session);
  const enabled = POSTONA_END_SOURCE_ENABLED && backendAvailable;
  const context = { userId, sessionId };
  const pinned = sameDeletionContext(reauthed, context) ? reauthed : null;
  const ready = preview?.ok && sameDeletionContext(preview.context, context) ? preview : null;
  const visibleResult = result && sameDeletionContext(result.context, context) ? result : null;
  const methods = reauthMethods(session?.user.identities?.map((identity) => identity.provider) ?? [], (method) => method === 'email' ? email.signIn : readiness(method).usableNow);
  const canSubmit = Boolean(enabled && pinned && ready?.postonaAvailable && phrase.trim() === POSTONA_END_CONFIRM_PHRASE && ready.acknowledgementRequired.every((p) => acknowledged.includes(p)) && !busy);
  const support = LEGAL_LINKS.support;

  const loadPreview = useCallback(async () => {
    setPreview(null); setAcknowledged([]); setPhrase('');
    const answer = await previewPostonaEnd();
    setPreview(answer);
  }, [previewPostonaEnd]);
  useEffect(() => {
    let cancelled = false;
    if (enabled && userId && sessionId) void previewPostonaEnd().then((answer) => { if (!cancelled) setPreview(answer); });
    return () => { cancelled = true; };
  }, [enabled, previewPostonaEnd, userId, sessionId]);
  // Reset before rendering a changed auth binding so no frame reuses prior consent.
  const [renderBinding, setRenderBinding] = useState({ userId, sessionId });
  if (renderBinding.userId !== userId || renderBinding.sessionId !== sessionId) {
    setRenderBinding({ userId, sessionId });
    setAcknowledged([]); setPhrase(''); setCommonOpen(false); setCommonAcknowledged(false); setCommonPhrase(''); setResult(null);
  }

  async function confirmIdentity(method: ReauthMethod) {
    if (!enabled || submitting.current || busy) return;
    submitting.current = true; setBusy(true); setResult(null);
    try {
      const answer = await reauthenticate(method, method === 'email' ? password : undefined);
      setPassword(''); setAcknowledged([]); setPhrase('');
      if (answer.ok) { setReauthed(answer.context); await loadPreview(); }
      else { setReauthed(null); if (userId && sessionId) setResult({ ...endFailure('REAUTH_REQUIRED'), context: { userId, sessionId } }); }
    } catch {
      setReauthed(null); setPassword('');
      if (userId && sessionId) setResult({ ...endFailure('REAUTH_REQUIRED'), context: { userId, sessionId } });
    } finally { submitting.current = false; setBusy(false); }
  }
  async function submit() {
    if (!canSubmit || !pinned || !ready || submitting.current) return;
    submitting.current = true; setBusy(true); setResult(null);
    try {
      const answer = await endPostonaService({ context: pinned, preview: ready, phrase, acknowledged });
      setResult({ ...answer, context: pinned });
      setPreview(null); setAcknowledged([]); setPhrase(''); setReauthed(null);
    } catch {
      setResult({ ...endFailure('RESULT_UNCONFIRMED'), context: pinned });
      setPreview(null); setReauthed(null); setAcknowledged([]); setPhrase('');
    } finally { submitting.current = false; setBusy(false); }
  }

  return <Screen><ScrollView contentContainerStyle={{ gap: 16 }}>
    <SectionTitle detail="POSTONAだけの利用終了と、共通IDの完全削除は別の操作です。">利用終了・共通IDの管理</SectionTitle>
    <Card>
      <Text style={{ color: colors.ink, fontWeight: '800' }}>POSTONAの利用終了</Text>
      <Text style={styles.muted}>POSTONAの利用終了では、ログイン用の共通IDとかぶモリの利用状況・データは残ります。</Text>
      <Text style={styles.muted}>削除するもの</Text>
      {POSTONA_END_VS_ACCOUNT_DELETE.postona_end.removes.map((line) => <Text key={line} style={styles.muted}>・{line}</Text>)}
      <Text style={styles.muted}>残るもの</Text>
      {POSTONA_END_VS_ACCOUNT_DELETE.postona_end.keeps.map((line) => <Text key={line} style={styles.muted}>・{line}</Text>)}
      <Text style={styles.muted}>{POSTONA_END_VS_ACCOUNT_DELETE.postona_end.reversible}</Text>
      {!enabled ? <><Pill tone="warning">準備中</Pill><Text style={styles.muted}>{endFailure('POSTONA_END_UNAVAILABLE').lines[0]}</Text></>
        : preview === null ? <Pressable accessibilityRole="button" disabled={busy} onPress={() => void loadPreview()} style={styles.button}><Text style={styles.buttonText}>利用状況を確認する</Text></Pressable>
          : !preview.ok ? preview.lines.map((line) => <Text key={line} style={styles.muted}>{line}</Text>)
            : !ready?.postonaAvailable ? <Text style={styles.muted}>現在は安全に手続きを進められません。処理中の場合はしばらく待ち、結果の確認が必要な場合はお問い合わせください。</Text> : <>
              <Text style={styles.muted}>1. 本人確認</Text>
              {pinned ? <Pill tone="success">本人確認が済みました</Pill> : methods.map((method) => <Card key={method}>
                {method === 'email' ? <TextInput value={password} onChangeText={setPassword} placeholder="パスワード" secureTextEntry autoCapitalize="none" autoComplete="current-password" style={inputStyle} /> : null}
                <Pressable accessibilityRole="button" disabled={busy || (method === 'email' && !password)} onPress={() => void confirmIdentity(method)} style={styles.button}><Text style={styles.buttonText}>{PROVIDER_LABELS[method]}で本人確認</Text></Pressable>
              </Card>)}
              {!pinned && methods.length === 0 ? <Text style={styles.muted}>本人確認に使えるログイン方法を確認できません。お問い合わせください。</Text> : null}
              {ready.acknowledgementRequired.map((provider) => <Card key={provider}>
                <Text style={styles.muted}>{REMOTE_UNVERIFIED[provider].local}</Text>
                <Text style={styles.muted}>{REMOTE_UNVERIFIED[provider].remote}</Text>
                <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: acknowledged.includes(provider), disabled: busy }} disabled={busy} onPress={() => setAcknowledged((old) => old.includes(provider) ? old.filter((p) => p !== provider) : [...old, provider])}>
                  <Text style={styles.muted}>{acknowledged.includes(provider) ? '☑' : '☐'} {REMOTE_UNVERIFIED[provider].consent}</Text>
                </Pressable>
              </Card>)}
              <Text style={styles.muted}>2. 「{POSTONA_END_CONFIRM_PHRASE}」と入力してください。</Text>
              <TextInput value={phrase} onChangeText={setPhrase} editable={!busy} autoCapitalize="none" style={inputStyle} />
              <Pressable accessibilityRole="button" accessibilityState={{ disabled: !canSubmit }} disabled={!canSubmit} onPress={() => void submit()} style={[styles.button, { backgroundColor: colors.danger }, !canSubmit && { opacity: 0.5 }]}>
                <Text style={styles.buttonText}>POSTONAの利用を終了</Text>
              </Pressable>
            </>}
      {enabled && preview && (!preview.ok || !ready?.postonaAvailable) ? <Pressable accessibilityRole="button" disabled={busy} onPress={() => void loadPreview()} style={styles.button}><Text style={styles.buttonText}>利用状況を確認し直す</Text></Pressable> : null}
      {busy ? <ActivityIndicator color={colors.primary} /> : null}
      {visibleResult ? visibleResult.lines.map((line) => <Text key={line} style={styles.muted}>{line}</Text>) : null}
      {visibleResult && !visibleResult.ok && visibleResult.retryable ? <Pressable accessibilityRole="button" disabled={busy} onPress={() => void loadPreview()} style={styles.button}><Text style={styles.buttonText}>利用状況を確認し直す</Text></Pressable> : null}
    </Card>
    <Card>
      <Text style={{ color: colors.ink, fontWeight: '800' }}>共通IDを完全削除</Text>
      <Text style={styles.muted}>ログイン用の共通IDとかぶモリ・POSTONAのデータを削除する、別の操作です。</Text>
      <Pressable accessibilityRole="button" onPress={() => setCommonOpen((open) => !open)} style={styles.button}><Text style={styles.buttonText}>共通IDの完全削除について確認する</Text></Pressable>
      {commonOpen ? <>
        {POSTONA_END_VS_ACCOUNT_DELETE.account_delete.removes.map((line) => <Text key={line} style={styles.muted}>・{line}</Text>)}
        {POSTONA_END_VS_ACCOUNT_DELETE.account_delete.keeps.map((line) => <Text key={line} style={styles.muted}>残るもの：{line}</Text>)}
        <Text style={styles.muted}>元に戻すことはできません。POSTONAだけの利用終了とは異なります。</Text>
        <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: commonAcknowledged }} onPress={() => setCommonAcknowledged((old) => !old)}><Text style={styles.muted}>{commonAcknowledged ? '☑' : '☐'} 共通IDとかぶモリ・POSTONAのデータが削除されることを理解しました。</Text></Pressable>
        <Text style={styles.muted}>「{COMMON_DELETE_CONFIRM_PHRASE}」と入力して確認します。</Text>
        <TextInput value={commonPhrase} onChangeText={setCommonPhrase} autoCapitalize="none" style={inputStyle} />
        <Pill tone="warning">現在は利用できません</Pill>
        <Text style={styles.muted}>{endFailure('COMMON_ACCOUNT_DELETION_UNAVAILABLE').lines[0]}</Text>
        <Pressable accessibilityRole="button" accessibilityState={{ disabled: true }} disabled style={[styles.button, { opacity: 0.5 }]}><Text style={styles.buttonText}>共通IDを完全削除（準備中）</Text></Pressable>
      </> : null}
    </Card>
    <Card><Text style={styles.muted}>X・Threadsの個別の連携解除はSNSアカウント画面の操作です。連携解除だけではPOSTONAの利用終了や共通IDの削除は行いません。</Text></Card>
    {support.href ? <Pressable accessibilityRole="link" onPress={() => { if (support.href) void Linking.openURL(support.href); }} style={styles.button}><Text style={styles.buttonText}>{LEGAL_LINK_LABELS.support}</Text></Pressable> : null}
  </ScrollView></Screen>;
}
