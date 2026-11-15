// Manual X single post (F1, source-only, 2026-10-18): choose an X account, type the text, see the preview,
// confirm, and (when a future owner connects the send port) send and see the result.
//
// Nothing here calls the network. The send goes through `getManualPublishPort()`; in this build that is the
// unconnected port, so the send button stays disabled with the reason shown, and no "sent" is ever displayed
// unless a port returned `published`. See features/manual-publish/manual-publish-port.ts for the hand-off.
import { Link, Stack } from 'expo-router';
import * as Crypto from 'expo-crypto';
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { colors, spacing } from '@/constants/theme';
import { ActionButton, Card, Pill, Screen, SectionTitle, styles } from '@/components/ui';
import { ManualPostPreview } from '@/features/manual-publish/manual-post-preview';
import { attemptMemory, runReadinessCheck, runSend, type FlowDeps } from '@/features/manual-publish/manual-publish-flow';
import {
  MANUAL_PUBLISH_TEXT_LIMIT,
  SEND_BLOCK_MESSAGES,
  checkDraft,
  createInitialState,
  manualPublishReducer,
  normalizeDraft,
  resolveSelectedAccount,
  sendGate,
  surfaceOf,
  xAccountsOf,
  type Surface,
} from '@/features/manual-publish/manual-publish-model';
import { getManualPublishPort } from '@/features/manual-publish/manual-publish-port';
import { useActiveAccount } from '@/providers/active-account-provider';
import { useAuth } from '@/providers/auth-provider';
import { useDataStatus } from '@/providers/data-provider';

const SURFACE_PILL: Readonly<Record<Surface, { tone: 'neutral' | 'success' | 'warning' | 'danger'; label: string }>> = {
  not_connected: { tone: 'warning', label: 'Xアカウント未接続' },
  unavailable: { tone: 'warning', label: '状態を確認できません' },
  ready_to_preview: { tone: 'neutral', label: '入力・プレビュー・確認ができます' },
  sending: { tone: 'neutral', label: '送信中' },
  sent: { tone: 'success', label: 'Xが投稿を受け付けました' },
  failed: { tone: 'danger', label: '投稿されませんでした' },
  uncertain: { tone: 'warning', label: '投稿されたか確認できません' },
};

function defaultRequestId() {
  return `manual-${Crypto.randomUUID()}`;
}

type ScreenProps = Readonly<{ userId: string | null; now?: () => number; newRequestId?: () => string }>;

/** The screen for ONE signed-in user. The route below re-creates it (new key) when the user changes. */
export function ManualPublishScreen({ userId, now = Date.now, newRequestId = defaultRequestId }: ScreenProps) {
  const { status: dataStatus } = useDataStatus();
  const { accounts, activeAccount } = useActiveAccount();
  const [state, dispatch] = useReducer(manualPublishReducer, null, () => createInitialState(attemptMemory.get(userId)));
  const [recheck, setRecheck] = useState(0);
  const sendingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const port = useMemo(() => getManualPublishPort(), []);
  const deps: FlowDeps = useMemo(() => ({ port, now, newRequestId, memory: attemptMemory }), [port, now, newRequestId]);

  const xAccounts = useMemo(() => xAccountsOf(accounts), [accounts]);
  const xIdsKey = xAccounts.map((account) => account.id).join('|');
  const suggestedId = activeAccount?.platform === 'x' ? activeAccount.id : xAccounts.length === 1 ? xAccounts[0].id : null;
  const account = resolveSelectedAccount(accounts, state.accountId);

  // The chosen account must always be one of the CURRENT list (account / workspace switch, disconnect).
  useEffect(() => {
    dispatch({ type: 'accounts_changed', accountIds: xIdsKey === '' ? [] : xIdsKey.split('|') });
  }, [xIdsKey]);
  useEffect(() => {
    if (state.phase === 'editing' && state.accountId === null && suggestedId !== null && xIdsKey.split('|').includes(suggestedId)) {
      dispatch({ type: 'account_selected', accountId: suggestedId });
    }
  }, [state.phase, state.accountId, suggestedId, xIdsKey]);

  // Opening the confirmation asks the send port -- never the cached connection value -- whether THIS account can send now.
  useEffect(() => {
    if (state.phase !== 'confirming' || state.accountId === null) return undefined;
    const accountId = state.accountId;
    let cancelled = false;
    void runReadinessCheck(deps, accountId).then((record) => {
      if (!cancelled) dispatch({ type: 'readiness_received', record });
    });
    return () => { cancelled = true; };
  }, [state.phase, state.accountId, deps, recheck]);

  const draft = checkDraft(state.draft);
  const gate = sendGate({ now: now(), signedIn: userId !== null, dataStatus, account, state });
  const surface = surfaceOf({ dataStatus, xAccountCount: xAccounts.length, account, state });
  const pill = SURFACE_PILL[surface];
  const previewText = draft.kind === 'ok' ? draft.text : draft.kind === 'too_long' ? normalizeDraft(state.draft) : '';
  const canConfirm = state.phase === 'editing' && account !== null && draft.kind === 'ok' && state.unresolved === null;
  const confirmHint =
    state.unresolved !== null ? SEND_BLOCK_MESSAGES.unresolved_attempt
      : account === null ? SEND_BLOCK_MESSAGES.no_account
        : draft.kind === 'empty' ? SEND_BLOCK_MESSAGES.draft_empty
          : draft.kind === 'too_long' ? SEND_BLOCK_MESSAGES.draft_too_long
            : draft.kind === 'invalid_characters' ? SEND_BLOCK_MESSAGES.draft_invalid
              : '';

  const send = () => {
    if (sendingRef.current || userId === null || account === null) return;
    const at = now();
    if (!sendGate({ now: at, signedIn: true, dataStatus, account, state }).allowed) return;
    const checked = checkDraft(state.draft);
    if (checked.kind !== 'ok') return;
    const requestId = newRequestId();
    const start = { type: 'send_started', requestId, now: at } as const;
    if (manualPublishReducer(state, start).phase !== 'sending') return;
    sendingRef.current = true;
    dispatch(start);
    void runSend(deps, { userId, accountId: account.id, text: checked.text, requestId }).then((outcome) => {
      sendingRef.current = false;
      if (mountedRef.current) dispatch({ type: 'send_settled', requestId, outcome });
    });
  };

  const acknowledgeUncertain = () => {
    if (userId !== null) attemptMemory.clear(userId);
    dispatch({ type: 'uncertain_acknowledged' });
  };

  return (
    <Screen>
      <Stack.Screen options={{ headerShown: true, title: '手入力でXに投稿' }} />
      <ScrollView contentContainerStyle={{ gap: 16 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <Card>
          <Pill tone={pill.tone}>{pill.label}</Pill>
          <Text style={styles.muted}>
            送信の前に、サーバー側で接続・利用権・投稿許可を確認します。確認できないときは送信できません。接続状態の表示は参考情報で、送信の許可ではありません。
          </Text>
        </Card>

        {surface === 'not_connected' || surface === 'unavailable' ? (
          <Card>
            <Text style={{ color: colors.ink, fontWeight: '800' }}>
              {surface === 'not_connected'
                ? account?.connectionStatus === 'not_connected'
                  ? 'このアカウントはXに接続されていません。'
                  : 'Xアカウントが接続されていません。'
                : account?.connectionStatus === 'needs_attention'
                  ? 'このアカウントはXとの接続の確認が必要です。'
                  : 'アカウント情報を読み込めていません。'}
            </Text>
            <Text style={styles.muted}>アカウント画面で接続状態を確認してください。接続後に、投稿先として選べます。</Text>
            <Link href="/accounts" asChild>
              <ActionButton label="アカウント画面を開く" onPress={() => {}} />
            </Link>
          </Card>
        ) : null}

        {state.phase === 'editing' ? (
          <>
            <Card>
              <SectionTitle detail="投稿先は、この画面で選んだXアカウントだけです">投稿先のXアカウント</SectionTitle>
              {xAccounts.length === 0 ? <Text style={styles.muted}>選べるXアカウントがありません。</Text> : null}
              {xAccounts.map((candidate) => {
                const selected = candidate.id === state.accountId;
                return (
                  <Pressable
                    key={candidate.id}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    onPress={() => dispatch({ type: 'account_selected', accountId: candidate.id })}
                    style={{ borderColor: selected ? colors.primary : colors.border, borderWidth: selected ? 2 : 1, borderRadius: 12, padding: spacing.sm }}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                      <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: candidate.profile.avatarColor }} />
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: colors.ink, fontWeight: '800' }}>{candidate.profile.displayName}</Text>
                        <Text style={styles.muted}>{candidate.profile.handle}</Text>
                      </View>
                      <Pill tone={candidate.connectionStatus === 'connected' ? 'neutral' : 'warning'}>
                        {candidate.connectionStatus === 'connected' ? (selected ? '選択中' : '選べます') : candidate.connectionStatus === 'needs_attention' ? '要確認' : '未接続'}
                      </Pill>
                    </View>
                  </Pressable>
                );
              })}
            </Card>

            <Card>
              <SectionTitle detail="Xに公開する本文を入力します">本文</SectionTitle>
              <TextInput
                accessibilityLabel="投稿の本文"
                editable={account !== null && state.unresolved === null}
                multiline
                onChangeText={(text) => dispatch({ type: 'draft_changed', text })}
                placeholder={account === null ? '先に投稿先のXアカウントを選んでください' : 'いまどうしていますか？'}
                placeholderTextColor={colors.muted}
                style={{ minHeight: 140, borderColor: colors.border, borderWidth: 1, borderRadius: 12, padding: spacing.sm, color: colors.ink, fontSize: 15, textAlignVertical: 'top' }}
                value={state.draft}
              />
              <Text style={draft.kind === 'too_long' || draft.kind === 'invalid_characters' ? { color: colors.danger, fontWeight: '700' } : styles.muted}>
                {draft.kind === 'too_long'
                  ? `Xの上限（${draft.limit}）を${draft.used - draft.limit}超えています（${draft.used} / ${draft.limit}）`
                  : draft.kind === 'invalid_characters'
                    ? '使えない文字が含まれています。'
                    : `${draft.kind === 'ok' ? draft.used : 0} / ${MANUAL_PUBLISH_TEXT_LIMIT}　全角・絵文字は2、URLは23として数えます`}
              </Text>
            </Card>

            <ManualPostPreview account={account} text={previewText} />

            <ActionButton label="内容を確認する" disabled={!canConfirm} onPress={() => dispatch({ type: 'confirm_opened' })} />
            {!canConfirm && confirmHint !== '' ? <Text style={styles.muted}>{confirmHint}</Text> : null}
          </>
        ) : null}

        {state.phase === 'confirming' || state.phase === 'sending' ? (
          <>
            <Card>
              <SectionTitle detail="下の内容でXに投稿します">送信前の確認</SectionTitle>
              <Text style={styles.muted}>投稿先</Text>
              <Text style={{ color: colors.ink, fontWeight: '800' }}>{account?.profile.displayName ?? '（選択なし）'}　{account?.profile.handle ?? ''}</Text>
              <Text style={styles.muted}>本文（この内容のまま送信します）</Text>
              <Text accessibilityLabel="送信する本文" style={{ color: colors.ink, fontSize: 15, lineHeight: 22 }}>{draft.kind === 'ok' ? draft.text : ''}</Text>
              <Text style={styles.muted}>{draft.kind === 'ok' ? `${draft.used} / ${draft.limit}` : ''}</Text>
              <Text style={{ color: colors.warning, fontWeight: '700' }}>送信するとXに公開されます。この画面から取り消すことはできません。</Text>
            </Card>
            <ManualPostPreview account={account} text={draft.kind === 'ok' ? draft.text : ''} />
            <Card>
              <Text style={{ color: gate.allowed ? colors.success : colors.muted, fontWeight: '700' }}>
                {gate.allowed ? 'サーバーで送信できる状態を確認できました。' : SEND_BLOCK_MESSAGES[gate.reason]}
              </Text>
              {!gate.allowed && (gate.reason === 'readiness_stale' || gate.reason === 'port_unavailable' || gate.reason === 'readiness_other_account') ? (
                <ActionButton label="送信できる状態を再確認する" onPress={() => setRecheck((value) => value + 1)} />
              ) : null}
            </Card>
            <ActionButton label={state.phase === 'sending' ? '送信中…' : 'Xに投稿する'} disabled={!gate.allowed} onPress={send} />
            <ActionButton label="編集に戻る" disabled={state.phase === 'sending'} onPress={() => dispatch({ type: 'confirm_closed' })} />
          </>
        ) : null}

        {state.phase === 'result' && state.result ? (
          <Card>
            {state.result.kind === 'sent' ? (
              <>
                <SectionTitle>Xが投稿を受け付けました</SectionTitle>
                <Text style={{ color: colors.ink }}>Xから返された投稿ID: {state.result.providerPostId}</Text>
                <Text style={styles.muted}>アプリ内の履歴との照合は、この画面ではまだ行っていません。</Text>
                <ActionButton label="新しい投稿を作る" onPress={() => dispatch({ type: 'result_dismissed' })} />
              </>
            ) : state.result.kind === 'failed' ? (
              <>
                <SectionTitle>投稿されませんでした</SectionTitle>
                <Text style={{ color: colors.ink }}>Xに投稿される前に止まりました。本文は残してあります。</Text>
                <Text style={styles.muted}>コード: {state.result.code}</Text>
                <ActionButton label="編集に戻る" onPress={() => dispatch({ type: 'result_dismissed' })} />
              </>
            ) : (
              <>
                <SectionTitle>投稿されたか確認できません</SectionTitle>
                <Text style={{ color: colors.warning, fontWeight: '700' }}>Xに投稿された可能性があります。Xで確認するまで、同じ内容を再送信しないでください。</Text>
                <Text style={styles.muted}>コード: {state.result.code}</Text>
                <ActionButton label="Xで確認しました（この下書きを破棄）" onPress={acknowledgeUncertain} />
              </>
            )}
          </Card>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

export default function ManualPublishRoute() {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  // A different signed-in user (or sign-out) gets a fresh screen: no draft, selection or result carries over.
  return <ManualPublishScreen key={userId ?? 'signed-out'} userId={userId} />;
}
