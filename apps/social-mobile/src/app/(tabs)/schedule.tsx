import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { mockRepository } from '@/data/mock-repository';
import { SupabaseContentSettingsRepository } from '@/data/content-settings-repository';
import { supabase } from '@/lib/supabase';
import { colors } from '@/constants/theme';
import { ActionButton, Card, EmptyState, Pill, Screen, SectionTitle, styles } from '@/components/ui';
import { resolvePostsView } from '@/domain/data-view';
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
import { createReservationStore } from '@/features/schedule/reservation-store';
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
  const { activeAccount } = useActiveAccount();
  const { status, reason, snapshot } = useDataStatus();
  const mockPosts = mockRepository.getPlannedPosts().filter((post) => post.accountId === activeAccount?.id);
  const view = resolvePostsView(status, reason, snapshot?.plannedPosts, mockPosts);
  // The brand the whole screen plans for is the SELECTED account's brand -- never the snapshot's first
  // workspace, which may belong to a different brand than the account the user picked.
  const brandId = effectiveBrandId({ status, activeAccount });
  const repository = useMemo(() => (supabase ? new SupabaseContentSettingsRepository(supabase) : null), []);

  // Release gate OFF: this is the disabled store; nothing is ever sent from this screen.
  const reservationStore = useMemo(() => createReservationStore(), []);
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
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning' | 'danger'; text: string } | null>(null);
  // The AI plan uses the frequency confirmed in AI consultation (read only; nothing is written from here).
  // The values are bound to the exact brand they were read for: a workspace switch drops them at once, a late
  // answer for a previous brand/load is discarded, and an unreadable brand is labelled instead of inheriting.
  const [aiState, setAiState] = useState<AiSettingsState>(AI_SETTINGS_UNLOADED);
  const loadCounter = useRef(0);
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

  const accountId = activeAccount?.id ?? null;
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
  const occupiedExcept = (batchId?: string) => everything.filter((item) => item.source === 'server' || item.draft.batchId !== batchId)
    .map((item) => ({ scheduledAt: item.scheduledAt, fixed: item.source === 'server' || item.draft.fixed }));

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
      if (confirmed) setConfirmations((current) => withConfirmation(current, confirmed));
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

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: 16 }} keyboardShouldPersistTaps="handled">
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
            <Text style={styles.muted}>プレビューは、この画面を閉じたりアプリを再起動したりすると消えます（端末にもサーバーにも保存しません）。実際の予約と投稿は、まだ利用できません。</Text>
            {overall.manualTotal ? (
              <View style={{ gap: 4 }}>
                <Pill tone={overall.complete ? 'success' : 'warning'}>{`確認済み ${overall.confirmed}/${overall.manualTotal}件`}</Pill>
                <Text style={styles.muted}>
                  {overall.complete
                    ? 'すべての手動投稿の本文・日時・投稿先を確認しました。ただし、予約の保存はまだ利用できません。'
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
              return (
                <View key={batch.id} style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                  <Text style={{ color: colors.ink }}>{MODE_LABELS[batch.mode]}（{own.length}件）</Text>
                  {progress.manualTotal ? <Pill tone={progress.complete ? 'success' : 'neutral'}>{`確認 ${progress.confirmed}/${progress.manualTotal}`}</Pill> : null}
                  {batch.mode === 'manual_random_batch' || batch.mode === 'ai_flexible' ? <SmallButton label="再抽選" onPress={() => reroll(batch)} /> : null}
                  <SmallButton label="まとめて取り消し" onPress={() => cancelPosts(own.map((draft) => draft.id))} />
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
        {notice ? <Pill tone={notice.tone}>{notice.text}</Pill> : null}

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
          : view.kind === 'posts' ? <EmptyState title="投稿予定はありません" detail="「投稿を作成」から、プレビューを作れます。" /> : null}
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
