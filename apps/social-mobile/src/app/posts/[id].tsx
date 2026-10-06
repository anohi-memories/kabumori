import { Link, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ScrollView, Text } from 'react-native';
import { mockRepository } from '@/data/mock-repository';
import { SupabaseContentSettingsRepository } from '@/data/content-settings-repository';
import { supabase } from '@/lib/supabase';
import { colors } from '@/constants/theme';
import { ActionButton, Card, Pill, Screen, SectionTitle, styles } from '@/components/ui';
import { SOCIAL_MOBILE_CONTENT_DEFAULTS, type SocialMobileContentSettings } from '@/domain/content-settings';
import {
  approveAvailability,
  editAvailability,
  failureReasonText,
  hasXReconnectNeeded,
  regenerateAvailability,
  retryAvailability,
  summarizePostingMode,
  type ActionAvailability,
} from '@/domain/post-interaction';
import type { PostStatus } from '@/domain/types';
import { useActiveAccount } from '@/providers/active-account-provider';
import { useDataStatus } from '@/providers/data-provider';

const statusLabels: Record<PostStatus, { label: string; tone: 'neutral' | 'success' | 'warning' | 'danger' }> = {
  draft: { label: '下書き', tone: 'neutral' },
  scheduled: { label: '投稿待ち', tone: 'warning' },
  publishing: { label: '投稿中', tone: 'warning' },
  published: { label: '投稿済み', tone: 'success' },
  failed: { label: '失敗', tone: 'danger' },
};

function unavailableReason(availability: ActionAvailability): string {
  return availability.available ? '' : availability.reason;
}

// A disabled action still explains itself, rather than only greying out --
// none of edit/regenerate/approve/retry has a client-callable backend
// contract yet; see the Phase 2 report for the exact gap behind each.
function UnavailableAction({ label, reason }: { label: string; reason: string }) {
  return (
    <>
      <ActionButton label={label} onPress={() => {}} disabled />
      <Text style={styles.muted}>{reason}</Text>
    </>
  );
}

export default function PostDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { status, snapshot } = useDataStatus();
  const { accounts, activeAccount } = useActiveAccount();

  const brandId = snapshot?.workspace?.id;
  const repository = useMemo(() => (supabase ? new SupabaseContentSettingsRepository(supabase) : null), []);
  const [realContentSettings, setRealContentSettings] = useState<SocialMobileContentSettings | null>(null);

  useEffect(() => {
    if (status !== 'ready' || !brandId || !repository) return;
    let cancelled = false;
    void repository.read(brandId).then((result) => {
      if (!cancelled && result.state === 'ready') setRealContentSettings(result.data);
    });
    return () => {
      cancelled = true;
    };
  }, [brandId, repository, status]);

  if (status === 'loading') {
    return (
      <Screen>
        <Card>
          <Text style={styles.muted}>読み込み中…</Text>
        </Card>
      </Screen>
    );
  }

  // `history` already carries every post (published/failed and still
  // pending), so it doubles as the full lookup source; see
  // supabase-repository.ts and mock-repository.ts.
  const source = status === 'ready' && snapshot ? snapshot.history : status === 'mock_preview' ? mockRepository.getHistory() : null;
  const post = source?.find((item) => item.id === id) ?? null;

  if (!post) {
    return (
      <Screen>
        <Card>
          <Text style={{ color: colors.ink, fontWeight: '800' }}>投稿が見つかりません</Text>
          <Text style={styles.muted}>
            {source === null ? '運用データを確認できないため表示できません。' : '一覧からもう一度選択してください。'}
          </Text>
        </Card>
      </Screen>
    );
  }

  const statusInfo = statusLabels[post.status];
  const failureReason = failureReasonText(post.status);
  // Mock preview has no real fetch to wait on, so it always shows the demo
  // defaults; a real connection shows null until the read resolves.
  const contentSettings = status === 'mock_preview' ? SOCIAL_MOBILE_CONTENT_DEFAULTS : realContentSettings;
  const mode = summarizePostingMode(activeAccount, contentSettings);
  const needsReconnect = hasXReconnectNeeded(accounts);

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: 16 }}>
        <SectionTitle detail={new Date(post.scheduledAt).toLocaleString('ja-JP')}>投稿詳細</SectionTitle>

        <Card>
          <Pill tone={statusInfo.tone}>{statusInfo.label}</Pill>
          <Text selectable style={{ color: colors.ink, fontSize: 16, lineHeight: 25 }}>
            {post.text || '（本文はまだ取得できません）'}
          </Text>
          {failureReason ? <Text style={{ color: colors.danger }}>失敗理由: {failureReason}</Text> : null}
        </Card>

        <Card>
          <SectionTitle detail="この投稿が従う自動化の設定">投稿モード</SectionTitle>
          <Pill tone={mode.autoPostEnabled ? 'success' : mode.autoPostEnabled === false ? 'neutral' : 'warning'}>
            自動投稿: {mode.autoPostEnabled === null ? '不明（アカウント未選択）' : mode.autoPostEnabled ? 'ON（稼働中）' : 'OFF（停止中）'}
          </Pill>
          <Pill tone={mode.approvalMode === null ? 'warning' : 'neutral'}>
            承認: {mode.approvalMode === null ? '確認できません' : mode.approvalMode === 'manual_review' ? '手動確認が必要' : '自動投稿を許可'}
          </Pill>
          <Text style={styles.muted}>承認して投稿することと、自動投稿がONであることは別の設定です。</Text>
        </Card>

        {needsReconnect ? (
          <Card style={{ backgroundColor: colors.warningSoft, borderColor: '#FDE68A' }}>
            <Text style={{ color: colors.warning, fontWeight: '800' }}>Xとの接続を確認できません</Text>
            <Text style={styles.muted}>投稿を続けるには、Xアカウントの再接続が必要です。</Text>
            <Link href="/accounts" asChild>
              <ActionButton label="アカウント画面で再接続する" onPress={() => {}} />
            </Link>
          </Card>
        ) : null}

        <Card>
          <SectionTitle detail="この画面ではまだ操作できません">本文を編集</SectionTitle>
          <UnavailableAction label="編集する" reason={unavailableReason(editAvailability())} />
        </Card>

        <Card>
          <SectionTitle>AIで再生成</SectionTitle>
          <UnavailableAction label="再生成する" reason={unavailableReason(regenerateAvailability())} />
        </Card>

        <Card>
          <SectionTitle>承認・投稿予定への追加</SectionTitle>
          <UnavailableAction label="承認する" reason={unavailableReason(approveAvailability())} />
        </Card>

        {post.status === 'failed' ? (
          <Card>
            <SectionTitle>再試行</SectionTitle>
            <UnavailableAction label="再試行する" reason={unavailableReason(retryAvailability(post.status))} />
          </Card>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
