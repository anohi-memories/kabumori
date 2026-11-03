import { Link } from 'expo-router';
import { ScrollView, Text, View } from 'react-native';
import { mockRepository } from '@/data/mock-repository';
import { colors, typography } from '@/constants/theme';
import { ActionButton, Card, EmptyState, Pill, Screen, SectionTitle, styles } from '@/components/ui';
import { BrandPostPreview } from '@/features/brand-preview/brand-post-preview';
import { HOME_NEEDS_CHECK_TEXT, HOME_RESERVATION_NOTE, homeCount, homeHasNoReservations, homeHeadline } from '@/features/reservations/home-reservations';
import { useHomeReservations } from '@/features/reservations/use-home-reservations';
import { isXReconnectRequired, isXServiceRestarted, useXReconnectSignal } from '@/features/reservations/x-reconnect-signal';
import { rowGenerationNote } from '@/features/reservations/x-row-generation';
import { connectionPill, restartAppliesTo, X_CONNECTION_UNVERIFIED_TEXT, X_NOT_CONNECTED_HOME_TEXT } from '@/features/reservations/x-write-view';
import { resolvePostsView, statusHeadline, summarizeHome } from '@/domain/data-view';
import { usePersonalWorkspace } from '@/features/personal-workspace/personal-workspace-provider';
import { useActiveAccount } from '@/providers/active-account-provider';
import { useAuth } from '@/providers/auth-provider';
import { useDataStatus } from '@/providers/data-provider';
import { SignOutButton } from '@/components/sign-out-button';

function formatTime(iso: string) {
  return new Date(iso).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function HomeScreen() {
  const { activeAccount } = useActiveAccount();
  const { status, reason, snapshot } = useDataStatus();
  useXReconnectSignal();
  const { session } = useAuth();
  const { view: personal } = usePersonalWorkspace();
  const connection = connectionPill(activeAccount?.connectionStatus ?? '', activeAccount?.platform === 'x' && isXReconnectRequired(activeAccount.id), '要確認', activeAccount != null && isXServiceRestarted(session?.user?.id) && restartAppliesTo(activeAccount, personal.kind === 'ready' ? personal.workspaceId : null), status === 'mock_preview' ? 'preview' : activeAccount?.platform);
  const headline = homeHeadline(statusHeadline(status), connection.tone);
  const { view: reservations, reload: reloadReservations } = useHomeReservations(activeAccount, status);

  // Mock data is filtered to the selected demo account so switching accounts
  // still demonstrates the per-account view; real scheduled_posts rows have
  // no account attribution yet (see supabase-repository.ts), so a `ready`
  // connection shows the workspace's posts as-is rather than hiding them
  // behind a filter that could never match.
  const mockPosts = mockRepository.getPlannedPosts().filter((post) => post.accountId === activeAccount?.id);
  const mockHistory = mockRepository.getHistory().filter((post) => post.accountId === activeAccount?.id);
  const postsView = resolvePostsView(status, reason, snapshot?.plannedPosts, mockPosts);
  const historyView = resolvePostsView(status, reason, snapshot?.history, mockHistory);

  const workspace = status === 'mock_preview' ? mockRepository.getWorkspace() : snapshot?.workspace ?? null;
  const summary = summarizeHome({
    account: activeAccount,
    posts: postsView.kind === 'posts' ? postsView.posts : [],
    history: historyView.kind === 'posts' ? historyView.posts : [],
    now: new Date(),
  });
  const upcomingCount = homeCount(postsView.kind === 'posts' ? summary.pendingCount : null, reservations, 'upcomingCount');
  const attentionCount = homeCount(historyView.kind === 'posts' ? summary.attentionCount : null, reservations, 'attentionCount');
  const nextReservation = reservations.kind === 'ready' ? reservations.next : null;
  // The two sources are separate tables: whichever comes first is the next one.
  const nextIsReservation = nextReservation !== null && (!summary.nextPost || nextReservation.scheduledAt < summary.nextPost.scheduledAt);

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: 16 }} showsVerticalScrollIndicator={false}>
        <View style={{ gap: 6 }}>
          <Text style={typography.caption}>{workspace?.name ?? 'ワークスペース未取得'}</Text>
          <Text style={typography.title}>おはようございます</Text>
          <Text style={{ color: colors.muted, ...typography.body }}>AI運用担当者と、今日の発信を整えましょう。</Text>
        </View>

        {status !== 'mock_preview' && activeAccount?.platform === 'x' && connection.tone === 'warning' ? (
          <Card>
            <Pill tone="warning">{activeAccount.connectionStatus === 'connected' && !isXReconnectRequired(activeAccount.id) && !(isXServiceRestarted(session?.user?.id) && restartAppliesTo(activeAccount, personal.kind === 'ready' ? personal.workspaceId : null)) ? X_CONNECTION_UNVERIFIED_TEXT : X_NOT_CONNECTED_HOME_TEXT}</Pill>
            <Link href="/reservations" asChild><ActionButton label="予約の管理を開く" onPress={() => {}} /></Link>
            <Link href="/accounts" asChild><ActionButton label="アカウント画面を開く" onPress={() => {}} /></Link>
          </Card>
        ) : null}
        {status !== 'mock_preview' ? (
          <Card
            style={{
              backgroundColor: headline.tone === 'ready' ? colors.successSoft : headline.tone === 'attention' ? colors.dangerSoft : colors.warningSoft,
              borderColor: headline.tone === 'ready' ? '#BBF7D0' : headline.tone === 'attention' ? '#FECACA' : '#FDE68A',
            }}
          >
            <Text style={{ color: headline.tone === 'ready' ? colors.success : headline.tone === 'attention' ? colors.danger : colors.warning, fontWeight: '800' }}>
              {headline.label}
            </Text>
            {reason ? <Text style={{ color: colors.muted }}>{reason}</Text> : null}
          </Card>
        ) : null}

        <Card>
          <SectionTitle detail="自動投稿の状態と、選択中のアカウント">運用アカウント</SectionTitle>
          {activeAccount ? (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <View style={{ width: 42, height: 42, borderRadius: 21, backgroundColor: activeAccount.profile.avatarColor }} />
                <View style={{ flex: 1 }}>
                  <Text style={{ fontWeight: '700', color: colors.ink }}>{activeAccount.profile.displayName}</Text>
                  <Text style={{ color: colors.muted }}>{activeAccount.profile.handle}</Text>
                </View>
                <Pill tone={connection.tone}>{connection.label}</Pill>
              </View>
              <Pill tone={summary.autoPostEnabled ? (activeAccount.platform === 'x' && status !== 'mock_preview' ? 'warning' : 'success') : 'neutral'}>
                自動投稿: {summary.autoPostEnabled ? (activeAccount.platform === 'x' && status !== 'mock_preview' ? '設定はON（投稿可否は未確認）' : 'ON（稼働中）') : 'OFF（停止中）'}
              </Pill>
            </>
          ) : (
            <Text style={styles.muted}>アカウントを選択してください。</Text>
          )}
          <Link href="/accounts" asChild>
            <ActionButton label="アカウントを切り替える" onPress={() => {}} />
          </Link>
        </Card>

        <Card>
          <SectionTitle detail="入力 → プレビュー → 送信前の確認 の順に進みます">手入力でXに投稿</SectionTitle>
          <Text style={styles.muted}>送信は、接続・利用権・投稿許可をサーバーで確認できたときだけ有効になります。</Text>
          <Link href="/manual-publish" asChild>
            <ActionButton label="投稿を作成する" onPress={() => {}} />
          </Link>
        </Card>

        <Card>
          <SectionTitle detail="次の予定（投稿を保証するものではありません）">次回の投稿予定</SectionTitle>
          {postsView.kind === 'loading' ? (
            <Text style={styles.muted}>読み込み中…</Text>
          ) : postsView.kind === 'unavailable' ? (
            <Text style={styles.muted}>{postsView.reason ?? '投稿予定を確認できません。'}</Text>
          ) : reservations.kind === 'loading' ? (
            <Text style={styles.muted}>読み込み中…</Text>
          ) : reservations.kind === 'no_access' ? (
            <Text style={styles.muted}>{reservations.text}</Text>
          ) : reservations.kind === 'error' ? (
            <>
              <Text style={styles.muted}>{reservations.text}</Text>
              <ActionButton label="もう一度読み込む" onPress={reloadReservations} />
            </>
          ) : nextIsReservation ? (
            <View style={{ gap: 4 }}>
              <Text style={{ color: colors.ink, fontWeight: '800' }}>{formatTime(nextReservation.scheduledAt)}</Text>
              <Text style={{ color: colors.ink }}>{nextReservation.body ?? ''}</Text>
              <Text style={styles.muted}>{HOME_RESERVATION_NOTE}</Text>
              {rowGenerationNote(nextReservation, false) ? <Text style={styles.muted}>{rowGenerationNote(nextReservation, false)}</Text> : null}
            </View>
          ) : summary.nextPost ? (
            <View style={{ gap: 4 }}>
              <Text style={{ color: colors.ink, fontWeight: '800' }}>{formatTime(summary.nextPost.scheduledAt)}</Text>
              <Text style={{ color: colors.ink }}>{summary.nextPost.text || '（本文は投稿予定の確認画面で表示されます）'}</Text>
            </View>
          ) : reservations.kind === 'ready' && reservations.upcomingCount + reservations.attentionCount > 0 ? (
            <Text style={styles.muted}>{HOME_NEEDS_CHECK_TEXT}</Text>
          ) : (
            <Text style={styles.muted}>予定されている投稿はありません。</Text>
          )}
          <Link href="/(tabs)/schedule" asChild>
            <ActionButton label="投稿予定を見る" onPress={() => {}} />
          </Link>
          <Link href="/reservations" asChild>
            <ActionButton label="X・Threadsの予約を管理" onPress={() => {}} />
          </Link>
        </Card>

        <Card>
          <SectionTitle detail="直近の投稿結果">最新の投稿結果</SectionTitle>
          {historyView.kind === 'loading' ? (
            <Text style={styles.muted}>読み込み中…</Text>
          ) : historyView.kind === 'unavailable' ? (
            <Text style={styles.muted}>{historyView.reason ?? '投稿結果を確認できません。'}</Text>
          ) : summary.latestResult ? (
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Text style={{ color: colors.ink }}>{formatTime(summary.latestResult.scheduledAt)}</Text>
              <Pill tone={summary.latestResult.status === 'published' ? 'success' : 'danger'}>
                {summary.latestResult.status === 'published' ? '投稿成功' : '失敗'}
              </Pill>
            </View>
          ) : (
            <Text style={styles.muted}>まだ投稿結果はありません。</Text>
          )}
          <Link href="/(tabs)/history" asChild>
            <ActionButton label="履歴を確認する" onPress={() => {}} />
          </Link>
        </Card>

        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Card style={{ flex: 1 }}>
            <Text style={styles.muted}>今後の予定</Text>
            <Text style={{ color: colors.ink, fontSize: 28, fontWeight: '800' }}>{upcomingCount === null ? '－' : `${upcomingCount}件`}</Text>
            {status !== 'mock_preview' && activeAccount?.platform === 'x' ? <Text style={styles.muted}>要確認を除く候補・投稿の保証なし</Text> : null}
          </Card>
          <Card style={{ flex: 1 }}>
            <Text style={styles.muted}>要確認</Text>
            <Text style={{ color: attentionCount ? colors.danger : colors.ink, fontSize: 28, fontWeight: '800' }}>
              {attentionCount === null ? '－' : `${attentionCount}件`}
            </Text>
          </Card>
        </View>
        {reservations.kind === 'ready' ? <Text style={styles.muted}>{`Xの保存済み予約: ${reservations.total}件（取消済み・投稿済みを含む）。送信できない以前の接続の予約は「要確認」に表示し、今後の候補には含めません。`}</Text> : null}

        <BrandPostPreview brandId={activeAccount?.brandId} workspaceName={workspace?.name ?? ''} handle={activeAccount?.profile.handle} />

        <Card style={{ backgroundColor: colors.primarySoft, borderColor: '#C7D2FE' }}>
          <Text style={{ color: colors.primary, fontWeight: '800' }}>投稿内容を調整する</Text>
          <Text style={{ color: colors.ink, ...typography.body }}>トーン・頻度・NGワードなどを設定画面から調整できます。</Text>
          <Link href="/(tabs)/settings" asChild>
            <ActionButton label="投稿設定を開く" onPress={() => {}} />
          </Link>
        </Card>

        <Card style={{ backgroundColor: colors.primarySoft, borderColor: '#C7D2FE' }}>
          <Text style={{ color: colors.primary, fontWeight: '800' }}>AI運用担当者からの提案</Text>
          <Text style={{ color: colors.ink, ...typography.body }}>今週は投稿の冒頭を短くすると、読みやすさが上がりそうです。</Text>
          <Link href="/(tabs)/consult" asChild>
            <ActionButton label="相談内容を見る" onPress={() => {}} />
          </Link>
        </Card>

        {postsView.kind === 'posts' && postsView.posts.length === 0 && historyView.kind === 'posts' && historyView.posts.length === 0 && homeHasNoReservations(reservations) ? (
          <EmptyState title="まだ運用データがありません" detail="接続とアカウント選択が完了すると、予定と履歴がここに表示されます。" />
        ) : null}

        <SignOutButton />
      </ScrollView>
    </Screen>
  );
}
