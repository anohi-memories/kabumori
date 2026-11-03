import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { mockRepository } from '@/data/mock-repository';
import { SupabaseContentSettingsRepository } from '@/data/content-settings-repository';
import { getSupabaseConfig, supabase } from '@/lib/supabase';
import { colors } from '@/constants/theme';
import { SignOutButton } from '@/components/sign-out-button';
import { ActionButton, Card, EmptyState, Pill, Screen, SectionTitle, styles } from '@/components/ui';
import { isSendNowRow, type ActionButtonKind } from '@/features/reservations/reservation-view';
import { useRefocusCount } from '@/features/reservations/use-refocus-count';
import { useXWriteGuard } from '@/features/reservations/use-x-write-guard';
import { clearXReconnectRequired, isXRowNotEditable, markXReconnectRequired, markXRowNotEditable } from '@/features/reservations/x-reconnect-signal';
import { CONNECTED_NOT_PROOF_TEXT, isNotEditableCode, NOT_EDITABLE_LABEL, NOT_EDITABLE_TEXT, RESTART_RECONNECTED_TEXT, xAnswerView } from '@/features/reservations/x-write-view';
import { resolvePostsView } from '@/domain/data-view';
import { buildSaveRequest, type SaveRequest, type ServerReservation } from '@/domain/reservation-flow';
import {
  AI_SETTINGS_UNLOADED,
  aiPlanningFor,
  applyAiSettingsResult,
  classifyServerPosts,
  effectiveBrandId,
  startAiSettingsLoad,
  type AiSettingsState,
} from '@/domain/schedule-view';
import {
  buildUnifiedSchedule,
  cancelDraft,
  detectConflicts,
  editDraftText,
  formatJst,
  moveDraftText,
  rerollBatch,
  resolveConflicts,
  type ScheduleBatch,
  type ScheduleDraft,
  type UnifiedFilter,
  type UnifiedItem,
} from '@/domain/schedule-planner';
import type { PostOrigin, PostStatus } from '@/domain/types';
import {
  confirmDraft,
  confirmationProgress,
  confirmationStatus,
  EMPTY_CONFIRMATIONS,
  withConfirmation,
  withoutConfirmations,
  type ConfirmationMap,
} from '@/features/schedule/confirmation-state';
import { PreviewCard } from '@/features/schedule/preview-card';
import { reservationErrorAction } from '@/features/schedule/reservation-error-actions';
import { createReservationStore, POSTONA_RESERVATION_PERSISTENCE_ENABLED } from '@/features/schedule/reservation-store';
import { ServerReservationCard } from '@/features/schedule/server-reservation-card';
import {
  applyListAnswer,
  domainConfirmations,
  isoFromJstFields,
  pendingAfter,
  replaceRow,
  reservationMessage,
  serverListFor,
  UNCERTAIN_CODE,
  type PendingSave,
  type ServerListSnapshot,
} from '@/features/schedule/server-reservations-state';
import { MODE_LABELS, PREVIEW_LABEL } from '@/features/schedule/schedule-labels';
import { ScheduleComposer, SmallButton, type AiPlanningInput } from '@/features/schedule/schedule-composer';
import { sha256Hex } from '@/features/schedule/sha256';
import { jstFieldsOf, retimeFixedDraft } from '@/features/schedule/time-edit';
import { useActiveAccount } from '@/providers/active-account-provider';
import { useDataStatus } from '@/providers/data-provider';

const originLabels: Record<PostOrigin, string> = { ai_generated: 'AI生成', user_authored: 'ユーザー作成', fixed: '固定', manual: '手動' };
const statusLabels: Record<PostStatus, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' }> = { draft: { label: '下書き', tone: 'neutral' }, scheduled: { label: '投稿待ち', tone: 'warning' }, publishing: { label: '投稿中', tone: 'warning' }, published: { label: '投稿済み', tone: 'success' }, failed: { label: '失敗', tone: 'danger' } };
const FILTERS: { key: UnifiedFilter; label: string }[] = [{ key: 'all', label: 'すべて' }, { key: 'ai', label: 'AI自動投稿' }, { key: 'manual', label: '手動予約' }];

export default function ScheduleScreen() {
  const router = useRouter();
  const { activeAccount } = useActiveAccount();
  const { status, reason, snapshot } = useDataStatus();
  const mockPosts = mockRepository.getPlannedPosts().filter((post) => post.accountId === activeAccount?.id);
  const view = resolvePostsView(status, reason, snapshot?.plannedPosts, mockPosts);
  // The brand the whole screen plans for is the SELECTED account's brand -- never the snapshot's first
  // workspace, which may belong to a different brand than the account the user picked.
  const brandId = effectiveBrandId({ status, activeAccount });
  const repository = useMemo(() => (supabase ? new SupabaseContentSettingsRepository(supabase) : null), []);

  // Release gate OFF: this is the disabled store (enabled === false) and every server path below is skipped, so
  // nothing is ever sent from this screen. The live client is handed over, but only a gate ON builds the live store.
  const reservationStore = useMemo(() => {
    const config = getSupabaseConfig();
    const live = supabase && config.ok ? { supabaseUrl: config.config.url, session: supabase, publishableKey: config.config.publishableKey } : null;
    return createReservationStore(POSTONA_RESERVATION_PERSISTENCE_ENABLED, live);
  }, []);
  const [filter, setFilter] = useState<UnifiedFilter>('all');
  const [composing, setComposing] = useState(false);
  // Session-only preview plans: kept in memory for this screen, never stored on the device or sent anywhere.
  const [drafts, setDrafts] = useState<ScheduleDraft[]>([]);
  const [batches, setBatches] = useState<ScheduleBatch[]>([]);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [retiming, setRetiming] = useState<{ id: string; date: string; time: string } | null>(null);
  // What the user confirmed, post by post (session-only). Validity is recomputed from the current draft on
  // every render, so an edit, time change, re-roll or conflict move invalidates it at once.
  const [confirmations, setConfirmations] = useState<ConfirmationMap>(EMPTY_CONFIRMATIONS);
  const [scopedNotice, setScopedNotice] = useState<{ scope: string | null; tone: 'success' | 'warning' | 'danger'; text: string; button?: ActionButtonKind } | null>(null);
  // The AI plan uses the frequency confirmed in AI consultation (read only; nothing is written from here).
  // The values are bound to the exact brand they were read for: a workspace switch drops them at once, a late
  // answer for a previous brand/load is discarded, and an unreadable brand is labelled instead of inheriting.
  const [aiState, setAiState] = useState<AiSettingsState>(AI_SETTINGS_UNLOADED);
  const loadCounter = useRef(0);
  // Server reservations (only when the store is enabled): the last list read for the selected account, saves in
  // flight or unconfirmed (with their exact request, so a retry re-sends the same idempotency key) and row actions.
  const [serverSnapshot, setServerSnapshot] = useState<ServerListSnapshot | null>(null);
  const serverLoads = useRef(0);
  const [pendingSaves, setPendingSaves] = useState<Record<string, PendingSave>>({});
  const [rowBusy, setRowBusy] = useState<string | null>(null);
  const [rowRetiming, setRowRetiming] = useState<{ id: string; date: string; time: string } | null>(null);
  // One save at a time; an answer for another person / login / account does not reach the screen.
  const xGuard = useXWriteGuard(activeAccount);
  // The saved row whose cancel asked once: the second press is the cancel (as on the reservations screen).
  const [askingCancel, setAskingCancel] = useState<string | null>(null);
  const saving = useRef(false);
  const liveScope = useRef<string | null>(xGuard.scope);
  useEffect(() => { liveScope.current = xGuard.scope; }, [xGuard.scope]);
  // A notice is about the login and account it was shown for: it does not follow the person to another one.
  const notice = scopedNotice && scopedNotice.scope === xGuard.scope ? scopedNotice : null;
  const setNotice = (next: { tone: 'success' | 'warning' | 'danger'; text: string; button?: ActionButtonKind } | null) => setScopedNotice(next && { ...next, scope: liveScope.current });
  useEffect(() => {
    // Not ready / no brand: nothing to load. aiPlanningFor() already returns the unloaded default for any
    // brand the state was not read for, so a previous brand's values are never shown here.
    if (!brandId || !repository) return;
    loadCounter.current += 1;
    const loadId = loadCounter.current;
    setAiState((current) => startAiSettingsLoad(current, brandId, loadId));
    let cancelled = false;
    void repository.read(brandId).then((result) => {
      if (cancelled) return;
      setAiState((current) => applyAiSettingsResult(current, brandId, loadId,
        result.state === 'ready'
          ? { state: 'ready', data: result.updatedAt === null ? null : { frequencyTargetPerWeek: result.data.frequencyTargetPerWeek, approvalMode: result.data.approvalMode } }
          : { state: result.state }));
    });
    return () => {
      cancelled = true;
    };
  }, [brandId, repository]);
  const ai: AiPlanningInput = aiPlanningFor(aiState, brandId);

  /** The list shows its own error; a refusal of the read still decides for this token / account. */
  function applyListResult(answer: Awaited<ReturnType<typeof reservationStore.list>>, account: string, loadId: number, scope: string | null, sentToken: string | null) {
    setServerSnapshot((current) => applyListAnswer(current, account, loadId, answer));
    if (answer.ok) xGuard.unblock(scope);
    else recordRefusal(answer.code, account, scope, sentToken);
  }

  function recordRefusal(code: string, account: string, scope: string | null, sentToken: string | null) {
    const answer = xAnswerView(code, reservationErrorAction);
    // A 401 is about that token and a reconnect has its own signal, which the new connect clears.
    if (answer.action === 'sign_in') xGuard.refuseToken(sentToken);
    else if (answer.action === 'reconnect_x') markXReconnectRequired(account);
    else if (answer.blocks) xGuard.block(scope, { text: answer.text, button: answer.button });
    return answer;
  }

  const accountId = activeAccount?.id ?? null;
  const refocus = useRefocusCount();
  // Every (re)entry of an account -- including an app restart or a return to this tab -- reads its reservations fresh from the server.
  useEffect(() => {
    if (!reservationStore.enabled || !accountId || !xGuard.canRead) return;
    serverLoads.current += 1;
    const loadId = serverLoads.current;
    const scope = xGuard.scope;
    const sentToken = xGuard.token;
    let cancelled = false;
    void reservationStore.list(accountId).then((answer) => {
      if (!cancelled) applyListResult(answer, accountId, loadId, scope, sentToken);
    });
    return () => {
      cancelled = true;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId, reservationStore, xGuard.scope, xGuard.canRead, refocus]);
  const serverList = reservationStore.enabled ? serverListFor(serverSnapshot, accountId) : null;
  const serverRows: ServerReservation[] = serverList?.state === 'ready' ? serverList.rows : [];
  // A "post now" row is not a reservation: its state and its cancel are on the reservations screen.
  const reservationRows = serverRows.filter((row) => !isSendNowRow(row));
  // With the store on, the saved reservations are part of the answer: not read yet or not readable is not "none".
  const serverAnswered = !reservationStore.enabled || serverList?.state === 'ready';
  // Planning is offered for an X account whose own brand is known. In the sample-data preview there is no
  // production brand (and nothing is read), so the demo account's brand -- or 'preview' -- is used.
  // A real account without a known brand cannot plan: the first workspace is never a fallback.
  const ownerBrandId = status === 'mock_preview' ? (activeAccount?.brandId ?? 'preview') : brandId;
  const owner = activeAccount && activeAccount.platform === 'x' && ownerBrandId
    ? { accountId: activeAccount.id, brandId: ownerBrandId, platform: 'x' as const }
    : null;
  // Server rows are read-only. Production rows have no account binding: they are listed as brand-level and
  // never relabelled as the selected account's posts, so only account-bound rows reach the per-account solver.
  const classified = classifyServerPosts({
    rows: view.kind === 'posts' ? view.posts : [],
    accounts: snapshot?.accounts ?? mockRepository.getAccounts(),
    activeAccount: activeAccount ? { id: activeAccount.id, brandId: activeAccount.brandId, platform: activeAccount.platform } : null,
    isPreview: view.kind === 'posts' && view.isPreview,
  });
  const serverPosts = classified.accountBound;
  const everything = buildUnifiedSchedule({ accountId, serverPosts, drafts });
  const items = filter === 'all' ? everything : buildUnifiedSchedule({ accountId, serverPosts, drafts, filter });
  const conflicts = detectConflicts(everything);
  const conflictIds = new Set(conflicts.flatMap((conflict) => [conflict.firstId, conflict.secondId]));
  const myDrafts = drafts.filter((draft) => draft.accountId === accountId && draft.state !== 'cancelled');
  const myBatches = batches.filter((batch) => batch.accountId === accountId && myDrafts.some((draft) => draft.batchId === batch.id));
  // The selected X account is the only posting destination shown or confirmed here.
  const previewAccount = activeAccount ? { displayName: activeAccount.profile.displayName, handle: activeAccount.profile.handle } : null;
  const overall = confirmationProgress(myDrafts, confirmations);
  const occupiedExcept = (batchId?: string) => [
    ...everything.filter((item) => item.source === 'server' || item.draft.batchId !== batchId)
      .map((item) => ({ scheduledAt: item.scheduledAt, fixed: item.source === 'server' || item.draft.fixed })),
    // Saved reservations of this account occupy their slots too (the server enforces the same gap).
    ...serverRows.filter((row) => row.status === 'planned' || row.status === 'claimed').map((row) => ({ scheduledAt: row.scheduledAt, fixed: true })),
  ];

  function reloadServer(account: string) {
    if (!reservationStore.enabled || !xGuard.canRead) return;
    serverLoads.current += 1;
    const loadId = serverLoads.current;
    const scope = xGuard.scope;
    const sentToken = xGuard.token;
    void reservationStore.list(account).then((answer) => applyListResult(answer, account, loadId, scope, sentToken));
  }

  /** A refused write: decided for the token / account whatever is on screen by now; the words and the re-read only if it still is. */
  function applyRefusal(code: string, account: string, scope: string | null, sentToken: string | null) {
    const answer = recordRefusal(code, account, scope, sentToken);
    if (liveScope.current !== scope) return;
    setNotice({ tone: answer.tone, text: answer.text, button: answer.button });
    if (answer.reread) reloadServer(account);
  }

  /** Saves one batch, only on the person's press; '保存済み' is decided by the store's independent read-back, never by the write's answer. */
  async function saveBatch(batch: ScheduleBatch, retry?: SaveRequest) {
    if (!reservationStore.enabled || saving.current) return;
    if (xGuard.refusal) {
      setNotice({ tone: 'danger', text: xGuard.refusal.text, button: xGuard.refusal.button });
      return;
    }
    saving.current = true;
    let request = retry ?? null;
    if (!request) {
      const built = await buildSaveRequest({
        batch, drafts, confirmations: domainConfirmations(confirmations),
        aiOptIn: { source: ai.source, approvalMode: ai.approvalMode }, sha256: sha256Hex,
      });
      if (!built.ok) {
        saving.current = false;
        setNotice({ tone: 'danger', text: built.issues.map((issue) => issue.message).join(' ') });
        return;
      }
      request = built.request;
    }
    const sent = request;
    const scope = xGuard.scope;
    const sentToken = xGuard.token;
    setPendingSaves((current) => ({ ...current, [batch.id]: { request: sent, phase: 'saving' } }));
    let outcome: Awaited<ReturnType<typeof reservationStore.save>>;
    try {
      outcome = await reservationStore.save(sent);
    } catch {
      outcome = { kind: 'uncertain', code: UNCERTAIN_CODE };
    } finally {
      saving.current = false;
    }
    const next = pendingAfter(sent, outcome);
    setPendingSaves((current) => {
      const copy = { ...current };
      if (next) copy[batch.id] = next;
      else delete copy[batch.id];
      return copy;
    });
    if (outcome.kind === 'saved') {
      const savedIds = drafts.filter((draft) => draft.batchId === batch.id).map((draft) => draft.id);
      setDrafts((current) => current.filter((draft) => draft.batchId !== batch.id));
      setBatches((current) => current.filter((candidate) => candidate.id !== batch.id));
      setConfirmations((current) => withoutConfirmations(current, savedIds));
      clearXReconnectRequired(sent.socialAccountId);
      if (liveScope.current !== scope) return;
      setNotice({ tone: 'success', text: `${outcome.reservations.length}件をサーバーに保存し、読み戻して一致を確認しました。X への投稿はまだ行われません。` });
      reloadServer(sent.socialAccountId);
      return;
    }
    if (outcome.kind === 'uncertain') {
      if (liveScope.current !== scope) return;
      setNotice({ tone: 'warning', text: reservationMessage(outcome.code) });
      reloadServer(sent.socialAccountId);
      return;
    }
    applyRefusal(outcome.kind === 'not_available' ? 'NOT_AVAILABLE' : outcome.code, sent.socialAccountId, scope, sentToken);
  }

  /** One change of a saved reservation (CAS on its revision), applied only after the server's read-back. */
  async function changeReservation(row: ServerReservation, kind: 'reschedule' | 'reconfirm' | 'cancel') {
    if (!reservationStore.enabled || !accountId) return;
    // The card no longer offers these; a press already on its way is not sent either.
    if (kind !== 'cancel' && isXRowNotEditable(row.reservationId)) return;
    const refusal = kind === 'cancel' ? xGuard.cancelRefusal : xGuard.refusal;
    if (refusal) {
      setNotice({ tone: 'danger', text: refusal.text, button: refusal.button });
      return;
    }
    const account = accountId;
    const scope = xGuard.scope;
    const sentToken = xGuard.token;
    let iso: string | null = null;
    if (kind === 'reschedule') {
      iso = rowRetiming && rowRetiming.id === row.reservationId ? isoFromJstFields(rowRetiming) : null;
      if (!iso) {
        setNotice({ tone: 'danger', text: '日時が正しくありません（例: 2026-10-15 / 09:30）。' });
        return;
      }
    }
    setRowBusy(row.reservationId);
    const result = kind === 'reschedule'
      ? await reservationStore.reschedule(row.reservationId, row.revision, iso!)
      : kind === 'reconfirm'
        ? await reservationStore.reconfirm(row.reservationId, row.revision, await sha256Hex(row.body ?? ''))
        : await reservationStore.cancel(row.reservationId, row.revision);
    setRowBusy(null);
    if (!result.ok) {
      if (kind !== 'cancel' && isNotEditableCode(result.code)) markXRowNotEditable(row.reservationId);
      // Only a refusal of the new time itself is answered by another time; after any other the editor stays closed.
      if (kind === 'reschedule' && xAnswerView(result.code, reservationErrorAction).action !== 'fix_input') setRowRetiming((current) => (current?.id === row.reservationId ? null : current));
      applyRefusal(result.code, account, scope, sentToken);
      return;
    }
    // A cancel needs no connection, so its success says nothing about one.
    if (kind !== 'cancel') clearXReconnectRequired(account);
    if (liveScope.current !== scope) return;
    setServerSnapshot((current) => replaceRow(current, account, result.value));
    if (kind === 'reschedule') setRowRetiming(null);
    setNotice({
      tone: 'success',
      text: kind === 'cancel'
        ? '予約を取り消しました（サーバーで確認済み）。'
        : kind === 'reconfirm'
          ? '本文・日時・投稿先を再確認しました（サーバーで確認済み）。'
          : result.value.consentState === 'needs_reconfirm'
            ? '日時を変更しました（サーバーで確認済み）。投稿の対象にするには、内容をもう一度確認してください。'
            : '日時を変更しました（サーバーで確認済み）。',
    });
  }

  function reroll(batch: ScheduleBatch) {
    if (!owner) return;
    const result = rerollBatch(batch, { owner, now: new Date(), occupied: occupiedExcept(batch.id) }, drafts);
    if (!result.ok) {
      setNotice({ tone: 'danger', text: result.issues.map((issue) => issue.message).join(' ') });
      return;
    }
    const rerolled = new Map(result.drafts.map((draft) => [draft.id, draft]));
    setDrafts((current) => current.map((draft) => rerolled.get(draft.id) ?? draft));
    setBatches((current) => current.map((candidate) => (candidate.id === batch.id ? result.batch : candidate)));
    setNotice({ tone: 'success', text: `${MODE_LABELS[batch.mode]}の日時を引き直しました（プレビューのみ）。` });
  }

  function resolve() {
    const result = resolveConflicts({ drafts, batches, serverPosts, now: new Date() });
    setDrafts(result.drafts);
    setNotice(result.issues.length
      ? { tone: 'danger', text: result.issues.map((issue) => issue.message).join(' ') }
      : { tone: 'success', text: `${result.moved.length}件の予定を、決めた時間帯の中で動かしました（プレビューのみ）。` });
  }

  function confirm(draftId: string) {
    const target = drafts.find((draft) => draft.id === draftId);
    if (!target) return;
    // Records exactly what the card shows now; an edit made while the hash is computed leaves it invalid.
    void confirmDraft(target, sha256Hex).then((confirmed) => {
      if (!confirmed) return;
      setConfirmations((current) => withConfirmation(current, confirmed));
      // 「確認が無効になりました」 and the like are out of date once the person has confirmed again.
      setNotice(null);
    });
  }

  function cancelPosts(ids: string[]) {
    const drop = new Set(ids);
    setDrafts((current) => current.map((draft) => (drop.has(draft.id) ? cancelDraft(draft) : draft)));
    setConfirmations((current) => withoutConfirmations(current, ids));
    setEditing((current) => (current && drop.has(current.id) ? null : current));
    setRetiming((current) => (current && drop.has(current.id) ? null : current));
  }

  function applyRetime() {
    if (!retiming) return;
    const target = drafts.find((draft) => draft.id === retiming.id);
    if (!target) return;
    const next = retimeFixedDraft(target, { date: retiming.date, time: retiming.time }, new Date());
    if ('code' in next) {
      setNotice({ tone: 'danger', text: next.message });
      return;
    }
    setDrafts((current) => current.map((draft) => (draft.id === next.id ? next : draft)));
    setRetiming(null);
    setNotice({ tone: 'warning', text: '日時を変更しました。この投稿の確認は無効になりました（プレビューのみ）。' });
  }

  function applyEdit() {
    if (!editing) return;
    const target = drafts.find((draft) => draft.id === editing.id);
    if (!target) return;
    const next = editDraftText(target, editing.text);
    if ('code' in next) {
      setNotice({ tone: 'danger', text: next.message });
      return;
    }
    setDrafts((current) => current.map((draft) => (draft.id === next.id ? next : draft)));
    setEditing(null);
  }

  const reconnectedNote = reservationStore.enabled && !xGuard.refusal && reservationRows.length > 0 && xGuard.reconnectedAfterRestart;
  // A failed batch already says it on its own row.
  const batchFailureTexts = myBatches.flatMap((batch) => (pendingSaves[batch.id]?.phase === 'failed' ? [xAnswerView(pendingSaves[batch.id].code ?? '', reservationErrorAction).text] : []));

  return (
    <Screen>
      <ScrollView automaticallyAdjustKeyboardInsets contentContainerStyle={{ gap: 16 }} keyboardShouldPersistTaps="handled">
        <SectionTitle detail="日時が近い順に表示しています">投稿予定</SectionTitle>
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
          {FILTERS.map((item) => (
            <Pressable key={item.key} accessibilityRole="button" accessibilityState={{ selected: filter === item.key }} onPress={() => setFilter(item.key)}
              style={{ borderWidth: 1, borderColor: filter === item.key ? colors.primary : colors.border, backgroundColor: filter === item.key ? colors.primarySoft : colors.surface, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 }}>
              <Text style={{ color: filter === item.key ? colors.primary : colors.ink, fontWeight: filter === item.key ? '800' : '500' }}>{item.label}</Text>
            </Pressable>
          ))}
        </View>

        {composing && owner ? (
          <ScheduleComposer
            context={{ owner, now: new Date(), occupied: occupiedExcept() }}
            ai={ai}
            saveAvailable={reservationStore.enabled}
            onClose={() => setComposing(false)}
            onPlanned={(result) => {
              setDrafts((current) => [...current, ...result.drafts]);
              setBatches((current) => [...current, result.batch]);
              setComposing(false);
              setNotice({ tone: 'success', text: `${result.drafts.length}件のプレビューを作りました。まだ予約されていません。` });
            }}
          />
        ) : (
          <ActionButton label="投稿を作成" onPress={() => { setNotice(null); setComposing(true); }} disabled={!owner} />
        )}
        {!owner ? <Text style={styles.muted}>{activeAccount && activeAccount.platform === 'x' && status !== 'mock_preview'
          ? 'このアカウントのワークスペースを確認できないため、投稿のプレビューは作れません。'
          : 'X のアカウントを選ぶと、投稿のプレビューを作れます。'}</Text> : null}

        {myDrafts.length ? (
          <Card>
            <Pill tone="warning">{PREVIEW_LABEL}</Pill>
            <Text style={styles.muted}>プレビューは、この画面を閉じたりアプリを再起動したりすると消えます（端末にもサーバーにも保存しません）。{reservationStore.enabled ? '予約になるのは「サーバーに保存」のあとです。' : '実際の予約と投稿は、まだ利用できません。'}</Text>
            {overall.manualTotal ? (
              <View style={{ gap: 4 }}>
                <Pill tone={overall.complete ? 'success' : 'warning'}>{`確認済み ${overall.confirmed}/${overall.manualTotal}件`}</Pill>
                <Text style={styles.muted}>
                  {overall.complete
                    ? (reservationStore.enabled
                      ? 'すべての手動投稿の本文・日時・投稿先を確認しました。まとまりごとに「サーバーに保存」できます。'
                      : 'すべての手動投稿の本文・日時・投稿先を確認しました。ただし、予約の保存はまだ利用できません。')
                    : `保存できるようになるには、手動投稿を1件ずつ確認する必要があります（未確認 ${overall.unconfirmed}件${overall.invalidated ? `・変更により確認が無効 ${overall.invalidated}件` : ''}）。`}
                </Text>
              </View>
            ) : null}
            {overall.aiSlots ? (
              <Text style={styles.muted}>AI自動予約の枠は本文がなく、1件ずつの確認はありません。AI相談の「これで覚えて」は自動投稿の同意になりません。</Text>
            ) : null}
            {!reservationStore.enabled ? (
              <View style={{ gap: 4 }}>
                <ActionButton label="予約として保存（準備中）" onPress={() => {}} disabled />
                <Text style={styles.muted}>予約の保存は、利用登録・Xアカウントの本人確認・安全確認の準備が整うまで使えません。押しても何も送信されません。</Text>
              </View>
            ) : null}
            {myBatches.map((batch) => {
              const own = myDrafts.filter((draft) => draft.batchId === batch.id);
              const progress = confirmationProgress(own, confirmations);
              const pending = pendingSaves[batch.id];
              const saveReady = batch.origin === 'ai_generated' ? progress.aiSlots > 0 : progress.complete;
              return (
                <View key={batch.id} style={{ gap: 6 }}>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                    <Text style={{ color: colors.ink }}>{MODE_LABELS[batch.mode]}（{own.length}件）</Text>
                    {progress.manualTotal ? <Pill tone={progress.complete ? 'success' : 'neutral'}>{`確認 ${progress.confirmed}/${progress.manualTotal}`}</Pill> : null}
                    {batch.mode === 'manual_random_batch' || batch.mode === 'ai_flexible' ? <SmallButton label="再抽選" disabled={Boolean(pending)} onPress={() => reroll(batch)} /> : null}
                    <SmallButton label="まとめて取り消し" disabled={Boolean(pending)} onPress={() => cancelPosts(own.map((draft) => draft.id))} />
                  </View>
                  {reservationStore.enabled ? (
                    <View style={{ gap: 4 }}>
                      {pending?.phase === 'uncertain'
                        ? <SmallButton label="保存状況を確認" disabled={xGuard.refusal !== null} onPress={() => void saveBatch(batch, pending.request)} />
                        : <SmallButton label="サーバーに保存" disabled={!saveReady || pending?.phase === 'saving' || xGuard.refusal !== null} onPress={() => void saveBatch(batch)} />}
                      {pending?.phase === 'saving' ? <Text style={styles.muted}>保存して、サーバーから読み戻しています…（まだ確定していません）</Text> : null}
                      {pending?.phase === 'uncertain' ? <Pill tone="warning">保存できたかを確認できません（未確定）。「保存状況を確認」で、同じ内容をもう一度確かめます</Pill> : null}
                      {pending?.phase === 'failed' ? <Pill tone="danger">{xAnswerView(pending.code ?? '', reservationErrorAction).text}</Pill> : null}
                    </View>
                  ) : null}
                </View>
              );
            })}
          </Card>
        ) : null}
        {conflicts.length ? (
          <Card>
            <Pill tone="danger">{`近すぎる予定が${conflicts.length}組あります`}</Pill>
            <Text style={styles.muted}>日時を決めた投稿は動かしません。AI自動予約やまとめてランダムの予定だけを、決めた時間帯の中で動かします。</Text>
            <ActionButton label="競合を解消（プレビュー内）" onPress={resolve} />
          </Card>
        ) : null}
        {notice && !batchFailureTexts.includes(notice.text) ? <Pill tone={notice.tone}>{notice.text}</Pill> : null}
        {reservationStore.enabled && xGuard.refusal && xGuard.refusal.text !== notice?.text && xGuard.refusal.button !== notice?.button ? <Pill tone="warning">{xGuard.refusal.text}</Pill> : null}
        {reservationStore.enabled && !xGuard.refusal && !reconnectedNote ? <Text style={styles.muted}>{CONNECTED_NOT_PROOF_TEXT}</Text> : null}
        {reconnectedNote ? <Pill tone="warning">{RESTART_RECONNECTED_TEXT}</Pill> : null}
        {reservationStore.enabled ? (notice?.button ?? xGuard.refusal?.button) === 'accounts'
          ? <ActionButton label="アカウント画面を開く" onPress={() => router.push('/accounts')} />
          : (notice?.button ?? xGuard.refusal?.button) === 'settings'
            ? <ActionButton label="設定画面を開く" onPress={() => router.push('/(tabs)/settings')} />
            : null : null}
        {reservationStore.enabled && !xGuard.canRead ? <SignOutButton /> : null}
        <ActionButton label="予約の管理を開く" onPress={() => router.push('/reservations')} />

        {serverList && accountId ? (
          <View style={{ gap: 8 }}>
            <Text style={{ color: colors.ink, fontWeight: '800' }}>サーバーに保存された予約（このアカウント）</Text>
            <Text style={styles.muted}>サーバーから読み戻して確かめた予約だけを表示します。プレビューとは別です。X への投稿はまだ行われません。</Text>
            {serverList.state === 'loading' ? <Text style={styles.muted}>サーバーの予約を読み込み中…</Text> : null}
            {serverList.state === 'error' ? (
              <View style={{ gap: 4 }}>
                <Pill tone="danger">{`サーバーの予約を読み込めませんでした。${reservationMessage(serverList.code)}`}</Pill>
                <SmallButton label="読み込み直す" onPress={() => { setNotice(null); reloadServer(accountId); }} />
              </View>
            ) : null}
            {serverList.state === 'ready' && !serverList.rows.length ? <Text style={styles.muted}>まだありません。</Text> : null}
            {serverRows.length > reservationRows.length ? <Text style={styles.muted}>{`即時投稿が${serverRows.length - reservationRows.length}件あります。「予約の管理」で確認できます。`}</Text> : null}
            {reservationRows.map((row) => (
              <ServerReservationCard key={row.reservationId} row={row} account={previewAccount} busy={rowBusy === row.reservationId}
                retiming={rowRetiming?.id === row.reservationId ? { date: rowRetiming.date, time: rowRetiming.time } : null}
                onRetime={() => setRowRetiming({ id: row.reservationId, ...jstFieldsOf(row.scheduledAt) })}
                onRetimeChange={(patch) => setRowRetiming((current) => (current && current.id === row.reservationId ? { ...current, ...patch } : current))}
                onRetimeApply={() => void changeReservation(row, 'reschedule')}
                onRetimeCancel={() => setRowRetiming(null)}
                onReconfirm={() => void changeReservation(row, 'reconfirm')}
                confirmingCancel={askingCancel === row.reservationId}
                notEditable={isXRowNotEditable(row.reservationId) ? { label: NOT_EDITABLE_LABEL, text: NOT_EDITABLE_TEXT } : null}
                canEdit={!xGuard.refusal}
                onCancel={() => {
                  if (askingCancel !== row.reservationId) { setAskingCancel(row.reservationId); return; }
                  setAskingCancel(null);
                  void changeReservation(row, 'cancel');
                }} />
            ))}
          </View>
        ) : null}

        {view.kind === 'loading' ? (
          <Text style={styles.muted}>読み込み中…</Text>
        ) : view.kind === 'unavailable' ? (
          <EmptyState title="投稿予定を確認できません" detail={view.reason ?? '時間をおいて再度お試しください。'} />
        ) : null}
        {classified.brandLevel.length || classified.unattributable.length ? (
          <View style={{ gap: 8 }}>
            <Text style={{ color: colors.ink, fontWeight: '800' }}>投稿先アカウント未特定／ブランド単位</Text>
            <Text style={styles.muted}>この予定は、どのアカウントから投稿されるかがまだ記録されていません。選択中のアカウントの投稿としては扱わず、競合の確認にも使いません。</Text>
            {classified.brandLevel.map((post) => (
              <BrandLevelCard key={post.id} post={post} />
            ))}
            {classified.unattributable.length ? <Pill tone="warning">{`ブランドを確認できない予定が${classified.unattributable.length}件あります`}</Pill> : null}
          </View>
        ) : null}
        {view.kind !== 'loading' && items.length
          ? items.map((item) => (item.source === 'server'
            ? <ServerCard key={item.id} item={item} />
            : <PreviewCard key={item.id} draft={item.draft} account={previewAccount} conflict={conflictIds.has(item.id)}
                confirmation={confirmationStatus(item.draft, confirmations)}
                editing={editing?.id === item.id ? editing.text : null}
                retiming={retiming?.id === item.id ? { date: retiming.date, time: retiming.time } : null}
                onEdit={() => { setRetiming(null); setEditing({ id: item.id, text: item.draft.text }); }}
                onEditChange={(text) => setEditing({ id: item.id, text })}
                onEditApply={applyEdit} onEditCancel={() => setEditing(null)}
                onRetime={() => { setEditing(null); setRetiming({ id: item.id, ...jstFieldsOf(item.draft.scheduledAt) }); }}
                onRetimeChange={(patch) => setRetiming((current) => (current && current.id === item.id ? { ...current, ...patch } : current))}
                onRetimeApply={applyRetime} onRetimeCancel={() => setRetiming(null)}
                onMove={(direction) => setDrafts((current) => moveDraftText(current, item.id, direction))}
                onCancel={() => cancelPosts([item.id])}
                onConfirm={() => confirm(item.id)}
                onUnconfirm={() => setConfirmations((current) => withoutConfirmations(current, [item.id]))} />))
          : view.kind === 'posts' && serverAnswered && !reservationRows.length && !classified.brandLevel.length && !classified.unattributable.length
            ? <EmptyState title="投稿予定はありません" detail="「投稿を作成」から、プレビューを作れます。" /> : null}
      </ScrollView>
    </Screen>
  );
}

function ServerCard({ item }: { item: Extract<UnifiedItem, { source: 'server' }> }) {
  const router = useRouter();
  const status = statusLabels[item.status as PostStatus] ?? statusLabels.scheduled;
  return (
    <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: '/posts/[id]', params: { id: item.id } })} style={({ pressed }) => pressed && styles.buttonPressed}>
      <Card>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={{ color: colors.ink, fontWeight: '800' }}>{formatJst(item.scheduledAt)}</Text>
          <Pill tone={status.tone}>{status.label}</Pill>
        </View>
        <Text style={{ color: colors.ink }}>{item.text || '（本文は投稿の確認画面で表示されます）'}</Text>
        <Text style={styles.muted}>{item.origin === 'other' ? '予定' : originLabels[item.origin]} ・ 実投稿は次フェーズ</Text>
      </Card>
    </Pressable>
  );
}

function BrandLevelCard({ post }: { post: { id: string; scheduledAt: string; status: string; text: string } }) {
  const router = useRouter();
  const status = statusLabels[post.status as PostStatus] ?? statusLabels.scheduled;
  return (
    <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: '/posts/[id]', params: { id: post.id } })} style={({ pressed }) => pressed && styles.buttonPressed}>
      <Card style={{ borderStyle: 'dotted' }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
          <Text style={{ color: colors.ink, fontWeight: '800' }}>{formatJst(post.scheduledAt)}</Text>
          <Pill tone={status.tone}>{status.label}</Pill>
        </View>
        <Text style={{ color: colors.ink }}>{post.text || '（本文は投稿の確認画面で表示されます）'}</Text>
        <Text style={styles.muted}>投稿先アカウント未特定 ・ ブランド単位 ・ 実投稿は次フェーズ</Text>
      </Card>
    </Pressable>
  );
}
