import { Link } from 'expo-router';
import * as Crypto from 'expo-crypto';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { colors } from '@/constants/theme';
import { ActionButton, Card, Pill, Screen, SectionTitle, styles } from '@/components/ui';
import { useActiveAccount } from '@/providers/active-account-provider';
import { useAuth } from '@/providers/auth-provider';
import { base64ToBase64Url, bytesToHex, isRetryableOAuthError, parseOAuthReturn } from '@/lib/x-oauth-onboarding';
import { supabase } from '@/lib/supabase';

WebBrowser.maybeCompleteAuthSession();

type ConnectState = 'idle' | 'connecting' | 'connected' | 'cancelled' | 'retryable_error' | 'terminal_error';

const CONNECT_STATE_TEXT: Record<ConnectState, string> = {
  idle: 'Xアカウントを安全に接続できます。',
  connecting: 'Xの認証を確認しています…',
  connected: 'Xアカウントを接続しました。',
  cancelled: '接続をキャンセルしました。必要なら再試行できます。',
  retryable_error: '一時的な通信エラーです。もう一度お試しください。',
  terminal_error: '安全確認を完了できませんでした。最初からやり直してください。',
};

export default function AccountsScreen() {
  const { accounts, activeAccount, selectAccount } = useActiveAccount();
  const { session } = useAuth();
  const [connectState, setConnectState] = useState<ConnectState>('idle');
  const [verifiedHandle, setVerifiedHandle] = useState<string | null>(null);
  const isConnecting = useRef(false);

  async function connectXAccount() {
    if (isConnecting.current) return;
    isConnecting.current = true;
    setConnectState('connecting');
    setVerifiedHandle(null);

    // Keep raw state and PKCE verifier in memory for this one browser round-trip only.
    let rawState: string | null = null;
    let codeVerifier: string | null = null;
    try {
      if (!supabase || !session?.access_token) throw new Error('AUTH_SESSION_UNAVAILABLE');

      const redirectUri = Linking.createURL('oauth-callback', { scheme: 'kabumori-social' });
      if (redirectUri !== 'kabumori-social://oauth-callback') throw new Error('OAUTH_REDIRECT_URI_INVALID');
      rawState = bytesToHex(await Crypto.getRandomBytesAsync(32));
      codeVerifier = bytesToHex(await Crypto.getRandomBytesAsync(32));
      const digestBase64 = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        codeVerifier,
        { encoding: Crypto.CryptoEncoding.BASE64 },
      );
      const codeChallenge = base64ToBase64Url(digestBase64);

      // The Supabase client forwards the signed-in user's Auth JWT; only the publishable key
      // is configured in this app. No user/brand/account id is sent as an ownership claim.
      const { data: startData, error: startError } = await supabase.functions.invoke<{
        authorization_url?: unknown;
      }>('x-oauth-connect-user', {
        body: { state: rawState, code_challenge: codeChallenge, redirect_uri: redirectUri },
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (startError) throw startError;
      const authorizationUrl = startData?.authorization_url;
      if (typeof authorizationUrl !== 'string') throw new Error('OAUTH_AUTHORIZATION_URL_MISSING');
      const authorization = new URL(authorizationUrl);
      if (authorization.protocol !== 'https:' || authorization.hostname !== 'x.com') {
        throw new Error('OAUTH_AUTHORIZATION_URL_INVALID');
      }

      const browserResult = await WebBrowser.openAuthSessionAsync(authorizationUrl, redirectUri);
      if (browserResult.type === 'cancel' || browserResult.type === 'dismiss') {
        setConnectState('cancelled');
        return;
      }
      if (browserResult.type !== 'success') {
        setConnectState('retryable_error');
        return;
      }

      const callback = parseOAuthReturn(browserResult.url, redirectUri, rawState);
      if (callback.kind === 'cancelled') {
        setConnectState('cancelled');
        return;
      }

      const { data: callbackData, error: callbackError } = await supabase.functions.invoke<{
        success?: unknown;
        handle?: unknown;
      }>('x-oauth-connect-user/callback', {
        body: {
          code: callback.code,
          state: callback.state,
          code_verifier: codeVerifier,
          redirect_uri: redirectUri,
        },
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (callbackError) throw callbackError;
      if (callbackData?.success !== true || typeof callbackData.handle !== 'string' || !callbackData.handle) {
        throw new Error('OAUTH_CALLBACK_RESPONSE_INVALID');
      }
      setVerifiedHandle(`@${callbackData.handle.replace(/^@/u, '')}`);
      setConnectState('connected');
    } catch (error) {
      setConnectState(isRetryableOAuthError(error) ? 'retryable_error' : 'terminal_error');
    } finally {
      rawState = null;
      codeVerifier = null;
      isConnecting.current = false;
    }
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: 16 }}>
        <SectionTitle detail="複数SNSをひとつの運用画面で管理">アカウント一覧</SectionTitle>
        {accounts.map((account) => (
          <Card key={account.id}>
            <Link href={{ pathname: '/accounts/[id]', params: { id: account.id } }} asChild>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <View style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: account.profile.avatarColor }} />
                <View style={{ flex: 1 }}>
                  <Text style={{ color: colors.ink, fontWeight: '800' }}>{account.profile.displayName}</Text>
                  <Text style={styles.muted}>{account.profile.handle} ・ {account.platform.toUpperCase()}</Text>
                </View>
                <Pill tone={account.connectionStatus === 'connected' ? 'success' : 'warning'}>
                  {account.connectionStatus === 'connected' ? '接続済み' : '要確認'}
                </Pill>
              </View>
            </Link>
            <Text style={styles.muted}>投稿状態: {account.postingState === 'active' ? '稼働中' : '停止中'}</Text>
            <ActionButton label={activeAccount?.id === account.id ? '選択中' : 'このアカウントを選択'} onPress={() => selectAccount(account.id)} />
          </Card>
        ))}

        <Card>
          <SectionTitle detail="ログイン中の利用者本人のXアカウントを連携します。">Xアカウント接続</SectionTitle>
          <Text style={styles.muted}>{CONNECT_STATE_TEXT[connectState]}</Text>
          {connectState === 'connected' && verifiedHandle ? (
            <Pill tone="success">確認済み {verifiedHandle}</Pill>
          ) : null}
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
            onPress={() => void connectXAccount()}
            style={({ pressed }) => [styles.button, pressed && styles.buttonPressed, connectState === 'connecting' && { opacity: 0.55 }]}
          >
            <Text style={styles.buttonText}>
              {connectState === 'connected' ? '別のXアカウントを接続' : 'Xアカウントを接続'}
            </Text>
          </Pressable>
          <Text style={styles.muted}>接続後も投稿機能は自動で有効になりません。</Text>
        </Card>
      </ScrollView>
    </Screen>
  );
}
