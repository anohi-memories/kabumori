import { Text, TextInput, View } from 'react-native';
import { colors } from '@/constants/theme';
import { Card, Pill, styles } from '@/components/ui';
import { formatJst, type ScheduleDraft } from '@/domain/schedule-planner';
import type { ConfirmationStatus } from '@/features/schedule/confirmation-state';
import { MODE_LABELS, PREVIEW_LABEL } from '@/features/schedule/schedule-labels';
import { SmallButton } from '@/features/schedule/schedule-composer';

export type PreviewAccount = { displayName: string; handle: string };

const inputStyle = { borderColor: colors.border, borderWidth: 1, borderRadius: 8, padding: 8, color: colors.ink, backgroundColor: '#FFFFFF' };

/**
 * One preview post: what would be posted, when (JST) and to which X account, with its own confirmation.
 * Everything here is local. Confirming records what is on screen; it saves and posts nothing, and any change
 * of text, time or account makes the confirmation invalid again.
 */
export function PreviewCard({ draft, account, conflict, confirmation, editing, retiming, onEdit, onEditChange, onEditApply, onEditCancel,
  onRetime, onRetimeChange, onRetimeApply, onRetimeCancel, onMove, onCancel, onConfirm, onUnconfirm }: {
  draft: ScheduleDraft;
  /** The selected X account this post is planned for. */
  account: PreviewAccount | null;
  conflict: boolean;
  confirmation: ConfirmationStatus;
  editing: string | null;
  retiming: { date: string; time: string } | null;
  onEdit: () => void;
  onEditChange: (text: string) => void;
  onEditApply: () => void;
  onEditCancel: () => void;
  onRetime: () => void;
  onRetimeChange: (patch: Partial<{ date: string; time: string }>) => void;
  onRetimeApply: () => void;
  onRetimeCancel: () => void;
  onMove: (direction: -1 | 1) => void;
  onCancel: () => void;
  onConfirm: () => void;
  onUnconfirm: () => void;
}) {
  const manual = draft.origin === 'user_authored';
  const busy = editing !== null || retiming !== null;
  const confirmBlockedReason = !account
    ? '投稿先のアカウントを確認できないため、確認できません。'
    : conflict
      ? '近い予定があるため、確認できません。先に競合を解消してください。'
      : null;
  return (
    <Card style={{ borderStyle: 'dashed', borderColor: conflict ? colors.danger : colors.border }}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Text style={{ color: colors.ink, fontWeight: '800' }}>{formatJst(draft.scheduledAt)}{draft.fixed ? '（日時指定）' : ''}</Text>
        <Pill tone="neutral">{PREVIEW_LABEL}</Pill>
      </View>
      <Text style={styles.muted}>
        {account ? `投稿先: ${account.displayName}（${account.handle}）・日本時間` : '投稿先: 確認できません'}
      </Text>
      {editing !== null ? (
        <View style={{ gap: 6 }}>
          <TextInput accessibilityLabel="本文を編集" value={editing} onChangeText={onEditChange} multiline style={[inputStyle, { minHeight: 64 }]} />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <SmallButton label="反映" onPress={onEditApply} />
            <SmallButton label="やめる" onPress={onEditCancel} />
          </View>
        </View>
      ) : (
        <Text style={{ color: colors.ink }}>{manual ? draft.text : 'AIが投稿の直前に本文を作成します'}</Text>
      )}
      {retiming !== null ? (
        <View style={{ gap: 6 }}>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.muted}>日付</Text>
              <TextInput accessibilityLabel="日付を変更" value={retiming.date} onChangeText={(date) => onRetimeChange({ date })} autoCapitalize="none" placeholder="2026-10-15" style={inputStyle} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={styles.muted}>時刻</Text>
              <TextInput accessibilityLabel="時刻を変更" value={retiming.time} onChangeText={(time) => onRetimeChange({ time })} autoCapitalize="none" placeholder="09:00" style={inputStyle} />
            </View>
          </View>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <SmallButton label="日時を反映" onPress={onRetimeApply} />
            <SmallButton label="やめる" onPress={onRetimeCancel} />
          </View>
        </View>
      ) : null}
      <Text style={styles.muted}>
        {manual ? `手動予約・${MODE_LABELS[draft.mode]}` : 'AI自動投稿'}
        {!manual ? (draft.aiAutoPostConsent === 'granted_by_owner_setting' ? ' ・ 自動投稿の同意: 設定で選択済み' : ' ・ 自動投稿の同意なし') : ''}
        {conflict ? ' ・ 近い予定があります' : ''}
      </Text>

      {manual ? (
        <View style={{ gap: 6 }}>
          {confirmation === 'confirmed' ? <Pill tone="success">確認済み（本文・日時・投稿先）</Pill> : null}
          {confirmation === 'invalidated' ? <Pill tone="warning">本文・日時・投稿先が変わったため、確認が無効になりました。もう一度確認してください</Pill> : null}
          {confirmation === 'unconfirmed' ? <Pill tone="neutral">未確認</Pill> : null}
          {confirmation !== 'confirmed' && confirmBlockedReason ? <Text style={styles.muted}>{confirmBlockedReason}</Text> : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {confirmation === 'confirmed'
              ? <SmallButton label="確認を取り消す" onPress={onUnconfirm} />
              : <SmallButton label="本文・日時・投稿先を確認" disabled={busy || confirmBlockedReason !== null} onPress={onConfirm} />}
          </View>
        </View>
      ) : (
        <Text style={styles.muted}>AI自動予約の枠には本文がないため、1件ずつの確認はありません。</Text>
      )}

      {manual && draft.mode === 'manual_random_batch' ? <Text style={styles.muted}>日時は、上の「再抽選」で決めた期間と時間帯の中で引き直せます。</Text> : null}
      {manual && draft.mode === 'manual_interval' ? <Text style={styles.muted}>間隔指定の日時は、決めた間隔のまま保たれます。変えたいときは作り直してください。</Text> : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {manual && !busy ? <SmallButton label="編集" onPress={onEdit} /> : null}
        {manual && draft.mode === 'manual_exact' && !busy ? <SmallButton label="日時を変更" onPress={onRetime} /> : null}
        {manual ? <SmallButton label="↑" onPress={() => onMove(-1)} /> : null}
        {manual ? <SmallButton label="↓" onPress={() => onMove(1)} /> : null}
        <SmallButton label="取り消し" onPress={onCancel} />
      </View>
    </Card>
  );
}
