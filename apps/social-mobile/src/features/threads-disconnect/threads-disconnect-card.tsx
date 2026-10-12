import { Text, View } from 'react-native';
import { ActionButton, Card, styles } from '@/components/ui';
import { colors } from '@/constants/theme';
import {
  THREADS_DISCONNECT_UI_ENABLED,
  disconnectConfirmLines,
  disconnectResultLines,
  disconnectTarget,
  threadsDisconnectView,
  type ThreadsDisconnector,
} from '@/domain/threads-disconnect';
import type { SocialAccount } from '@/domain/types';
import { useThreadsDisconnect, type ThreadsDisconnectUiState } from '@/features/threads-disconnect/use-threads-disconnect';

function resultLines(state: ThreadsDisconnectUiState, verified: boolean): string[] {
  switch (state.kind) {
    case 'running':
      return ['解除しています…'];
    case 'verifying': {
      if (!verified) return ['解除を確認しています…'];
      const lines = disconnectResultLines(state.result);
      return lines.remote ? [lines.local, lines.remote] : [lines.local];
    }
    case 'done': {
      const lines = disconnectResultLines(state.result);
      return lines.remote ? [lines.local, lines.remote] : [lines.local];
    }
    default:
      return [];
  }
}

/**
 * Removes ONLY the Threads connection (X, the POSTONA registration and the common account stay). Behind the
 * release flag it is an honest "in preparation" card with a disabled button and nothing runs. With the flag
 * on: confirm the exact account -> one request -> "disconnected" only after the reloaded account data no
 * longer shows it; the POSTONA-side result and the Threads-side note are shown as separate lines.
 * Stays mounted on the accounts screen so the result is still visible after the account disappears.
 */
export function ThreadsDisconnectCard({ threadsAccount, accounts, reload, preview, releaseEnabled = THREADS_DISCONNECT_UI_ENABLED, disconnector }: {
  threadsAccount: Pick<SocialAccount, 'id' | 'platform' | 'profile'> | null;
  accounts: readonly Pick<SocialAccount, 'id' | 'platform'>[];
  reload: () => void;
  preview: boolean;
  releaseEnabled?: boolean;
  disconnector?: ThreadsDisconnector;
}) {
  const view = threadsDisconnectView({ releaseEnabled, preview });
  const target = threadsAccount ? disconnectTarget(threadsAccount) : null;
  const { state, verified, ask, cancel, confirm, busy } = useThreadsDisconnect({
    accounts, reload, releaseEnabled: releaseEnabled && view.canStart, disconnector,
  });
  if (!threadsAccount && (state.kind === 'idle' || state.kind === 'confirming')) return null;
  const lines = resultLines(state, verified);
  return (
    <Card>
      <Text style={{ color: colors.ink, fontWeight: '800' }}>Threads連携の解除</Text>
      {state.kind === 'confirming' ? (
        <View style={{ gap: 6 }}>
          {disconnectConfirmLines(state.target).map((line) => <Text key={line} style={styles.muted}>{line}</Text>)}
          <ActionButton label="解除する" onPress={() => void confirm()} disabled={busy} />
          <ActionButton label="やめる" onPress={cancel} disabled={busy} />
        </View>
      ) : (
        <>
          <Text style={styles.muted}>{view.note}</Text>
          {threadsAccount ? (
            <ActionButton label={busy ? '解除しています…' : view.buttonLabel} onPress={() => ask(target)} disabled={!view.canStart || busy || !target} />
          ) : null}
        </>
      )}
      {lines.map((line) => <Text key={line} accessibilityLiveRegion="polite" style={styles.muted}>{line}</Text>)}
    </Card>
  );
}
