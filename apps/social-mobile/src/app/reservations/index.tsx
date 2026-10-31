import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { colors } from '@/constants/theme';
import { ActionButton, Card, Pill, Screen, SectionTitle, styles } from '@/components/ui';
import { loginSessionIdOf } from '@/domain/service-enrollment';
import { usePersonalWorkspace } from '@/features/personal-workspace/personal-workspace-provider';
import type { ServerReservation, StoreResult, ThreadsReceipt } from '@/features/reservations/reservation-ports';
import {
  accountRefusal,
  actionView,
  formatJst,
  GATE_OFF_TEXT,
  parseJstInput,
  REREAD_TEXT,
  threadsReceiptView,
  xRowView,
  type ActionButtonKind,
  type Tone,
} from '@/features/reservations/reservation-view';
import { contentSha256, newClientRequestId, useReservationPorts } from '@/features/reservations/use-reservation-ports';
import { useActiveAccount } from '@/providers/active-account-provider';
import { useAuth } from '@/providers/auth-provider';

type Platform = 'x' | 'threads';
type Notice = { scope: string; text: string; tone: Tone; button: ActionButtonKind };
/** One Threads create sent from this screen: the only handle for its receipt (Threads has no list). Memory only. */
type ThreadsRequest = { scope: string; clientRequestId: string; text: string; scheduledAt: string; receipt: ThreadsReceipt | null; missing: boolean };

const inputStyle = { borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 10, color: colors.ink, backgroundColor: colors.surface } as const;
const CLIENT_ERROR = 'CLIENT_ERROR';

/**
 * X / Threads reservations: list, status, receipt, reschedule / reconfirm / cancel (X) and create / receipt / cancel
 * (Threads), through the stores' ports only (use-reservation-ports.ts). With the release gates OFF nothing is sent and
 * nothing is ever shown as 「予約済み」. Every answer is tagged with the person, the login, the platform and the account it
 * was asked for and is dropped when any of them changed; one request at a time; a 401 blocks this token until the
 * person signs in again; only an account of the person's own personal workspace is touched.
 */
export default function ReservationsScreen() {
  const router = useRouter();
  const { session } = useAuth();
  const { accounts } = useActiveAccount();
  const { view: workspace } = usePersonalWorkspace();
  const ports = useReservationPorts();
  const userId = session?.user?.id ?? null;
  const token = session?.access_token ?? null;
  const loginId = userId && token ? loginSessionIdOf(userId, token) : null;

  const [platform, setPlatform] = useState<Platform>('x');
  const [accountId, setAccountId] = useState<string | null>(null);
  const candidates = accounts.filter((item) => item.platform === platform);
  const account = candidates.find((item) => item.id === accountId) ?? candidates[0] ?? null;
  const personalId = workspace.kind === 'ready' ? workspace.workspaceId : null;
  const refusal = !userId || !loginId ? 'ログインが確認できないため、予約を操作できません。ログインし直してください。' : accountRefusal(account, platform, personalId);
  const scope = refusal === null && account ? `${userId}\n${loginId}\n${platform}\n${account.id}` : null;
  const enabled = platform === 'x' ? ports.x.enabled : ports.threads.enabled;

  // The access token a 401 answered: nothing is sent with it again.
  const [refusedToken, setRefusedToken] = useState<string | null>(null);
  const loginRefused = refusedToken !== null && refusedToken === token;
  // A refusal that keeps this scope's actions off (service, connection, not available) until a read succeeds.
  const [blockedScope, setBlockedScope] = useState<string | null>(null);
  // Reads stay possible while a refusal blocks the writes (after reconnecting, a read clears it).
  const canRead = scope !== null && enabled && !loginRefused;
  const usable = canRead && blockedScope !== scope;

  const [xList, setXList] = useState<{ scope: string; rows: ServerReservation[] } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<string | null>(null);
  const [timeText, setTimeText] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [reads, setReads] = useState(0);
  const [threadsText, setThreadsText] = useState('');
  const [threadsTime, setThreadsTime] = useState('');
  const [threadsRequests, setThreadsRequests] = useState<ThreadsRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const live = useRef<string | null>(scope);
  useEffect(() => { live.current = scope; }, [scope]);

  const say = (mine: string, text: string, tone: Tone = 'warning', button: ActionButtonKind = null) => setNotice({ scope: mine, text, tone, button });

  /** A refusal: what it means for the screen. `reread` reads the rows / receipt again (never the same write again). */
  const fail = (code: string, mine: string, sentToken: string | null, reread: (() => void) | null) => {
    const action = ports.actionOf(code);
    const view = actionView(action, mine.split('\n')[2] === 'threads' ? 'threads' : 'x');
    // a 401 is shown by the refused-token card (for that token only), not as a notice that would outlive it
    if (action === 'sign_in') { setRefusedToken(sentToken); return; }
    if (view.blocks) setBlockedScope(mine);
    const again = view.reread && reread !== null;
    say(mine, again ? `${view.message}${REREAD_TEXT}` : view.message, 'warning', view.button);
    if (again) reread();
  };

  // X: read the account's reservations (first view, another account / person / login, an explicit or follow-up read).
  useEffect(() => {
    if (platform !== 'x' || scope === null || !ports.x.enabled || loginRefused) return;
    const mine = scope;
    const id = mine.split('\n')[3];
    const sentToken = token;
    let cancelled = false;
    void Promise.resolve().then(async () => {
      if (cancelled) return;
      let result: StoreResult<ServerReservation[]>;
      try { result = await ports.x.list(id); } catch { result = { ok: false, code: CLIENT_ERROR }; }
      if (cancelled || live.current !== mine) return;
      if (result.ok) {
        setBlockedScope((value) => (value === mine ? null : value));
        setXList({ scope: mine, rows: [...result.value].sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt)) });
      } else {
        setXList({ scope: mine, rows: [] });
        fail(result.code, mine, sentToken, null);
      }
    });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform, scope, reads, ports, loginRefused]);

  const rereadX = () => setReads((value) => value + 1);

  /** One X edit at a time, for the row as last read (its revision). */
  const editX = async (op: () => Promise<StoreResult<ServerReservation>>, done: (row: ServerReservation) => string) => {
    if (inFlight.current || !usable || scope === null) return;
    inFlight.current = true;
    setBusy(true);
    const mine = scope;
    const sentToken = token;
    try {
      let result: StoreResult<ServerReservation>;
      try { result = await op(); } catch { result = { ok: false, code: CLIENT_ERROR }; }
      if (live.current !== mine) return;
      if (result.ok) {
        const row = result.value;
        setXList((value) => (value && value.scope === mine ? { scope: mine, rows: value.rows.map((item) => (item.reservationId === row.reservationId ? row : item)) } : value));
        setConfirmCancel(null);
        say(mine, done(row), xRowView(row).needsReconfirm ? 'warning' : 'success');
      } else {
        fail(result.code, mine, sentToken, rereadX);
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const reschedule = (row: ServerReservation) => {
    if (scope === null) return;
    const parsed = parseJstInput(timeText, new Date());
    if (!parsed.ok) { say(scope, parsed.message); return; }
    void editX(() => ports.x.reschedule(row.reservationId, row.revision, parsed.iso),
      (next) => (xRowView(next).needsReconfirm ? '時刻を変更しました。この本文で投稿してよいか、再確認してください。確認するまで投稿されません。' : '時刻を変更しました。'));
  };
  const reconfirm = (row: ServerReservation) => {
    if (scope === null) return;
    const body = row.body;
    if (typeof body !== 'string' || body.length === 0) { say(scope, '本文を読み込めないため、再確認できません。最新の状態を読み込んでください。'); return; }
    void editX(async () => ports.x.reconfirm(row.reservationId, row.revision, await contentSha256(body)), () => 'この本文で再確認しました。');
  };
  const cancelX = (row: ServerReservation) => {
    if (confirmCancel !== row.reservationId) { setConfirmCancel(row.reservationId); return; }
    void editX(() => ports.x.cancel(row.reservationId, row.revision), () => '予約を取り消しました。');
  };

  // Threads: one create per press, with a new client request id; the request is kept (memory) so its receipt can be read.
  const createThreads = async () => {
    if (inFlight.current || !usable || scope === null || !account) return;
    const text = threadsText.trim();
    if (!text) { say(scope, '本文を入力してください。'); return; }
    const parsed = parseJstInput(threadsTime, new Date());
    if (!parsed.ok) { say(scope, parsed.message); return; }
    inFlight.current = true;
    setBusy(true);
    const mine = scope;
    const sentToken = token;
    const clientRequestId = newClientRequestId();
    const record = (receipt: ThreadsReceipt | null) => setThreadsRequests((value) => [...value, { scope: mine, clientRequestId, text, scheduledAt: parsed.iso, receipt, missing: false }]);
    try {
      let outcome;
      try {
        outcome = await ports.threads.create({ socialAccountId: account.id, clientRequestId, text, contentSha256: await contentSha256(text), scheduledAt: parsed.iso });
      } catch {
        outcome = { kind: 'uncertain' as const, code: CLIENT_ERROR };
      }
      if (outcome.kind === 'saved') record(outcome.receipt);
      // It may have been stored: keep its id to read the receipt, and never create it again.
      if (outcome.kind === 'uncertain') record(null);
      if (live.current !== mine) return;
      if (outcome.kind === 'saved') {
        setThreadsText('');
        setThreadsTime('');
        say(mine, threadsReceiptView(outcome.receipt.state).label === '予約済み' ? '予約しました（受領票で確認済み）。' : 'Threadsの受領票を確認してください。', 'success');
      } else if (outcome.kind === 'uncertain') {
        say(mine, 'Threadsに届いたかどうか分かりません。下の「受領票を確認」で確かめてください。同じ予約を作り直すことはありません。');
      } else if (outcome.kind === 'not_available') {
        fail('NOT_AVAILABLE', mine, sentToken, null);
      } else {
        fail(outcome.code, mine, sentToken, null);
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const updateRequest = (clientRequestId: string, change: Partial<ThreadsRequest>) =>
    setThreadsRequests((value) => value.map((item) => (item.clientRequestId === clientRequestId ? { ...item, ...change } : item)));

  const threadsCall = async (request: ThreadsRequest, op: () => Promise<StoreResult<ThreadsReceipt>>, done: string | null, isRead: boolean) => {
    if (inFlight.current || scope === null || request.scope !== scope || !(isRead ? canRead : usable)) return;
    inFlight.current = true;
    setBusy(true);
    const mine = scope;
    const sentToken = token;
    try {
      let result: StoreResult<ThreadsReceipt>;
      try { result = await op(); } catch { result = { ok: false, code: CLIENT_ERROR }; }
      if (result.ok) updateRequest(request.clientRequestId, { receipt: result.value, missing: false });
      else if (ports.actionOf(result.code) === 'not_found') updateRequest(request.clientRequestId, { missing: true });
      if (live.current !== mine) return;
      if (result.ok) {
        setBlockedScope((value) => (value === mine ? null : value));
        if (done) say(mine, done, 'success');
      } else {
        // the follow-up read runs once this call has finished
        fail(result.code, mine, sentToken, isRead ? null : () => { void Promise.resolve().then(() => readReceipt(request)); });
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  function readReceipt(request: ThreadsRequest) {
    if (!account) return;
    void threadsCall(request, () => ports.threads.receipt(account.id, request.clientRequestId), null, true);
  }
  const cancelThreads = (request: ThreadsRequest) => {
    if (!account || !request.receipt) return;
    const reservationId = request.receipt.reservationId;
    if (confirmCancel !== request.clientRequestId) { setConfirmCancel(request.clientRequestId); return; }
    void threadsCall(request, () => ports.threads.cancel(reservationId, account.id, request.clientRequestId), '予約を取り消しました。', false);
  };

  const shownNotice = notice && notice.scope === scope ? notice : null;
  const rows = xList && xList.scope === scope ? xList.rows : [];
  const mineRequests = threadsRequests.filter((item) => item.scope === scope);
  const disabled = !usable || busy;
  const readDisabled = !canRead || busy;
  const go = (button: ActionButtonKind) => {
    if (button === 'accounts') router.push('/accounts');
    if (button === 'settings') router.push('/(tabs)/settings');
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ gap: 16 }}>
        <SectionTitle detail="予約の状態の確認と、時刻の変更・取消をここで行います。投稿の実行はここからは行いません。">X・Threadsの予約</SectionTitle>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          {(['x', 'threads'] as const).map((item) => (
            <Chip key={item} label={item === 'x' ? 'X' : 'Threads'} selected={platform === item} disabled={busy}
              onPress={() => { setPlatform(item); setAccountId(null); setSelected(null); setConfirmCancel(null); }} />
          ))}
        </View>
        {candidates.length > 1 ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {candidates.map((item) => (
              <Chip key={item.id} label={item.profile.handle} selected={account?.id === item.id} disabled={busy}
                onPress={() => { setAccountId(item.id); setSelected(null); setConfirmCancel(null); }} />
            ))}
          </View>
        ) : null}

        {!enabled ? <Card><Pill tone="warning">{GATE_OFF_TEXT[platform]}</Pill></Card> : null}
        {refusal ? (
          <Card>
            <Pill tone="warning">{refusal}</Pill>
            <ActionButton label="アカウント画面を開く" onPress={() => go('accounts')} />
          </Card>
        ) : null}
        {loginRefused ? <Card><Pill tone="warning">{actionView('sign_in', platform).message}</Pill><ActionButton label="設定画面を開く" onPress={() => go('settings')} /></Card> : null}
        {shownNotice ? (
          <Card>
            <Pill tone={shownNotice.tone}>{shownNotice.text}</Pill>
            {shownNotice.button && !loginRefused ? <ActionButton label={shownNotice.button === 'accounts' ? 'アカウント画面を開く' : '設定画面を開く'} onPress={() => go(shownNotice.button)} /> : null}
          </Card>
        ) : null}

        {platform === 'x' ? (
          <>
            <Card>
              <Text style={{ color: colors.ink, fontWeight: '800' }}>新しいXの予約</Text>
              <Text style={styles.muted}>Xの予約は「予約」タブの作成画面で作ります。プレビューを確認してから保存します。</Text>
              <ActionButton label="作成画面を開く" onPress={() => router.push('/(tabs)/schedule')} />
            </Card>
            <ActionButton label="最新の状態を読み込む" disabled={readDisabled} onPress={rereadX} />
            {canRead && xList?.scope === scope && rows.length === 0 ? <Card><Text style={styles.muted}>このアカウントの予約はありません。</Text></Card> : null}
            {rows.map((row) => {
              const view = xRowView(row);
              const open = selected === row.reservationId;
              return (
                <Card key={row.reservationId}>
                  <Pressable accessibilityRole="button" accessibilityLabel={`予約 ${formatJst(row.scheduledAt)}`} onPress={() => { setSelected(open ? null : row.reservationId); setConfirmCancel(null); setTimeText(formatJst(row.scheduledAt)); }}>
                    <View style={{ gap: 4 }}>
                      <Text style={{ color: colors.ink, fontWeight: '700' }}>{formatJst(row.scheduledAt)}</Text>
                      <Pill tone={view.tone}>{view.label}</Pill>
                      {row.body ? <Text style={styles.muted} numberOfLines={open ? undefined : 2}>{row.body}</Text> : null}
                    </View>
                  </Pressable>
                  {open ? (
                    <View style={{ gap: 8 }}>
                      {view.detail ? <Text style={styles.muted}>{view.detail}</Text> : null}
                      {view.canReschedule ? (
                        <>
                          <Text style={styles.muted}>新しい日時（日本時間、例: 2026-11-01 09:30）</Text>
                          <TextInput accessibilityLabel="新しい日時" value={timeText} onChangeText={setTimeText} style={inputStyle} editable={!disabled} />
                          <ActionButton label="時刻を変更" disabled={disabled} onPress={() => reschedule(row)} />
                        </>
                      ) : null}
                      {view.needsReconfirm ? <ActionButton label="この本文で再確認する" disabled={disabled} onPress={() => reconfirm(row)} /> : null}
                      {view.canCancel ? (
                        <ActionButton label={confirmCancel === row.reservationId ? '本当に取り消す' : '予約を取り消す'} disabled={disabled} onPress={() => cancelX(row)} />
                      ) : null}
                    </View>
                  ) : null}
                </Card>
              );
            })}
          </>
        ) : (
          <>
            <Card>
              <Text style={{ color: colors.ink, fontWeight: '800' }}>新しいThreadsの予約</Text>
              <TextInput accessibilityLabel="Threadsの本文" value={threadsText} onChangeText={setThreadsText} style={[inputStyle, { minHeight: 84, textAlignVertical: 'top' }]} multiline maxLength={500} editable={!disabled} />
              <Text style={styles.muted}>日時（日本時間、例: 2026-11-01 09:30）</Text>
              <TextInput accessibilityLabel="Threadsの日時" value={threadsTime} onChangeText={setThreadsTime} style={inputStyle} editable={!disabled} />
              <ActionButton label={busy ? '送信中…' : 'Threadsに予約する'} disabled={disabled} onPress={() => void createThreads()} />
            </Card>
            {mineRequests.map((request) => {
              const view = request.missing
                ? { label: '予約は見つかりませんでした', tone: 'neutral' as const, detail: '保存されていません。必要なら、もう一度作成してください。', canCancel: false }
                : threadsReceiptView(request.receipt?.state ?? null);
              return (
                <Card key={request.clientRequestId}>
                  <Text style={{ color: colors.ink, fontWeight: '700' }}>{formatJst(request.scheduledAt)}</Text>
                  <Pill tone={view.tone}>{view.label}</Pill>
                  <Text style={styles.muted} numberOfLines={2}>{request.text}</Text>
                  {view.detail ? <Text style={styles.muted}>{view.detail}</Text> : null}
                  <ActionButton label="受領票を確認" disabled={readDisabled} onPress={() => readReceipt(request)} />
                  {view.canCancel ? <ActionButton label={confirmCancel === request.clientRequestId ? '本当に取り消す' : '予約を取り消す'} disabled={disabled} onPress={() => cancelThreads(request)} /> : null}
                </Card>
              );
            })}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

function Chip({ label, selected, onPress, disabled }: { label: string; selected: boolean; onPress: () => void; disabled: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected, disabled }} disabled={disabled} onPress={onPress}
      style={{ borderWidth: 1, borderColor: selected ? colors.primary : colors.border, backgroundColor: selected ? colors.primarySoft : colors.surface, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, opacity: disabled ? 0.4 : 1 }}>
      <Text style={{ color: selected ? colors.primary : colors.ink, fontWeight: selected ? '800' : '500' }}>{label}</Text>
    </Pressable>
  );
}
