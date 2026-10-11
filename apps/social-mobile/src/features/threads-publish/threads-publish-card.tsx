import { useState } from 'react';
import { Linking, Pressable, Text, TextInput, View } from 'react-native';
import { ActionButton, Card, Pill, styles } from '@/components/ui';
import { colors } from '@/constants/theme';
import {
  CONSENT_COPY,
  MODE_COPY,
  PUBLISH_CONFIRM_COPY,
  TEXT_ISSUE_COPY,
  THREADS_TEXT_MAX_LENGTH,
  attemptDisplay,
  checkThreadsComposerText,
  pinnedStillValid,
  type PinnedThreadsPublish,
  type ThreadsAttemptView,
} from '@/domain/threads-manual-publish';
import type { SocialAccount } from '@/domain/types';
import { useThreadsManualPublish } from '@/features/threads-publish/use-threads-manual-publish';

const inputStyle = { borderColor: colors.border, borderWidth: 1, borderRadius: 10, padding: 10, color: colors.ink, minHeight: 120, textAlignVertical: 'top' as const };

/**
 * Threads "post now" for one connected Threads account. Shows exactly which account will post, the
 * text and its Threads length, an explicit confirmation, and then only what the server reports: a post
 * is shown as done only once it was read back from Threads (id + permalink). Behind the release flag.
 */
export function ThreadsPublishCard({ account, preview, releaseEnabled }: { account: SocialAccount; preview: boolean; releaseEnabled?: boolean }) {
  const { context, server, answer, message, busy, pin, publish, followUp, setPermission } = useThreadsManualPublish(account, preview, { releaseEnabled });
  const [text, setText] = useState('');
  const [pinned, setPinned] = useState<PinnedThreadsPublish | null>(null);

  if (context.mode === 'not_threads') return null;
  const check = checkThreadsComposerText(text);
  const confirming = pinned !== null && pinnedStillValid(pinned, context) ? pinned : null;
  // Dropped during render: a confirmation never survives a change of account, user or mode.
  if (pinned !== null && confirming === null) setPinned(null);

  const loaded = server.kind === 'loaded' ? server : null;
  const attempt: ThreadsAttemptView | null = loaded?.open ?? answer ?? loaded?.last ?? null;
  const shown = attempt ? attemptDisplay(attempt) : null;
  const note = MODE_COPY[context.mode];

  const requestConfirm = () => {
    if (busy) return;
    const next = pin(text);
    if (next) setPinned(next);
  };
  const confirm = () => {
    if (busy || !confirming) return;
    setPinned(null);
    void publish(confirming).then((accepted) => { if (accepted) setText(''); });
  };

  return (
    <Card>
      <Text style={{ color: colors.ink, fontWeight: '800' }}>Threadsに投稿</Text>
      <Text style={styles.muted}>投稿先: {account.profile.displayName}（{account.profile.handle}）</Text>
      {note ? <Text style={styles.muted}>{note}</Text> : null}

      {context.mode === 'consent_required' ? (
        <View style={{ gap: 8 }}>
          <Text style={{ color: colors.ink }}>{CONSENT_COPY}</Text>
          <ActionButton label={busy ? '変更しています…' : 'このアカウントへの投稿を許可する'} onPress={() => void setPermission(true)} disabled={busy} />
        </View>
      ) : null}

      {context.mode === 'ready' || context.mode === 'preview' ? (
        confirming ? (
          <View style={{ gap: 8 }}>
            <Text style={{ color: colors.ink }}>{confirming.text}</Text>
            <Text style={{ color: colors.ink }}>{PUBLISH_CONFIRM_COPY}</Text>
            <ActionButton label={busy ? '投稿しています…' : '投稿する'} onPress={confirm} disabled={busy} />
            <ActionButton label="戻って編集する" onPress={() => setPinned(null)} disabled={busy} />
          </View>
        ) : (
          <View style={{ gap: 8 }}>
            <TextInput value={text} onChangeText={setText} multiline style={inputStyle} placeholder="Threadsに投稿する文章" editable={!busy} />
            <Text style={check.length > THREADS_TEXT_MAX_LENGTH ? { color: colors.danger } : styles.muted}>{check.length} / {THREADS_TEXT_MAX_LENGTH}</Text>
            {text !== '' && check.issue ? <Text style={{ color: colors.danger }}>{TEXT_ISSUE_COPY[check.issue]}</Text> : null}
            {context.mode === 'preview'
              ? <ActionButton label="プレビューのため投稿できません" onPress={() => {}} disabled />
              : <ActionButton label="投稿内容を確認する" onPress={requestConfirm} disabled={busy || !check.ok} />}
          </View>
        )
      ) : null}

      {shown && attempt && context.mode !== 'release_disabled' && context.mode !== 'preview' ? (
        <View style={{ gap: 6 }}>
          <Pill tone={shown.tone}>{shown.title}</Pill>
          {shown.detail ? <Text style={styles.muted}>{shown.detail}</Text> : null}
          {attempt.status === 'published' && attempt.permalink ? (
            <Pressable accessibilityRole="link" onPress={() => { if (attempt.permalink) void Linking.openURL(attempt.permalink); }}>
              <Text style={{ color: colors.primary }}>Threadsで投稿を見る</Text>
            </Pressable>
          ) : null}
          {shown.canContinue ? <ActionButton label={busy ? '確認しています…' : '続ける'} onPress={() => void followUp('resume', attempt)} disabled={busy} /> : null}
          {shown.canCheck ? <ActionButton label={busy ? '確認しています…' : '確認する'} onPress={() => void followUp('reconcile', attempt)} disabled={busy} /> : null}
        </View>
      ) : null}

      {context.mode === 'ready' && !confirming ? (
        <ActionButton label="このアカウントへの投稿の許可を取り消す" onPress={() => void setPermission(false)} disabled={busy} />
      ) : null}

      {message ? <Text accessibilityLiveRegion="polite" style={{ color: message.tone === 'success' ? colors.success : message.tone === 'danger' ? colors.danger : colors.muted }}>{message.text}</Text> : null}
    </Card>
  );
}
