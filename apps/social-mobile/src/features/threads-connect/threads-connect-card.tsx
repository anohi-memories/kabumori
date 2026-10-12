import { Text } from 'react-native';
import { ActionButton, Card, styles } from '@/components/ui';
import { colors } from '@/constants/theme';
import {
  THREADS_CONNECT_UI_ENABLED,
  connectFailureCopy,
  threadsConnectView,
  type ThreadsConnectStarter,
} from '@/domain/threads-connect';
import type { SocialAccount } from '@/domain/types';
import { useThreadsConnect, type ThreadsConnectUiState } from '@/features/threads-connect/use-threads-connect';

function stateMessage(state: ThreadsConnectUiState, verified: boolean): string | null {
  switch (state.kind) {
    case 'idle':
      return null;
    case 'running':
      return 'Threadsの画面で接続を続けてください…';
    case 'verifying':
      return verified ? 'Threadsアカウントを接続しました。投稿するには、アカウントの画面で投稿を許可してください。' : '接続を確認しています…';
    case 'done':
      if (state.result.kind === 'canceled') return '接続をキャンセルしました。';
      if (state.result.kind === 'expired') return '時間が経ちすぎたため、接続を中止しました。もう一度お試しください。';
      return connectFailureCopy(state.result.code);
  }
}

/**
 * Threads connect / reconnect entry. Behind the release flag it is an honest "in preparation" card with a
 * disabled button and nothing runs. With the flag on, the real flow (use-threads-connect) runs and the card
 * reports exactly what happened; "connected" only after the reloaded account data confirms it.
 */
export function ThreadsConnectCard({ threadsAccount, accounts, reload, preview, releaseEnabled = THREADS_CONNECT_UI_ENABLED, starter }: {
  threadsAccount: Pick<SocialAccount, 'connectionStatus'> | null;
  accounts: readonly Pick<SocialAccount, 'id' | 'platform' | 'connectionStatus'>[];
  reload: () => void;
  preview: boolean;
  releaseEnabled?: boolean;
  starter?: ThreadsConnectStarter;
}) {
  const view = threadsConnectView(threadsAccount, { releaseEnabled, preview });
  const { state, verified, connect, busy } = useThreadsConnect({ accounts, reload, releaseEnabled: releaseEnabled && view.canStart, starter });
  const message = stateMessage(state, verified);
  return (
    <Card>
      <Text style={{ color: colors.ink, fontWeight: '800' }}>{view.title}</Text>
      <Text style={styles.muted}>{view.note}</Text>
      {view.buttonLabel ? <ActionButton label={busy ? '接続しています…' : view.buttonLabel} onPress={() => void connect()} disabled={!view.canStart || busy} /> : null}
      {message ? <Text accessibilityLiveRegion="polite" style={styles.muted}>{message}</Text> : null}
    </Card>
  );
}
