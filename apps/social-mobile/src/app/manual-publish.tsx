// Manual X single post (F1, source-only, 2026-10-18): choose an X account, type the text, see the preview,
// confirm with an explicit consent, and (when a future owner connects the send port) send and see the result.
//
// Nothing here calls the network. The send goes through `getManualPublishPort()`; in this build that is the
// unconnected port, so the send button stays disabled with the reason shown, and no "sent" is ever displayed
// unless a port returned `published`. See features/manual-publish/manual-publish-port.ts for the hand-off and
// single-post-port.ts for the F3 contract adapter (prepared, not connected).
import { Link, Stack } from 'expo-router';
import * as Crypto from 'expo-crypto';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Dimensions, Platform, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { colors, spacing } from '@/constants/theme';
import { ActionButton, Card, Pill, Screen, SectionTitle, styles } from '@/components/ui';
import { ManualPostPreview } from '@/features/manual-publish/manual-post-preview';
import { acknowledgeAttempt, attemptMemory, inFlightSends, loadPersistedAttempt, reconcileLoadedRead, restoredAttemptOf, runReadinessCheck, runSend, ATTEMPT_CLEARED_CODE, UNRESOLVED_REFUSAL_CODE, type FlowDeps, type InFlightTakeOver } from '@/features/manual-publish/manual-publish-flow';
import {
  MANUAL_PUBLISH_TEXT_LIMIT,
  SEND_BLOCK_MESSAGES,
  checkDraft,
  consentForSend,
  createInitialState,
  createSendingState,
  manualPublishReducer,
  normalizeDraft,
  resolveSelectedAccount,
  sendGate,
  shortHash,
  surfaceOf,
  xAccountsOf,
  type Surface,
} from '@/features/manual-publish/manual-publish-model';
import { DRAFT_MAX_TEXT_UNITS, loadDraftForRestore } from '@/features/manual-publish/manual-publish-draft-store';
import { getManualPublishPort, type ResultMarks } from '@/features/manual-publish/manual-publish-port';
import { attemptStore, draftStore } from '@/features/manual-publish/manual-publish-storage';
import { useActiveAccount } from '@/providers/active-account-provider';
import { useAuth } from '@/providers/auth-provider';
import { useDataStatus } from '@/providers/data-provider';

const SURFACE_PILL: Readonly<Record<Surface, { tone: 'neutral' | 'success' | 'warning' | 'danger'; label: string }>> = {
  not_connected: { tone: 'warning', label: 'Xアカウント未接続' },
  unavailable: { tone: 'warning', label: '状態を確認できません' },
  record_unchecked: { tone: 'warning', label: '前回の送信記録を確認できていません' },
  ready_to_preview: { tone: 'neutral', label: '入力・プレビュー・確認ができます' },
  sending: { tone: 'neutral', label: '送信中' },
  sent: { tone: 'success', label: 'Xが投稿を受け付けました' },
  simulated: { tone: 'warning', label: '模擬（テスト）の結果です' },
  pending: { tone: 'warning', label: 'まだ送信されていません（処理中の可能性）' },
  failed: { tone: 'danger', label: '投稿されませんでした' },
  refused: { tone: 'danger', label: '送信は受け付けられませんでした' },
  unconfirmed: { tone: 'warning', label: '結果を確認できません' },
  uncertain: { tone: 'warning', label: '投稿されたか確認できません' },
};

const CLEARED_ELSEWHERE_NOTE = 'この送信記録は別の画面で確認済み（または完了）になっていたため、送信しませんでした。Xのプロフィールで投稿を確認してください。';
const SIMULATED_NOTE = 'サーバーはこの結果を模擬（テスト用）として返しました。実際のXへの投稿の証拠ではありません。';
const AFTER_FREEZE_NOTE = 'アカウントの停止または利用終了の手続きと重なって記録された結果です。';

/** Notes the server's marks call for. They explain a result; they never change what kind of result it is. */
function markNotes(marks: ResultMarks | null): string[] {
  if (marks === null) return [];
  return [...(marks.simulated ? [SIMULATED_NOTE] : []), ...(marks.afterFreeze ? [AFTER_FREEZE_NOTE] : [])];
}

// This screen is drawn on a FIXED light background (the app has no dark palette), so its header and status bar are
// fixed too: dark text on light, whatever the device appearance. The root layout's status bar follows the device
// ("auto") and turns the status bar text white in dark mode, i.e. invisible on this screen (G2 QA A07).
// The status bar is set ONLY by the `<StatusBar>` below. The screen option `statusBarStyle` is deliberately NOT used:
// react-native-screens then insists on the view-controller-based status bar key of Info.plist being YES, which this
// app sets to NO, and raises the development red box (G2 QA S1). Any `statusBar*` option has the same effect.
// The back button (iOS) would otherwise show the title of the previous entry of the root stack, which is the internal route
// group name "(tabs)" (G2 Simulator QA G2-E2E-1). The screen is opened from the home tab only, so the back button says where it
// goes: "ホーム". Set on THIS screen's options -- the root layout and the other screens' back buttons are not touched.
const HEADER_OPTIONS = {
  headerShown: true,
  title: '手入力でXに投稿',
  headerBackTitle: 'ホーム',
  headerStyle: { backgroundColor: colors.background },
  headerTintColor: colors.ink,
  headerTitleStyle: { color: colors.ink },
} as const;

// With the soft keyboard up the form must stay scrollable AND the keyboard must stay up while the person scrolls to
// the end of it (G2 QA: `on-drag` closed the keyboard on the first drag, so "scroll to the bottom with the keyboard
// shown" was not possible). iOS: `interactive` only moves the keyboard when the finger drags INTO it, so dragging the
// content scrolls it and a downward drag over the keyboard still closes it. Android has no such mode: `on-drag`.
const KEYBOARD_DISMISS_MODE = Platform.OS === 'ios' ? 'interactive' : 'on-drag';

// A multi-line text box that grows without a limit pushes the line being typed under the soft keyboard (G2 QA G2-A11Y-1). The box
// grows up to this height and then scrolls inside itself, so the line being typed stays in the box and above the keyboard.
const TEXT_BOX_MAX_HEIGHT = 240;

/** The device text size (font scale) now; 1 where it cannot be read. */
function currentFontScale(): number {
  const scale = Dimensions?.get?.('window')?.fontScale;
  return typeof scale === 'number' && scale > 0 ? scale : 1;
}

/** One attempt id per attempt: a lowercase UUID, which is what the F3 server accepts as `clientRequestId`. */
function defaultRequestId() {
  return Crypto.randomUUID();
}

type ScreenProps = Readonly<{
  userId: string | null;
  /** Identifies the sign-in session (not a secret): a stored draft is put back only into the session that wrote it. */
  sessionMark?: string;
  now?: () => number;
  newRequestId?: () => string;
}>;

/** What the device holds for the draft: nothing known yet, nothing (removed), or this text and account. */
const DRAFT_ON_DEVICE_NONE = 'none';

/** The screen for ONE signed-in user. The route below re-creates it (new key) when the user changes. */
export function ManualPublishScreen({ userId, sessionMark = '', now = Date.now, newRequestId = defaultRequestId }: ScreenProps) {
  const { status: dataStatus } = useDataStatus();
  const { accounts, activeAccount } = useActiveAccount();
  // The process remembers an unresolved attempt with its text; after an app restart only the hash-only record on
  // the device is left, and until it has been read (or if it cannot be read) nothing can be typed or sent.
  // A send of THIS process that is not finished yet -- being prepared (its record on the device is still being written),
  // out, or answered but not yet recorded; the screen that started it was left, or re-created because the sign-in session
  // mark changed. This screen is "sending" too: it never calls the attempt unconfirmed and offers no re-ask while that
  // send is unfinished, and it shows the real answer when the send ends (below). Taken once, when the screen is created.
  const [state, dispatch] = useReducer(manualPublishReducer, null, () => {
    const out = inFlightSends.takeOver(userId);
    if (out !== null) return createSendingState(out.attempt, out.retry);
    const remembered = attemptMemory.get(userId);
    return createInitialState(remembered, remembered === null && userId !== null ? { kind: 'loading' } : undefined);
  });
  // (Both initialisers run in the same render, so they see the same send.)
  const [takenOver, setTakenOver] = useState<InFlightTakeOver | null>(() => inFlightSends.takeOver(userId));
  const [recheck, setRecheck] = useState(0);
  const [clearFailed, setClearFailed] = useState(false);
  // A re-ask on this screen was not made because the attempt had been acknowledged or ended on another screen.
  const [clearedElsewhere, setClearedElsewhere] = useState(false);
  // When the device text size changes while the screen is open, text that was already laid out is cut (G2 QA G2-A11Y-3; opening
  // the screen again shows it right). The scroll content is laid out anew (keyed by the text size) -- no size limit is imposed.
  const [fontScale, setFontScale] = useState(currentFontScale);
  useEffect(() => {
    const subscription = Dimensions?.addEventListener?.('change', ({ window }) => {
      if (typeof window?.fontScale === 'number' && window.fontScale > 0) setFontScale(window.fontScale);
    });
    return () => subscription?.remove?.();
  }, []);
  // A result must open at ITS beginning -- its heading and its warning ("check X first") -- not where the confirmation was scrolled
  // to (with large text the result appeared scrolled to its end, showing only the discard button first: G2 QA G2-A11Y-2).
  const scrollRef = useRef<ScrollView>(null);
  const resultTop = useRef<number | null>(null);
  const scrollToResult = useRef(false);
  const sendingRef = useRef(false);
  const clearingRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const port = useMemo(() => getManualPublishPort(), []);
  const deps: FlowDeps = useMemo(() => ({ port, now, newRequestId, memory: attemptMemory, store: attemptStore, inflight: inFlightSends }), [port, now, newRequestId]);

  // A screen that took over a send waits for the answer of THAT send (the screen that started it no longer applies it).
  // If that send cannot be found any more, the attempt is shown as uncertain -- never sent, never "not posted", never re-asked.
  useEffect(() => {
    if (state.phase !== 'sending' || sendingRef.current || userId === null || state.requestId === null) return undefined;
    const requestId = state.requestId;
    if (takenOver === null || takenOver.attempt.requestId !== requestId) {
      dispatch({ type: 'send_settled', requestId, outcome: { kind: 'uncertain', targetId: requestId, code: 'SEND_STATE_LOST' } });
      return undefined;
    }
    let cancelled = false;
    void takenOver.answer.then((outcome) => {
      if (!cancelled && mountedRef.current) dispatch({ type: 'send_settled', requestId, outcome });
    });
    return () => { cancelled = true; };
  }, [state.phase, state.requestId, userId, takenOver]);

  const storeKind = state.store.kind;
  useEffect(() => {
    if (storeKind !== 'loading' || userId === null) return undefined;
    let cancelled = false;
    void loadPersistedAttempt(deps, userId).then((read) => {
      if (cancelled || !mountedRef.current) return;
      // The read is a snapshot of the moment it was taken; what this process knows NOW wins (see reconcileLoadedRead): a send
      // of this user that is still out (wait for it, never call it unconfirmed), or an attempt that is already in the memory
      // (an old "nothing" must not open an empty editor beside an unresolved attempt).
      const view = reconcileLoadedRead(deps, userId, read);
      if (view.kind === 'send') {
        setTakenOver(view.takeOver);
        dispatch({ type: 'send_adopted', attempt: view.takeOver.attempt, retrying: view.takeOver.retry });
      } else if (view.kind === 'memory') {
        dispatch({ type: 'store_loaded', unresolved: view.attempt });
      } else if (view.read.kind === 'none') dispatch({ type: 'store_loaded', unresolved: null });
      else if (view.read.kind === 'found') dispatch({ type: 'store_loaded', unresolved: restoredAttemptOf(view.read.attempt) });
      else dispatch({ type: 'store_unreadable', reason: view.read.reason });
    });
    return () => { cancelled = true; };
  }, [storeKind, userId, deps]);

  const xAccounts = useMemo(() => xAccountsOf(accounts), [accounts]);
  const xIdsKey = xAccounts.map((account) => account.id).join('|');

  // A callback route (oauth-callback / auth-callback) replaces this screen with the home screen, so what was typed is
  // kept on the device for a short time (see manual-publish-draft-store.ts) and put back ONCE when the screen opens
  // again -- into the editor only: no consent, confirmation or attempt id is ever restored.
  const draftOnDevice = useRef<string | null>(null);
  const draftRestore = state.draftRestore;
  const storeReady = state.store.kind === 'ready';
  const editorUntouched = state.phase === 'editing' && state.unresolved === null;
  useEffect(() => {
    if (draftRestore !== 'pending' || !storeReady) return undefined;
    // Nothing to restore: signed out, or the screen starts on a result / an unresolved attempt.
    if (userId === null || !editorUntouched) {
      dispatch({ type: 'draft_restored', text: null, accountId: null });
      return undefined;
    }
    // Without a usable account list a draft cannot be judged: wait for it. A blocked data source restores nothing, and
    // the effect below then removes the stored draft (an editor that is empty and finished looking leaves none behind).
    if (dataStatus === 'blocked') {
      dispatch({ type: 'draft_restored', text: null, accountId: null });
      return undefined;
    }
    if (dataStatus !== 'ready' && dataStatus !== 'mock_preview') return undefined;
    let cancelled = false;
    void loadDraftForRestore(draftStore, userId, { at: now(), sessionMark, xAccounts }).then((decision) => {
      if (cancelled || !mountedRef.current) return;
      if (decision.kind === 'restore') {
        draftOnDevice.current = JSON.stringify([decision.text, decision.accountId]);
        dispatch({ type: 'draft_restored', text: decision.text, accountId: decision.accountId });
      } else {
        dispatch({ type: 'draft_restored', text: null, accountId: null });
      }
    });
    return () => { cancelled = true; };
  }, [draftRestore, storeReady, editorUntouched, userId, dataStatus, sessionMark, xAccounts, now]);

  // Keep the stored draft equal to the editor while the person edits; remove it when it is empty, too long, or when a
  // send is under way or unresolved (the text then lives only in that attempt, whose durable record holds no text).
  useEffect(() => {
    if (userId === null || !storeReady || draftRestore !== 'done') return;
    const sendingOrUnresolved = state.phase === 'sending' || state.unresolved !== null;
    const text = state.draft;
    // (Without a usable session mark the draft store itself refuses to write and the restore removes what it finds.)
    if (sendingOrUnresolved || (state.phase === 'editing' && (text.trim() === '' || text.length > DRAFT_MAX_TEXT_UNITS))) {
      if (draftOnDevice.current !== DRAFT_ON_DEVICE_NONE) {
        draftOnDevice.current = DRAFT_ON_DEVICE_NONE;
        void draftStore.clear(userId);
      }
      return;
    }
    if (state.phase !== 'editing') return;
    const key = JSON.stringify([text, state.accountId]);
    if (draftOnDevice.current === key) return;
    draftOnDevice.current = key;
    void draftStore.write(userId, { accountId: state.accountId, text, sessionMark, savedAt: now() });
  }, [userId, storeReady, draftRestore, state.phase, state.unresolved, state.draft, state.accountId, sessionMark, now]);
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
  }, [state.phase, state.accountId, state.store.kind, suggestedId, xIdsKey]);

  // Opening the confirmation asks the send port -- never the cached connection value -- whether THIS account can send now.
  // Not for demo (mock_preview) or unloaded data: its accounts are not real, so the server is not asked about them.
  useEffect(() => {
    if (state.phase !== 'confirming' || state.accountId === null || dataStatus !== 'ready') return undefined;
    const accountId = state.accountId;
    let cancelled = false;
    void runReadinessCheck(deps, accountId).then((record) => {
      if (!cancelled) dispatch({ type: 'readiness_received', record });
    });
    return () => { cancelled = true; };
  }, [state.phase, state.accountId, dataStatus, deps, recheck]);

  const draft = checkDraft(state.draft);
  const gate = sendGate({ now: now(), signedIn: userId !== null, dataStatus, account, state });
  const surface = surfaceOf({ dataStatus, xAccountCount: xAccounts.length, account, state });
  const pill = SURFACE_PILL[surface];
  const consent = consentForSend(state);
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
    const given = consentForSend(state);
    if (checked.kind !== 'ok' || given === null) return;
    // A retry of an unresolved attempt reuses ITS id (the server never sends twice for one id); a new attempt gets a new one.
    const requestId = state.unresolved !== null ? state.unresolved.requestId : newRequestId();
    const start = { type: 'send_started', requestId, now: at } as const;
    if (manualPublishReducer(state, start).phase !== 'sending') return;
    sendingRef.current = true;
    setClearedElsewhere(false);
    dispatch(start);
    void draftStore.clear(userId); // the text now lives only in this attempt
    const retry = state.unresolved !== null;
    void runSend(deps, { userId, accountId: account.id, text: checked.text, requestId, consent: given, retry }).then((outcome) => {
      sendingRef.current = false;
      if (!mountedRef.current) return;
      // A re-ask that was not made because another screen already moved the attempt on (it is uncertain now): show the attempt as
      // the process knows it, not what this screen believed (and not the refusal as if it were an answer about the attempt).
      // A re-ask of an attempt that was acknowledged or ended on another screen is not made either: the attempt is dropped here too.
      const code = (outcome as { code?: unknown }).code;
      if (retry && code === UNRESOLVED_REFUSAL_CODE && attemptMemory.get(userId) !== null) {
        dispatch({ type: 'send_not_started', requestId, attempt: attemptMemory.get(userId) });
      } else if (code === ATTEMPT_CLEARED_CODE) { // (only a re-ask is ever answered with it)
        setClearedElsewhere(true);
        dispatch({ type: 'send_not_started', requestId, attempt: attemptMemory.get(userId) });
      } else {
        dispatch({ type: 'send_settled', requestId, outcome });
      }
    });
  };

  // The user's explicit "I checked X". The record on the device is removed FIRST; if that fails nothing is unlocked.
  const acknowledge = (then: 'unresolved_acknowledged' | 'store_unreadable_acknowledged') => {
    if (userId === null || clearingRef.current) return;
    clearingRef.current = true;
    // The attempt this screen shows is named, so an old screen can never clear a newer attempt or one whose send is out.
    const expected = then === 'unresolved_acknowledged' ? state.unresolved?.requestId ?? null : null;
    void acknowledgeAttempt(deps, userId, expected).then((result) => {
      clearingRef.current = false;
      if (!mountedRef.current) return;
      setClearFailed(result.kind === 'failed');
      if (result.kind === 'cleared') {
        dispatch({ type: then });
      } else if (result.kind === 'refused') {
        // Nothing was cleared. Show the attempt as the process knows it now (a send that is out is waited for), not an empty editor.
        const send = inFlightSends.takeOver(userId);
        if (send !== null) setTakenOver(send);
        dispatch({ type: 'ack_refused', send: send === null ? null : { attempt: send.attempt, retry: send.retry }, attempt: attemptMemory.get(userId) });
      }
    });
  };

  const result = state.phase === 'result' ? state.result : null;
  // Each newly shown result is scrolled to its beginning, once its position is known (see the result's onLayout below).
  const resultShown = result === null ? null : `${state.requestId ?? ''}:${result.kind}`;
  useEffect(() => {
    if (resultShown === null) {
      resultTop.current = null;
      scrollToResult.current = false;
      return;
    }
    if (resultTop.current !== null) scrollRef.current?.scrollTo({ y: resultTop.current, animated: false });
    else scrollToResult.current = true;
  }, [resultShown]);
  const restored = state.unresolved !== null && state.unresolved.text === null;
  const retryLabel = restored ? '前回と同じ本文を入力して確認し直す' : '同じ内容・同じ送信IDで確認し直す';
  const discardLabel = restored ? 'Xで確認しました（この記録を破棄）' : 'Xで確認しました（この下書きを破棄）';

  return (
    <Screen>
      <Stack.Screen options={HEADER_OPTIONS} />
      <StatusBar style="dark" />
      {/* The soft keyboard must never put the end of the form out of reach (G2 QA A03/B11/B17): the scroll view makes
          room for it (iOS), keeps taps working while it is up, keeps it up while the content is scrolled and lets a
          downward drag over the keyboard dismiss it. */}
      <ScrollView
        key={`text-size-${fontScale}`}
        ref={scrollRef}
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={{ gap: 16, paddingBottom: spacing.xl }}
        keyboardDismissMode={KEYBOARD_DISMISS_MODE}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Card>
          <Pill tone={pill.tone}>{pill.label}</Pill>
          {clearedElsewhere ? (
            <Text style={{ color: colors.warning, fontWeight: '700' }}>{CLEARED_ELSEWHERE_NOTE}</Text>
          ) : null}
          <Text style={styles.muted}>
            送信の前に、サーバー側で接続・利用権・投稿許可を確認します。確認できないときは送信できません。接続状態の表示は参考情報で、送信の許可ではありません。
          </Text>
        </Card>

        {state.store.kind !== 'ready' ? (
          <Card>
            <SectionTitle>{state.store.kind === 'loading' ? '前回の送信記録を確認しています' : '前回の送信記録を読み込めません'}</SectionTitle>
            <Text style={{ color: colors.warning, fontWeight: '700' }}>
              {state.store.kind === 'loading' ? SEND_BLOCK_MESSAGES.store_loading : SEND_BLOCK_MESSAGES.store_unreadable}
            </Text>
            {state.store.kind === 'unreadable' ? (
              <>
                <Text style={styles.muted}>
                  {state.store.reason === 'io'
                    ? '端末の保存領域を読めませんでした。読み込めるまで、送信はできません。'
                    : state.store.reason === 'version'
                      ? '新しい版のアプリが残した記録のため、この版では読めません。'
                      : '記録が壊れているため、読めません。'}
                </Text>
                <ActionButton label="もう一度読み込む" onPress={() => dispatch({ type: 'store_reload_requested' })} />
                {state.store.reason !== 'io' ? (
                  <>
                    <Text style={styles.muted}>Xで最近の投稿を確認してから押してください。押すと、この記録は消え、送信できるようになります。</Text>
                    <ActionButton label="Xで確認しました（記録を消去して続ける）" onPress={() => acknowledge('store_unreadable_acknowledged')} />
                  </>
                ) : null}
                {clearFailed ? <Text style={{ color: colors.danger, fontWeight: '700' }}>記録を消去できませんでした。送信は引き続きできません。</Text> : null}
              </>
            ) : null}
          </Card>
        ) : null}

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

        {state.phase === 'editing' && state.store.kind === 'ready' ? (
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
                scrollEnabled
                style={{ minHeight: 140, maxHeight: TEXT_BOX_MAX_HEIGHT, borderColor: colors.border, borderWidth: 1, borderRadius: 12, padding: spacing.sm, color: colors.ink, fontSize: 15, textAlignVertical: 'top' }}
                value={state.draft}
              />
              <Text style={draft.kind === 'too_long' || draft.kind === 'invalid_characters' ? { color: colors.danger, fontWeight: '700' } : styles.muted}>
                {draft.kind === 'too_long'
                  ? `Xの上限（${draft.limit}）を${draft.used - draft.limit}超えています（${draft.used} / ${draft.limit}）`
                  : draft.kind === 'invalid_characters'
                    ? '使えない文字が含まれています。'
                    : `${draft.kind === 'ok' ? draft.used : 0} / ${MANUAL_PUBLISH_TEXT_LIMIT}　全角・絵文字は2、URLは23として数えます`}
              </Text>
              <Text style={styles.muted}>入力中の本文と投稿先は、この端末に最大24時間まで保存され、画面を離れても戻れます。ログインし直すと復元されません。送信を始めると消えます。</Text>
              {state.draft !== '' ? <ActionButton label="下書きを消す" onPress={() => dispatch({ type: 'draft_changed', text: '' })} /> : null}
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
              {(state.phase === 'confirming' && state.unresolved !== null) || (state.phase === 'sending' && state.retrying) ? (
                <Text style={styles.muted}>前回と同じ内容・同じ送信IDで確認します。同じ送信IDを使うのは二重投稿を避けるためですが、送る前にXで投稿済みでないことを確認してください。</Text>
              ) : null}
            </Card>
            {state.phase === 'confirming' && state.unresolved !== null && state.unresolved.text === null ? (
              <Card>
                <SectionTitle detail={`前回の本文の照合コード ${shortHash(state.unresolved.contentSha256)}`}>前回と同じ本文を入力</SectionTitle>
                <Text style={styles.muted}>アプリを再起動したため、前回の本文は端末に残っていません。入力した本文が前回と同じときだけ、同じ送信IDで確認し直せます。</Text>
                <TextInput
                  accessibilityLabel="前回と同じ本文の入力"
                  multiline
                  onChangeText={(text) => dispatch({ type: 'draft_changed', text })}
                  placeholder="前回と同じ本文を入力してください"
                  placeholderTextColor={colors.muted}
                  scrollEnabled
                  style={{ minHeight: 100, maxHeight: TEXT_BOX_MAX_HEIGHT, borderColor: colors.border, borderWidth: 1, borderRadius: 12, padding: spacing.sm, color: colors.ink, fontSize: 15, textAlignVertical: 'top' }}
                  value={state.draft}
                />
              </Card>
            ) : null}
            <ManualPostPreview account={account} text={draft.kind === 'ok' ? draft.text : ''} />
            <Card>
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: consent !== null, disabled: state.phase === 'sending' }}
                disabled={state.phase === 'sending'}
                onPress={() => dispatch({ type: 'consent_changed', checked: consent === null })}
                style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}
              >
                <View style={{ width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: colors.primary, backgroundColor: consent !== null ? colors.primary : colors.surface }} />
                <Text style={{ flex: 1, color: colors.ink, fontWeight: '700' }}>この内容を、いま、Xに投稿することに同意します</Text>
              </Pressable>
              <Text style={styles.muted}>
                {consent !== null ? `同意は、この本文（照合コード ${shortHash(consent.contentSha256)}）だけに有効です。` : '同意するまで送信できません。'}
              </Text>
            </Card>
            <Card>
              <Text style={{ color: gate.allowed ? colors.success : colors.muted, fontWeight: '700' }}>
                {gate.allowed ? 'サーバーで送信できる状態を確認できました。' : SEND_BLOCK_MESSAGES[gate.reason]}
              </Text>
              {!gate.allowed && (gate.reason === 'readiness_stale' || gate.reason === 'port_unavailable' || gate.reason === 'readiness_other_account') ? (
                <ActionButton label="送信できる状態を再確認する" onPress={() => setRecheck((value) => value + 1)} />
              ) : null}
            </Card>
            <ActionButton label={state.phase === 'sending' ? '送信中…' : 'Xに投稿する'} disabled={!gate.allowed} onPress={send} />
            <ActionButton label="戻る" disabled={state.phase === 'sending'} onPress={() => dispatch({ type: 'confirm_closed' })} />
          </>
        ) : null}

        {result ? (
          <View
            onLayout={(event) => {
              resultTop.current = event.nativeEvent.layout.y;
              if (scrollToResult.current) {
                scrollToResult.current = false;
                scrollRef.current?.scrollTo({ y: resultTop.current, animated: false });
              }
            }}
          >
          <Card>
            {result.kind === 'sent' ? (
              <>
                <SectionTitle>Xが投稿を受け付けました</SectionTitle>
                <Text style={{ color: colors.ink }}>Xから返された投稿ID: {result.providerPostId}</Text>
                {result.marks.afterFreeze ? (
                  <Text style={{ color: colors.warning, fontWeight: '700' }}>この投稿は、アカウントの停止または利用終了の手続きと重なって記録されました。投稿そのものはXが受け付けています。</Text>
                ) : null}
                <Text style={styles.muted}>アプリ内の履歴との照合は、この画面ではまだ行っていません。</Text>
                <ActionButton label="新しい投稿を作る" onPress={() => dispatch({ type: 'result_dismissed' })} />
              </>
            ) : result.kind === 'simulated' ? (
              <>
                <SectionTitle>模擬（テスト）の結果です</SectionTitle>
                <Text style={{ color: colors.warning, fontWeight: '700' }}>サーバーはこの結果を模擬として返しました。実際のXへの投稿としては扱いません。</Text>
                <Text style={styles.muted}>模擬の結果は、実際にXへ投稿された証拠でも、投稿されていない証拠でもありません。Xで確認するまで、同じ内容を再送信しないでください。</Text>
                {markNotes({ simulated: false, afterFreeze: result.marks.afterFreeze }).map((line) => <Text key={line} style={styles.muted}>{line}</Text>)}
                <ActionButton label={discardLabel} onPress={() => acknowledge('unresolved_acknowledged')} />
              </>
            ) : result.kind === 'failed' ? (
              <>
                <SectionTitle>投稿されませんでした</SectionTitle>
                <Text style={{ color: colors.ink }}>Xに投稿される前に止まりました。本文は残してあります。</Text>
                <Text style={styles.muted}>コード: {result.code}</Text>
                {markNotes(result.marks).map((line) => <Text key={line} style={styles.muted}>{line}</Text>)}
                <ActionButton label="編集に戻る" onPress={() => dispatch({ type: 'result_dismissed' })} />
              </>
            ) : result.kind === 'refused' ? (
              <>
                <SectionTitle>送信は受け付けられませんでした</SectionTitle>
                <Text style={{ color: colors.ink }}>サーバーは何も記録していません。本文は残してあります。</Text>
                <Text style={styles.muted}>コード: {result.code}</Text>
                <ActionButton label="編集に戻る" onPress={() => dispatch({ type: 'result_dismissed' })} />
              </>
            ) : result.kind === 'pending' ? (
              <>
                <SectionTitle>まだ送信されていません</SectionTitle>
                <Text style={{ color: colors.warning, fontWeight: '700' }}>混み合っているか、処理中の可能性があります。投稿済みとは扱いません。別の内容を送る前に、同じ内容で結果を確認してください。</Text>
                {result.code ? <Text style={styles.muted}>コード: {result.code}</Text> : null}
                {markNotes(result.marks).map((line) => <Text key={line} style={styles.muted}>{line}</Text>)}
                <ActionButton label={retryLabel} onPress={() => dispatch({ type: 'retry_requested' })} />
                <ActionButton label={discardLabel} onPress={() => acknowledge('unresolved_acknowledged')} />
              </>
            ) : result.kind === 'unconfirmed' ? (
              <>
                <SectionTitle>結果を確認できません</SectionTitle>
                <Text style={{ color: colors.warning, fontWeight: '700' }}>通信できず、投稿されたかどうか分かりません。同じ内容で確認し直すときは同じ送信IDを使います。送る前に、Xで投稿済みでないことを確認してください。</Text>
                {result.code ? <Text style={styles.muted}>コード: {result.code}</Text> : null}
                <ActionButton label={retryLabel} onPress={() => dispatch({ type: 'retry_requested' })} />
                <ActionButton label={discardLabel} onPress={() => acknowledge('unresolved_acknowledged')} />
              </>
            ) : (
              <>
                <SectionTitle>投稿されたか確認できません</SectionTitle>
                <Text style={{ color: colors.warning, fontWeight: '700' }}>Xに投稿された可能性があります。Xで確認するまで、同じ内容を再送信しないでください。</Text>
                <Text style={styles.muted}>コード: {result.code}</Text>
                {markNotes(result.marks).map((line) => <Text key={line} style={styles.muted}>{line}</Text>)}
                <ActionButton label={discardLabel} onPress={() => acknowledge('unresolved_acknowledged')} />
              </>
            )}
            {state.unresolved !== null ? (
              <>
                {restored ? <Text style={styles.muted}>アプリが再起動されたため、本文は端末に残っていません。Xのプロフィールで、最近の投稿を確認してください。</Text> : null}
                <Text style={styles.muted}>「Xで確認しました」を押すと、この記録は消え、同じ内容も新しい投稿として送れるようになります。Xで確認してから押してください。</Text>
                {clearFailed ? <Text style={{ color: colors.danger, fontWeight: '700' }}>記録を消去できませんでした。送信は引き続きできません。</Text> : null}
              </>
            ) : null}
          </Card>
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

export default function ManualPublishRoute() {
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  // A different signed-in user (or sign-out) gets a fresh screen: no draft, selection or result carries over.
  // The screen is re-created when the person OR the sign-in session changes -- also without a sign-out in between (a
  // new sign-in of the same person) -- so text typed in one session is never carried into the next (G2 SM3).
  const sessionMark = session?.user.last_sign_in_at ?? '';
  return <ManualPublishScreen key={userId === null ? 'signed-out' : `${userId}:${sessionMark}`} userId={userId} sessionMark={sessionMark} />;
}
