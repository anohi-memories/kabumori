import { useState } from 'react';
import { Text, View } from 'react-native';
import { ActionButton, Card, Pill, styles } from '@/components/ui';
import { colors } from '@/constants/theme';
import {
  PUBLISH_DISABLE_NOTE,
  PUBLISH_ENABLE_CONFIRMATION,
  PUBLISH_ENABLE_NOTE,
  pinPublishAction,
  publishActionStillValid,
  publishSettingView,
  type PublishAction,
} from '@/domain/publish-setting';
import type { SocialAccount } from '@/domain/types';
import { usePublishSetting } from '@/features/publish-setting/use-publish-setting';

/**
 * Real per-account automatic-publishing switch. Shows the true server-side state, requires an explicit
 * confirmation to turn ON, and never claims that OFF deletes anything. Functional UI only.
 *
 * The ON confirmation is pinned to what was on screen when it was opened (account, current state,
 * eligibility, not-preview, signed-in user). If any of that changes before the person confirms, the
 * confirmation is closed for good and nothing is sent; they have to ask again against what they now see.
 */
export function PublishSettingCard({ account, preview, reload }: { account: SocialAccount; preview: boolean; reload: () => void }) {
  const view = publishSettingView(account, preview);
  const { context, state, submit, dismiss, busy } = usePublishSetting(account, preview, reload);
  const [pinned, setPinned] = useState<PublishAction | null>(null);

  const confirming = pinned !== null && publishActionStillValid(pinned, context) ? pinned : null;
  // Dropped during render (not kept around): a context that later happens to match again must not
  // bring back a confirmation the person never gave for it.
  if (pinned !== null && confirming === null) setPinned(null);

  const requestOn = () => {
    if (busy) return;
    const action = pinPublishAction(context, true);
    if (!action) return;
    dismiss();
    setPinned(action);
  };
  const cancel = () => setPinned(null);
  const confirmOn = () => {
    if (busy || !confirming) return;
    setPinned(null);
    // submit() re-checks the pinned action against the latest screen before sending anything.
    void submit(confirming);
  };
  const turnOff = () => {
    if (busy) return;
    const action = pinPublishAction(context, false);
    if (action) void submit(action);
  };

  // Only messages about THIS account are shown here.
  const message = state.kind !== 'idle' && state.kind !== 'submitting' && state.accountId === account.id ? state : null;

  return (
    <Card>
      <Text style={{ color: colors.ink, fontWeight: '800' }}>自動投稿</Text>
      <Pill tone={view.statusTone}>{view.statusLabel}</Pill>
      {view.note ? <Text style={styles.muted}>{view.note}</Text> : null}

      {confirming ? (
        <View style={{ gap: 8 }}>
          <Text style={{ color: colors.ink }}>{PUBLISH_ENABLE_CONFIRMATION}</Text>
          <Text style={styles.muted}>{PUBLISH_ENABLE_NOTE}</Text>
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

      {message?.kind === 'success' ? <Text accessibilityLiveRegion="polite" style={{ color: colors.success }}>{message.message}</Text> : null}
      {message?.kind === 'error' ? <Text accessibilityLiveRegion="polite" style={{ color: colors.danger }}>{message.message}</Text> : null}
    </Card>
  );
}
