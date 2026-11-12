import { Text, View } from 'react-native';
import { ActionButton, Card, Pill, SectionTitle, styles } from '@/components/ui';
import { formatJst } from '@/features/reservations/reservation-view';
import { ENDED_HISTORY_NOTE, notificationText, olderRequestsText, STATE_LABEL, stateTone } from './approval-view';
import { useEndedHistory } from './use-ended-history';

/** The read-only history of a person whose service has ended (G1 TASK 46). It has no button that writes anything. */
export function EndedHistory({ userId }: { userId: string | null }) {
  const view = useEndedHistory(userId);
  if (view.state === 'off') return null;
  return (
    <View style={{ gap: 12 }}>
      <Card>
        <SectionTitle detail={ENDED_HISTORY_NOTE}>これまでの承認とお知らせ（閲覧のみ）</SectionTitle>
      </Card>
      {view.state === 'loading' ? <Card><Text style={styles.muted}>読み込んでいます…</Text></Card> : null}
      {view.state === 'error' ? (
        <Card>
          <Pill tone="warning">{view.message}</Pill>
          <ActionButton label="もう一度読み込む" onPress={view.reload} />
        </Card>
      ) : null}
      {view.state === 'ready' ? (
        <>
          <SectionTitle>投稿候補</SectionTitle>
          {view.candidates.length === 0 ? <Card><Text style={styles.muted}>表示できる投稿候補はありません。</Text></Card> : null}
          {view.candidates.map((c) => (
            <Card key={c.candidateId}>
              <Pill tone={stateTone(c.state)}>{STATE_LABEL[c.state]}</Pill>
              <Text>{c.body}</Text>
              <Text style={styles.muted}>{formatJst(c.scheduledAt)}（日本時間）</Text>
            </Card>
          ))}
          {view.unreadable ? <Text style={styles.muted}>{`読み込めなかった投稿候補が ${view.unreadable}件あります。`}</Text> : null}
          <SectionTitle>お知らせ</SectionTitle>
          {view.groups.length === 0 ? <Card><Text style={styles.muted}>お知らせはありません。</Text></Card> : null}
          {view.groups.map(({ row, older }) => (
            <Card key={row.notificationId}>
              <Text>{notificationText(row)}</Text>
              <Text style={styles.muted}>{formatJst(row.createdAt)}</Text>
              {older.length ? <Text style={styles.muted}>{olderRequestsText(older.length)}</Text> : null}
            </Card>
          ))}
          <ActionButton label="最新の状態を読み込む" onPress={view.reload} />
        </>
      ) : null}
    </View>
  );
}
