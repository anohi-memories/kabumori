import { Text, View } from 'react-native';
import { colors, radius, spacing } from '@/constants/theme';
import { Card, Pill, styles } from '@/components/ui';
import type { SocialAccount } from '@/domain/types';

type Props = Readonly<{
  account: SocialAccount | null;
  /** The text exactly as it would be sent (already normalised), or '' while nothing valid is typed. */
  text: string;
}>;

/**
 * What the post would look like. It is clearly NOT the post: it carries its own label, says nothing has been
 * posted, and is visually separated from the input.
 */
export function ManualPostPreview({ account, text }: Props) {
  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <Pill>プレビュー</Pill>
        <Text style={styles.muted}>まだ投稿されていません</Text>
      </View>
      <View
        accessibilityLabel="投稿プレビュー"
        style={{ borderColor: colors.border, borderWidth: 1, borderRadius: radius.md, padding: spacing.md, gap: spacing.sm, backgroundColor: colors.background }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: account?.profile.avatarColor ?? colors.border }} />
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.ink, fontWeight: '800' }}>{account?.profile.displayName ?? '投稿先を選択してください'}</Text>
            <Text style={styles.muted}>{account?.profile.handle ?? ''}</Text>
          </View>
        </View>
        {text === '' ? (
          <Text style={styles.muted}>本文を入力するとここに表示されます。</Text>
        ) : (
          <Text style={{ color: colors.ink, fontSize: 15, lineHeight: 22 }}>{text}</Text>
        )}
      </View>
    </Card>
  );
}
