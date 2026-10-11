import { useRef, useState } from 'react';
import { Text } from 'react-native';
import { ActionButton, Card, styles } from '@/components/ui';
import { colors } from '@/constants/theme';
import {
  THREADS_CONNECT_UI_ENABLED,
  disabledThreadsConnectStarter,
  threadsConnectView,
  type ThreadsConnectStarter,
} from '@/domain/threads-connect';
import type { SocialAccount } from '@/domain/types';

/**
 * Threads connect / reconnect entry. Behind the release flag it is an honest "in preparation" card with a
 * disabled button. The starter is injected: production uses the disabled starter until H5's runtime and
 * the Meta callback / app link are live; nothing here ever shows a connection that did not happen.
 */
export function ThreadsConnectCard({ threadsAccount, preview, releaseEnabled = THREADS_CONNECT_UI_ENABLED, starter = disabledThreadsConnectStarter }: {
  threadsAccount: Pick<SocialAccount, 'connectionStatus'> | null;
  preview: boolean;
  releaseEnabled?: boolean;
  starter?: ThreadsConnectStarter;
}) {
  const view = threadsConnectView(threadsAccount, { releaseEnabled, preview });
  const [message, setMessage] = useState<string | null>(null);
  const inFlight = useRef(false);
  const start = async () => {
    if (!view.canStart || inFlight.current) return;
    inFlight.current = true;
    try {
      const result = await starter.start();
      setMessage(result.kind === 'opened' ? 'Threadsの画面で接続を続けてください。' : 'Threadsとの接続は、まだ利用できません。');
    } catch {
      setMessage('Threadsとの接続を始められませんでした。時間をおいて、もう一度お試しください。');
    } finally {
      inFlight.current = false;
    }
  };
  return (
    <Card>
      <Text style={{ color: colors.ink, fontWeight: '800' }}>{view.title}</Text>
      <Text style={styles.muted}>{view.note}</Text>
      {view.buttonLabel ? <ActionButton label={view.buttonLabel} onPress={() => void start()} disabled={!view.canStart} /> : null}
      {message ? <Text accessibilityLiveRegion="polite" style={styles.muted}>{message}</Text> : null}
    </Card>
  );
}
