import { useRouter } from 'expo-router';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { colors } from '@/constants/theme';
import { ActionButton, Card, Pill, Screen, SectionTitle, styles } from '@/components/ui';
import { useXConnect } from '@/features/x-connect/use-x-connect';
import { useActiveAccount } from '@/providers/active-account-provider';
import { useDataStatus } from '@/providers/data-provider';

export default function AccountsScreen() {
  const router = useRouter();
  const { accounts, activeAccount, selectAccount } = useActiveAccount();
  const { status, reload } = useDataStatus();
  const { state: connectState, stateText, verifiedHandle, connect } = useXConnect(reload);
  const xAccount = accounts.find((account) => account.platform === 'x');
  const needsReconnect = xAccount?.connectionStatus === 'needs_attention';

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: 16 }}>
        <SectionTitle detail="複数SNSをひとつの運用画面で管理">アカウント一覧</SectionTitle>
        {status !== 'mock_preview' && status !== 'ready' ? (
          <Card><Text style={styles.muted}>{status === 'loading' ? 'アカウントを読み込んでいます…' : 'アカウント情報を確認できません。'}</Text></Card>
        ) : null}
        {status === 'ready' && accounts.length === 0 ? (
          <Card><Text style={styles.muted}>まだ接続済みのアカウントはありません。下のボタンからXアカウントを接続してください。</Text></Card>
        ) : null}
        {accounts.map((account) => (
          <Card key={account.id}>
            <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: '/accounts/[id]', params: { id: account.id } })} style={({ pressed }) => pressed && styles.buttonPressed}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <View style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: account.profile.avatarColor }} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.ink, fontWeight: '800' }}>{account.profile.displayName}</Text>
                  <Text style={styles.muted}>{account.profile.handle} ・ {account.platform.toUpperCase()}</Text>
                </View>
                <Pill tone={account.connectionStatus === 'connected' ? 'success' : 'warning'}>
                  {account.connectionStatus === 'connected' ? '接続済み' : '要再接続'}
                </Pill>
              </View>
            </Pressable>
            <Text style={styles.muted}>投稿状態: {account.postingState === 'active' ? '稼働中' : '停止中'}</Text>
            <ActionButton label={activeAccount?.id === account.id ? '選択中' : 'このアカウントを選択'} onPress={() => selectAccount(account.id)} />
          </Card>
        ))}

        <Card>
          <SectionTitle detail="ログイン中の利用者本人のXアカウントを連携します。">
            {needsReconnect ? 'Xアカウントの再接続' : 'Xアカウント接続'}
          </SectionTitle>
          {needsReconnect ? <Pill tone="warning">Xとの接続を確認できません。再接続してください。</Pill> : null}
          <Text style={styles.muted}>{stateText}</Text>
          <Text style={styles.muted}>接続時に、Xのログイン画面で接続したいアカウントを選んで（またはログインして）ください。ブラウザの状態によっては、以前ログインしたアカウントが表示される場合があります。</Text>
          {connectState === 'connected' && verifiedHandle ? <Pill tone="success">確認済み {verifiedHandle}</Pill> : null}
          {connectState === 'connecting' ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <ActivityIndicator color={colors.primary} />
              <Text style={styles.muted}>ブラウザを閉じずにお待ちください。</Text>
            </View>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: connectState === 'connecting' }}
            disabled={connectState === 'connecting'}
            onPress={() => void connect()}
            style={({ pressed }) => [styles.button, pressed && styles.buttonPressed, connectState === 'connecting' && { opacity: 0.55 }]}
          >
            <Text style={styles.buttonText}>{xAccount || connectState === 'connected' ? 'Xアカウントを再接続' : 'Xアカウントを接続'}</Text>
          </Pressable>
          <Text style={styles.muted}>接続後も投稿機能は自動で有効になりません。</Text>
        </Card>

        <Pressable accessibilityRole="button" onPress={() => router.push('/login-methods')} style={({ pressed }) => [styles.card, pressed && styles.buttonPressed]}>
          <Text style={{ color: colors.ink, fontWeight: '800' }}>ログイン方法</Text>
          <Text style={styles.muted}>X・Apple・Google・メールアドレスのうち、アプリへのログインに使う方法を確認・追加できます。</Text>
        </Pressable>
      </ScrollView>
    </Screen>
  );
}
