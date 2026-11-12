import { useRouter } from 'expo-router';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { colors } from '@/constants/theme';
import { ActionButton, Card, EmptyState, Pill, Screen, SectionTitle, styles } from '@/components/ui';
import type { ApprovalNotification } from '@/features/approvals/approval-client';
import { APPROVAL_BLOCK_TEXT, notificationText, olderRequestsText, PUSH_NOTE, readFailedText, RESERVATION_STATE_TEXT } from '@/features/approvals/approval-view';
import { useApprovalNotifications } from '@/features/approvals/use-approval-notifications';
import { formatJst } from '@/features/reservations/reservation-view';

export default function NotificationsScreen() {
  const view = useApprovalNotifications();
  const router = useRouter();
  if (view.kind === 'blocked') {
    return <Screen><ScrollView contentContainerStyle={{ gap: 16 }}><SectionTitle detail={PUSH_NOTE}>お知らせ</SectionTitle><Card><Text style={styles.muted}>{APPROVAL_BLOCK_TEXT[view.block]}</Text></Card></ScrollView></Screen>;
  }
  const items = view.groups;
  const go = (n: ApprovalNotification) => {
    // G1 TASK 47: an ended service leaves the list to read only; a line opens nothing and marks nothing.
    if (view.readOnly) return;
    view.open(n);
    if (n.candidateId) router.push({ pathname: '/approvals', params: { candidate: n.candidateId } });
    else if (n.reservationId) router.push('/reservations');
  };
  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: 16 }}>
        <SectionTitle detail={PUSH_NOTE}>お知らせ</SectionTitle>
        {view.list.state === 'ready' ? <Pill tone={view.unread ? 'warning' : 'neutral'}>{`未読 ${view.unread}件`}</Pill> : null}
        {view.notice ? <Pill tone="warning">{view.notice}</Pill> : null}
        {view.list.state === 'loading' ? <Card><Text style={styles.muted}>お知らせを読み込んでいます…</Text></Card> : null}
        {view.list.state === 'error' ? <Card><Text style={styles.muted}>{`お知らせを読み込めませんでした。${readFailedText(view.list.action)}`}</Text><ActionButton label="もう一度読み込む" onPress={view.reload} /></Card> : null}
        {view.list.state === 'ready' && !items.length ? <EmptyState title="お知らせはありません" detail="投稿候補を承認に回すと、ここに表示されます。" /> : null}
        {items.map(({ row: n, older }) => (
          <Pressable key={n.notificationId} accessibilityRole="button" accessibilityLabel={`お知らせ ${notificationText(n)}`} accessibilityState={{ disabled: view.readOnly }} disabled={view.readOnly} onPress={() => go(n)}>
            <Card>
              <View style={{ gap: 4 }}>
                {n.readAt === null ? <Pill tone="warning">未読</Pill> : null}
                <Text style={{ color: colors.ink, fontWeight: n.readAt === null ? '800' : '600' }}>{notificationText(n)}</Text>
                {n.kind === 'reservation_changed' && n.state ? <Text style={styles.muted}>{`予約の状態: ${RESERVATION_STATE_TEXT[n.state] ?? n.state}`}</Text> : null}
                {n.scheduledAt ? <Text style={styles.muted}>{`投稿予定: ${formatJst(n.scheduledAt)}`}</Text> : null}
                <Text style={styles.muted}>{formatJst(n.createdAt)}</Text>
                {older.length ? <Text style={styles.muted}>{olderRequestsText(older.length)}</Text> : null}
              </View>
            </Card>
          </Pressable>
        ))}
        {view.list.state === 'ready' ? <ActionButton label="最新の状態を読み込む" onPress={view.reload} /> : null}
      </ScrollView>
    </Screen>
  );
}
