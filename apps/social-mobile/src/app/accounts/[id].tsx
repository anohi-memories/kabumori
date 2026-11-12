import { useLocalSearchParams } from 'expo-router';
import { Text, View } from 'react-native';
import { colors } from '@/constants/theme';
import { Card, Pill, Screen, SectionTitle, styles } from '@/components/ui';
import { PublishSettingCard } from '@/features/publish-setting/publish-setting-card';
import { usePersonalWorkspace } from '@/features/personal-workspace/personal-workspace-provider';
import { isXReconnectRequired, isXServiceRestarted, useXReconnectSignal } from '@/features/reservations/x-reconnect-signal';
import { connectionPill, restartAppliesTo, X_CONNECTION_UNVERIFIED_LABEL, X_CONNECTION_UNVERIFIED_TEXT } from '@/features/reservations/x-write-view';
import { ThreadsConnectCard } from '@/features/threads-connect/threads-connect-card';
import { ThreadsPublishCard } from '@/features/threads-publish/threads-publish-card';
import { useActiveAccount } from '@/providers/active-account-provider';
import { useAuth } from '@/providers/auth-provider';
import { useDataStatus } from '@/providers/data-provider';

export default function AccountDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { accounts } = useActiveAccount();
  const { status, reload, settled } = useDataStatus();
  const { session } = useAuth();
  const { view: workspace } = usePersonalWorkspace();
  useXReconnectSignal();
  const account = accounts.find((item) => item.id === id);
  if (!account) return <Screen><Card><Text style={{ color: colors.ink, fontWeight: '800' }}>アカウントが見つかりません</Text><Text style={styles.muted}>一覧からもう一度選択してください。</Text></Card></Screen>;
  const pill = connectionPill(account.connectionStatus, account.platform === 'x' && isXReconnectRequired(account.id), '要確認', isXServiceRestarted(session?.user?.id) && restartAppliesTo(account, workspace.kind === 'ready' ? workspace.workspaceId : null), status === 'mock_preview' ? 'preview' : account.platform);
  return (
    <Screen>
      <SectionTitle detail={account.profile.handle}>アカウント詳細</SectionTitle>
      <Card>
        <Text style={{ color: colors.ink, fontSize: 20, fontWeight: '800' }}>{account.profile.displayName}</Text>
        <Text style={styles.muted}>{account.platform.toUpperCase()}</Text>
        <Pill tone={pill.tone}>{pill.label}</Pill>
        {pill.label === X_CONNECTION_UNVERIFIED_LABEL ? <Text style={styles.muted}>{X_CONNECTION_UNVERIFIED_TEXT}</Text> : null}
      </Card>
      <PublishSettingCard key={account.id} account={account} preview={status === 'mock_preview'} reload={reload} />
      {account.platform === 'threads' ? <ThreadsPublishCard key={`threads-${account.id}`} account={account} preview={status === 'mock_preview'} accounts={accounts} reload={reload} refreshKey={settled} /> : null}
      {account.platform === 'threads' && account.connectionStatus !== 'connected' ? <ThreadsConnectCard key={`threads-connect-${account.id}`} threadsAccount={account} accounts={accounts} reload={reload} preview={status === 'mock_preview'} /> : null}
      <Card>
        <Text style={{ color: colors.ink, fontWeight: '800' }}>声の設定（プレビュー）</Text>
        <View style={{ gap: 6 }}>
          <Text style={styles.muted}>トーン: {account.profile.voice.tone}</Text>
          <Text style={styles.muted}>言語: {account.profile.voice.language}</Text>
          <Text style={styles.muted}>避ける表現: {account.profile.voice.avoid.join('、')}</Text>
        </View>
      </Card>
    </Screen>
  );
}
