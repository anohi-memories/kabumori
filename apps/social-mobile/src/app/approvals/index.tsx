import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { colors } from '@/constants/theme';
import { ActionButton, Card, EmptyState, Pill, Screen, SectionTitle, styles } from '@/components/ui';
import type { Candidate } from '@/features/approvals/approval-client';
import { ACTION_TEXT, APPROVAL_BLOCK_TEXT, shortHash, STATE_LABEL, stateTone } from '@/features/approvals/approval-view';
import { useApprovals } from '@/features/approvals/use-approvals';
import { formatJst } from '@/features/reservations/reservation-view';

const inputStyle = { borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 10, color: colors.ink, backgroundColor: colors.surface } as const;

export default function ApprovalsScreen() {
  const view = useApprovals();
  const router = useRouter();
  const params = useLocalSearchParams<{ candidate?: string }>();
  const [selected, setSelected] = useState<string | null>(typeof params.candidate === 'string' ? params.candidate : null);
  const [draft, setDraft] = useState('');
  const [draftTime, setDraftTime] = useState('');
  const [editing, setEditing] = useState<{ id: string; body: string; time: string } | null>(null);
  const [confirmReject, setConfirmReject] = useState<string | null>(null);

  if (view.kind === 'blocked') {
    return <Screen><ScrollView contentContainerStyle={{ gap: 16 }}><SectionTitle detail="承認するまで予約には登録されず、投稿されません">投稿の承認</SectionTitle><Card><Text style={styles.muted}>{APPROVAL_BLOCK_TEXT[view.block]}</Text></Card></ScrollView></Screen>;
  }
  const busy = view.busy !== null;
  const items = view.list.state === 'ready' ? view.list.items : [];

  const row = (c: Candidate) => {
    const open = selected === c.candidateId;
    const pending = c.state === 'pending_approval';
    const edit = editing?.id === c.candidateId ? editing : null;
    return (
      <Card key={c.candidateId}>
        <Pressable accessibilityRole="button" accessibilityLabel={`投稿候補 ${formatJst(c.scheduledAt)}`} onPress={() => { setSelected(open ? null : c.candidateId); setEditing(null); setConfirmReject(null); }}>
          <View style={{ gap: 4 }}>
            <Text style={{ color: colors.ink, fontWeight: '700' }}>{formatJst(c.scheduledAt)}</Text>
            <Pill tone={stateTone(c.state)}>{STATE_LABEL[c.state]}</Pill>
            <Text style={{ color: colors.ink }}>{c.body}</Text>
          </View>
        </Pressable>
        {open ? (
          <View style={{ gap: 8 }}>
            <Text style={styles.muted}>{`確認用の番号: ${shortHash(c)}・版 ${c.revision}`}</Text>
            {pending && view.generationChanged.includes(c.candidateId) ? (
              <>
                <Text style={styles.muted}>{ACTION_TEXT.generation_changed}</Text>
                <ActionButton label="修正して承認に回し直す" disabled={busy} onPress={() => void view.revise(c, c.body, formatJst(c.scheduledAt))} />
              </>
            ) : null}
            {pending && !edit ? (
              <>
                <Text style={styles.muted}>この本文と日時で予約に登録します。承認するまで投稿されません。</Text>
                <ActionButton label="承認する" disabled={busy} onPress={() => view.approve(c)} />
                <ActionButton label="修正する" disabled={busy} onPress={() => setEditing({ id: c.candidateId, body: c.body, time: formatJst(c.scheduledAt) })} />
                <ActionButton label={confirmReject === c.candidateId ? '本当に却下する' : '却下する'} disabled={busy} onPress={() => {
                  if (confirmReject !== c.candidateId) { setConfirmReject(c.candidateId); return; }
                  setConfirmReject(null);
                  view.reject(c);
                }} />
              </>
            ) : null}
            {edit ? (
              <>
                <TextInput accessibilityLabel="修正する本文" value={edit.body} onChangeText={(body) => setEditing({ ...edit, body })} style={[inputStyle, { minHeight: 80 }]} multiline maxLength={560} editable={!busy} />
                <TextInput accessibilityLabel="修正する日時" value={edit.time} onChangeText={(time) => setEditing({ ...edit, time })} style={inputStyle} editable={!busy} />
                <ActionButton label="修正を保存" disabled={busy} onPress={() => void view.revise(c, edit.body, edit.time).then((ok) => { if (ok) setEditing(null); })} />
                <ActionButton label="修正をやめる" disabled={busy} onPress={() => setEditing(null)} />
              </>
            ) : null}
            {c.state === 'approved' ? (
              <>
                <Text style={styles.muted}>予約に登録しました。予約の状態と取消は「予約の管理」で確認できます（投稿を保証するものではありません）。</Text>
                <ActionButton label="予約の管理を開く" onPress={() => router.push('/reservations')} />
              </>
            ) : null}
            {c.state === 'rejected' ? <Text style={styles.muted}>却下した候補は投稿されません。</Text> : null}
          </View>
        ) : null}
      </Card>
    );
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: 16 }}>
        <SectionTitle detail="承認するまで予約には登録されず、投稿されません">投稿の承認</SectionTitle>
        {view.notice ? <Pill tone={view.notice.tone}>{view.notice.text}</Pill> : null}
        <Card>
          <Text style={{ color: colors.ink, fontWeight: '800' }}>新しい投稿候補</Text>
          <TextInput accessibilityLabel="投稿候補の本文" value={draft} onChangeText={setDraft} style={[inputStyle, { minHeight: 80 }]} multiline maxLength={560} editable={!busy} />
          <Text style={styles.muted}>投稿する日時（日本時間、例: 2026-11-20 09:30）</Text>
          <TextInput accessibilityLabel="投稿候補の日時" value={draftTime} onChangeText={setDraftTime} style={inputStyle} editable={!busy} />
          <ActionButton label={view.busy === 'submit' ? '送っています…' : '承認に回す'} disabled={busy || !draft.trim()} onPress={() => void view.submit(draft, draftTime).then((ok) => { if (ok) { setDraft(''); setDraftTime(''); } })} />
        </Card>
        {view.list.state === 'loading' ? <Card><Text style={styles.muted}>投稿候補を読み込んでいます…</Text></Card> : null}
        {view.list.state === 'error' ? <Card><Text style={styles.muted}>{`投稿候補を読み込めませんでした。${ACTION_TEXT[view.list.action]}`}</Text><ActionButton label="もう一度読み込む" onPress={view.reload} /></Card> : null}
        {view.list.state === 'ready' && !items.length ? <EmptyState title="投稿候補はまだありません" detail="上の「承認に回す」から作れます。" /> : null}
        {items.map(row)}
        {view.list.state === 'ready' ? <ActionButton label="最新の状態を読み込む" onPress={view.reload} /> : null}
      </ScrollView>
    </Screen>
  );
}
