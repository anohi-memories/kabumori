import { Text, TextInput, View } from 'react-native';
import { colors } from '@/constants/theme';
import { Card, Pill, styles } from '@/components/ui';
import { serverReservationLabel, type ServerReservation } from '@/domain/reservation-flow';
import { formatJst } from '@/domain/schedule-planner';
import type { PreviewAccount } from '@/features/schedule/preview-card';
import { SmallButton } from '@/features/schedule/schedule-composer';

const inputStyle = { borderColor: colors.border, borderWidth: 1, borderRadius: 8, padding: 8, color: colors.ink, backgroundColor: '#FFFFFF' };
const toneOf = (row: ServerReservation): 'neutral' | 'success' | 'warning' | 'danger' => {
  if (row.status === 'planned') return row.consentState === 'needs_reconfirm' ? 'warning' : 'success';
  if (row.status === 'published') return 'success';
  if (row.status === 'failed' || row.status === 'expired') return 'danger';
  return row.status === 'cancelled' ? 'neutral' : 'warning';
};

/**
 * One reservation as the SERVER returned it (never a local preview). Changes are offered only for a planned row
 * and each one is applied only after the server's read-back: time change (the consent of a manual post then
 * needs a new confirmation), reconfirmation of the exact text / time / account shown, and cancellation.
 */
export function ServerReservationCard({ row, account, busy, retiming, onRetime, onRetimeChange, onRetimeApply, onRetimeCancel, onReconfirm, onCancel }: {
  row: ServerReservation;
  account: PreviewAccount | null;
  busy: boolean;
  retiming: { date: string; time: string } | null;
  onRetime: () => void;
  onRetimeChange: (patch: Partial<{ date: string; time: string }>) => void;
  onRetimeApply: () => void;
  onRetimeCancel: () => void;
  onReconfirm: () => void;
  onCancel: () => void;
}) {
  const manual = row.origin === 'user_authored';
  const planned = row.status === 'planned';
  return (
    <Card>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Text style={{ color: colors.ink, fontWeight: '800' }}>{formatJst(row.scheduledAt)}</Text>
        <Pill tone={toneOf(row)}>{serverReservationLabel(row)}</Pill>
      </View>
      <Text style={styles.muted}>{account ? `投稿先: ${account.displayName}（${account.handle}）・日本時間` : '投稿先: 確認できません'}</Text>
      <Text style={{ color: colors.ink }}>{manual ? (row.body ?? '') : 'AIが投稿の直前に本文を作成します（現在はAIの枠は投稿されません）'}</Text>
      <Text style={styles.muted}>サーバーで確認した予約・X への投稿はまだ行われません</Text>
      {planned && manual && row.consentState === 'needs_reconfirm' ? (
        <Text style={styles.muted}>日時が変わったため、この本文・日時・投稿先でよいか、もう一度確認してください。確認するまで投稿の対象になりません。</Text>
      ) : null}
      {retiming !== null ? (
        <View style={{ gap: 6 }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.muted}>日付</Text>
              <TextInput accessibilityLabel="予約の日付を変更" value={retiming.date} onChangeText={(date) => onRetimeChange({ date })} autoCapitalize="none" placeholder="2026-10-15" style={inputStyle} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.muted}>時刻</Text>
              <TextInput accessibilityLabel="予約の時刻を変更" value={retiming.time} onChangeText={(time) => onRetimeChange({ time })} autoCapitalize="none" placeholder="09:00" style={inputStyle} />
            </View>
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <SmallButton label="予約の日時を変更する" disabled={busy} onPress={onRetimeApply} />
            <SmallButton label="やめる" onPress={onRetimeCancel} />
          </View>
        </View>
      ) : null}
      {planned ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {retiming === null ? <SmallButton label="日時を変更" disabled={busy} onPress={onRetime} /> : null}
          {manual && row.consentState === 'needs_reconfirm' ? <SmallButton label="この内容で再確認" disabled={busy} onPress={onReconfirm} /> : null}
          <SmallButton label="予約を取り消す" disabled={busy} onPress={onCancel} />
        </View>
      ) : null}
      {busy ? <Text style={styles.muted}>サーバーに確認しています…</Text> : null}
    </Card>
  );
}
