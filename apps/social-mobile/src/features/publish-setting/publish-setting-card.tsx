import { useState } from 'react';
import { Text, View } from 'react-native';
import { ActionButton, Card, Pill, styles } from '@/components/ui';
import { colors } from '@/constants/theme';
import { PUBLISH_DISABLE_NOTE, PUBLISH_ENABLE_CONFIRMATION, publishSettingView } from '@/domain/publish-setting';
import type { SocialAccount } from '@/domain/types';
import { usePublishSetting } from '@/features/publish-setting/use-publish-setting';

/**
 * Real per-account automatic-publishing switch. Shows the true server-side state, requires an explicit
 * confirmation to turn ON, and never claims that OFF deletes anything. Functional UI only.
 */
export function PublishSettingCard({ account, preview, reload }: { account: SocialAccount; preview: boolean; reload: () => void }) {
  const view = publishSettingView(account, preview);
  const { state, submit, dismiss, busy } = usePublishSetting(account, reload);
  const [confirming, setConfirming] = useState(false);

  const requestOn = () => { if (busy) return; dismiss(); setConfirming(true); };
  const cancel = () => setConfirming(false);
  const confirmOn = () => { if (busy) return; setConfirming(false); void submit(true); };
  // submit() itself replaces any earlier message with the in-flight state; a second tap is ignored.
  const turnOff = () => { if (busy) return; void submit(false); };

  return (
    <Card>
      <Text style={{ color: colors.ink, fontWeight: '800' }}>自動投稿</Text>
      <Pill tone={view.statusTone}>{view.statusLabel}</Pill>
      {view.note ? <Text style={styles.muted}>{view.note}</Text> : null}

      {confirming ? (
        <View style={{ gap: 8 }}>
          <Text style={{ color: colors.ink }}>{PUBLISH_ENABLE_CONFIRMATION}</Text>
          <ActionButton label="ONにする" onPress={confirmOn} disabled={busy} />
          <ActionButton label="キャンセル" onPress={cancel} disabled={busy} />
        </View>
      ) : (
        <>
          {view.canTurnOn ? <ActionButton label={busy ? '変更しています…' : '自動投稿をONにする'} onPress={requestOn} disabled={busy} /> : null}
          {view.canTurnOff ? (
            <>
              <Text style={styles.muted}>{PUBLISH_DISABLE_NOTE}</Text>
              <ActionButton label={busy ? '変更しています…' : '自動投稿をOFFにする'} onPress={turnOff} disabled={busy} />
            </>
          ) : null}
        </>
      )}

      {state.kind === 'success' ? <Text accessibilityLiveRegion="polite" style={{ color: colors.success }}>{state.message}</Text> : null}
      {state.kind === 'error' ? <Text accessibilityLiveRegion="polite" style={{ color: colors.danger }}>{state.message}</Text> : null}
    </Card>
  );
}
