import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
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
  type ScheduleMode,
  type UnifiedFilter,
  type UnifiedItem,
} from '@/domain/schedule-planner';
import type { PostOrigin, PostStatus } from '@/domain/types';
import { ScheduleComposer, SmallButton, type AiPlanningInput } from '@/features/schedule/schedule-composer';
import { useActiveAccount } from '@/providers/active-account-provider';
import { useDataStatus } from '@/providers/data-provider';

const originLabels: Record<PostOrigin, string> = { ai_generated: 'AI生成', user_authored: 'ユーザー作成', fixed: '固定', manual: '手動' };
const statusLabels: Record<PostStatus, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' }> = { draft: { label: '下書き', tone: 'neutral' }, scheduled: { label: '投稿待ち', tone: 'warning' }, publishing: { label: '投稿中', tone: 'warning' }, published: { label: '投稿済み', tone: 'success' }, failed: { label: '失敗', tone: 'danger' } };
const modeLabels: Record<ScheduleMode, string> = { manual_exact: '指定日時', manual_random_batch: 'まとめてランダム', manual_interval: '間隔指定', ai_flexible: 'AI自動予約' };
const FILTERS: { key: UnifiedFilter; label: string }[] = [{ key: 'all', label: 'すべて' }, { key: 'ai', label: 'AI自動投稿' }, { key: 'manual', label: '手動予約' }];
const PREVIEW_LABEL = 'プレビュー／未予約・投稿されません';

export default function ScheduleScreen() {
  const { activeAccount } = useActiveAccount();
  const { status, reason, snapshot } = useDataStatus();
  const mockPosts = mockRepository.getPlannedPosts().filter((post) => post.accountId === activeAccount?.id);
  const view = resolvePostsView(status, reason, snapshot?.plannedPosts, mockPosts);
  const brandId = snapshot?.workspace?.id;
  const repository = useMemo(() => (supabase ? new SupabaseContentSettingsRepository(supabase) : null), []);

  const [filter, setFilter] = useState<UnifiedFilter>('all');
  const [composing, setComposing] = useState(false);
  // Session-only preview plans: kept in memory for this screen, never stored on the device or sent anywhere.
  const [drafts, setDrafts] = useState<ScheduleDraft[]>([]);
  const [batches, setBatches] = useState<ScheduleBatch[]>([]);
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning' | 'danger'; text: string } | null>(null);
  // The AI plan uses the frequency confirmed in AI consultation (read only; nothing is written from here).
  // The values are bound to the exact brand they were read for: a workspace switch drops them at once, a late
  // answer for a previous brand/load is discarded, and an unreadable brand is labelled instead of inheriting.
  const [aiState, setAiState] = useState<AiSettingsState>(AI_SETTINGS_UNLOADED);
  const loadCounter = useRef(0);
  useEffect(() => {
    // Not ready / no brand: nothing to load. aiPlanningFor() already returns the unloaded default for any
    // brand the state was not read for, so a previous brand's values are never shown here.
    if (status !== 'ready' || !brandId || !repository) return;
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
  }, [brandId, repository, status]);
  const ai: AiPlanningInput = aiPlanningFor(aiState, brandId);

  const accountId = activeAccount?.id ?? null;
  const owner = activeAccount && activeAccount.platform === 'x' ? { accountId: activeAccount.id, brandId: activeAccount.brandId ?? brandId ?? 'preview', platform: 'x' as const } : null;
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
    setNotice({ tone: 'success', text: `${modeLabels[batch.mode]}の日時を引き直しました（プレビューのみ）。` });
  }

  function resolve() {
    const result = resolveConflicts({ drafts, batches, serverPosts, now: new Date() });
    setDrafts(result.drafts);
    setNotice(result.issues.length
      ? { tone: 'danger', text: result.issues.map((issue) => issue.message).join(' ') }
      : { tone: 'success', text: `${result.moved.length}件の予定を、決めた時間帯の中で動かしました（プレビューのみ）。` });
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
        {!owner ? <Text style={styles.muted}>X のアカウントを選ぶと、投稿のプレビューを作れます。</Text> : null}

        {myDrafts.length ? (
          <Card>
            <Pill tone="warning">{PREVIEW_LABEL}</Pill>
            <Text style={styles.muted}>プレビューは、この画面を閉じたりアプリを再起動したりすると消えます（端末にもサーバーにも保存しません）。実際の予約と投稿は、まだ利用できません。</Text>
            {myBatches.map((batch) => (
              <View key={batch.id} style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
                <Text style={{ color: colors.ink }}>{modeLabels[batch.mode]}（{myDrafts.filter((draft) => draft.batchId === batch.id).length}件）</Text>
                {batch.mode === 'manual_random_batch' || batch.mode === 'ai_flexible' ? <SmallButton label="再抽選" onPress={() => reroll(batch)} /> : null}
                <SmallButton label="まとめて取り消し" onPress={() => setDrafts((current) => current.map((draft) => (draft.batchId === batch.id ? cancelDraft(draft) : draft)))} />
              </View>
            ))}
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
            : <PreviewCard key={item.id} item={item} conflict={conflictIds.has(item.id)} editing={editing?.id === item.id ? editing.text : null}
                onEdit={() => setEditing({ id: item.id, text: item.draft.text })} onEditChange={(text) => setEditing({ id: item.id, text })}
                onEditApply={applyEdit} onEditCancel={() => setEditing(null)}
                onMove={(direction) => setDrafts((current) => moveDraftText(current, item.id, direction))}
                onCancel={() => setDrafts((current) => current.map((draft) => (draft.id === item.id ? cancelDraft(draft) : draft)))} />))
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

function PreviewCard({ item, conflict, editing, onEdit, onEditChange, onEditApply, onEditCancel, onMove, onCancel }: {
  item: Extract<UnifiedItem, { source: 'local_preview' }>;
  conflict: boolean;
  editing: string | null;
  onEdit: () => void;
  onEditChange: (text: string) => void;
  onEditApply: () => void;
  onEditCancel: () => void;
  onMove: (direction: -1 | 1) => void;
  onCancel: () => void;
}) {
  const draft = item.draft;
  const manual = draft.origin === 'user_authored';
  return (
    <Card style={{ borderStyle: 'dashed', borderColor: conflict ? colors.danger : colors.border }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Text style={{ color: colors.ink, fontWeight: '800' }}>{formatJst(draft.scheduledAt)}{draft.fixed ? '（日時指定）' : ''}</Text>
        <Pill tone="neutral">{PREVIEW_LABEL}</Pill>
      </View>
      {editing !== null ? (
        <View style={{ gap: 6 }}>
          <TextInput accessibilityLabel="本文を編集" value={editing} onChangeText={onEditChange} multiline style={{ borderColor: colors.border, borderWidth: 1, borderRadius: 8, padding: 8, color: colors.ink, backgroundColor: '#FFFFFF', minHeight: 64 }} />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <SmallButton label="反映" onPress={onEditApply} />
            <SmallButton label="やめる" onPress={onEditCancel} />
          </View>
        </View>
      ) : (
        <Text style={{ color: colors.ink }}>{manual ? draft.text : 'AIが投稿の直前に本文を作成します'}</Text>
      )}
      <Text style={styles.muted}>
        {manual ? `手動予約・${modeLabels[draft.mode]}` : 'AI自動投稿'}
        {!manual ? (draft.aiAutoPostConsent === 'granted_by_owner_setting' ? ' ・ 自動投稿の同意: 設定で選択済み' : ' ・ 自動投稿の同意なし') : ''}
        {conflict ? ' ・ 近い予定があります' : ''}
      </Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {manual && editing === null ? <SmallButton label="編集" onPress={onEdit} /> : null}
        {manual ? <SmallButton label="↑" onPress={() => onMove(-1)} /> : null}
        {manual ? <SmallButton label="↓" onPress={() => onMove(1)} /> : null}
        <SmallButton label="取り消し" onPress={onCancel} />
      </View>
    </Card>
  );
}
