
// ---- G1 TASK 36: the REAL reservations screen + the REAL port builder over the real local runtime. Appended by run-x-disconnected.sh to the
// harness of tests/reservation-screens.test.mjs, so the screen is mounted exactly as there. React / RN are that harness's stubs: no device.
const LIVE_FETCH = globalThis.fetch;
const netlog = { actions: [], before: null, after: null };
const countingFetch = async (url, init) => {
  const action = JSON.parse(String(init?.body ?? '{}')).action ?? null;
  netlog.actions.push(action);
  if (netlog.before) await netlog.before(action);
  // The product's own URL check stays on: only the origin is swapped, at the fetch boundary, to the local twin.
  const answer = await LIVE_FETCH(stack.X_FUNCTION, init);
  if (netlog.after) await netlog.after(action);
  return answer;
};
const writesSent = () => netlog.actions.filter((a) => ['create', 'reschedule', 'reconfirm', 'cancel'].includes(a));
const portsFor = (world, gates = { x: true, threads: false }) => buildReservationPorts(gates, {
  supabaseUrl: 'https://local-stack.invalid',
  publishableKey: stack.PUBLISHABLE,
  fetch: countingFetch,
  session: { auth: { getSession: async () => ({ data: { session: world.token ? { access_token: world.token } : null }, error: null }) } },
});
const onScreenFor = async (p, { status = 'connected', account = p.account, brandId = p.workspace, gates } = {}) => {
  const box = { token: p.token };
  const store = { value: portsFor(box, gates) };
  const h = await mount({
    store,
    token: p.token,
    userId: p.userId,
    workspace: { kind: 'ready', workspaceId: p.workspace },
    accounts: [{ id: account, brandId, platform: 'x', connectionStatus: status, profile: { handle: '@me', displayName: 'me' } }],
  });
  h.setToken = (token) => { box.token = token; h.world.token = token; };
  h.setStatus = (next) => { h.world.accounts = h.world.accounts.map((item) => ({ ...item, connectionStatus: next })); };
  return h;
};
const openRow = async (h, index = 0) => {
  const rows = []; walk(await h.render(), (n) => { if (n.type === 'Pressable' && /^(予約|即時投稿) /u.test(n.props.accessibilityLabel ?? '')) rows.push(n.props); });
  assert.ok(rows[index], 'a row to open');
  rows[index].onPress();
  return h.render();
};
const shown = (tree) => texts(tree).join('\n');
const openRowOf = async (h, body) => {
  const rows = []; walk(await h.render(), (n) => { if (n.type === 'Pressable' && /^(予約|即時投稿) /u.test(n.props.accessibilityLabel ?? '') && texts(n).some((t) => t.includes(body))) rows.push(n.props); });
  assert.equal(rows.length, 1, `the row of ${body}`);
  rows[0].onPress();
  return h.render();
};
const soon = (days) => new Date(Date.now() + days * 86400e3).toISOString();
const pressButton = async (h, label) => { button(h.renderOnce(), label).onPress(); await settle(); return h.render(); };
test.beforeEach(() => { netlog.actions = []; netlog.before = null; netlog.after = null; });

test('stack: X connected -> G4 disconnect (real SQL): the column the app reads changes; list and get answer; the rows stay on the real screen; time change stays off; a cancel asks twice and goes once', async () => {
  const a = await stack.person('m1');
  const keep = await stack.saveRow(a, a.account, 'keep body');
  const gone = await stack.saveRow(a, a.account, 'cancel body');
  assert.equal(await stack.connectionStatus(a, a.account), 'identity_verified');
  const h = await onScreenFor(a);
  assert.ok(has(await h.render(), 'keep body'), 'connected: read');
  assert.equal(await stack.xDisconnect(a), 'done');
  const status = await stack.connectionStatus(a, a.account);
  assert.equal(status, 'unconnected', 'what G4\'s disconnect RPC leaves');
  assert.equal(stack.asAppStatus(status), 'needs_attention');
  const step = onboarding.deriveOnboardingStep({ kind: 'loaded', brandIds: [a.workspace], xAccounts: [{ id: a.account, brandId: a.workspace, handle: 'h', connectionStatus: status, lastConnectionErrorCode: null }], settings: 'saved', settingsDeferred: false });
  assert.deepEqual(step, { step: 'connect_x', resume: true });
  assert.equal(onboarding.canBrowseWithoutConnection(step), true, 'the connection step offers the app');

  netlog.actions = [];
  const gate = await onScreenFor(a, { status: stack.asAppStatus(status) });
  let tree = await gate.render();
  assert.ok(has(tree, 'keep body') && has(tree, 'cancel body'), shown(tree));
  assert.ok(has(tree, '既存の予約の確認と取消はできます'));
  assert.ok(!has(tree, 'このアカウントの予約はありません'));
  assert.deepEqual(netlog.actions.filter((x) => x === 'list').length > 0, true, 'the read really went');
  assert.equal(writesSent().length, 0);

  tree = await openRowOf(gate, 'cancel body');
  assert.equal(button(tree, '時刻を変更').disabled, true);
  button(tree, '予約を取り消す').onPress();
  await settle();
  tree = await gate.render();
  assert.equal(writesSent().length, 0, 'the first press only asks');
  assert.equal(await stack.rowState(gone.reservationId), 'planned/1/confirmed');
  tree = await pressButton(gate, '本当に取り消す');
  assert.deepEqual(writesSent(), ['cancel']);
  assert.match(await stack.rowState(gone.reservationId), /^cancelled\/2\//u);
  assert.equal(await stack.rowState(keep.reservationId), 'planned/1/confirmed', 'the other row is untouched');
  assert.ok(has(tree, '予約を取り消しました'), shown(tree));
});

test('stack: while disconnected the server itself allows list / get / cancel and refuses create / reschedule / reconfirm; nothing changes on a refusal', async () => {
  const a = await stack.person('m2');
  const row = await stack.saveRow(a, a.account, 'server body');
  const other = await stack.saveRow(a, a.account, 'server other');
  await stack.xDisconnect(a);
  assert.equal((await stack.http('list', { socialAccountId: a.account }, a.token)).code, '200 ok');
  assert.equal((await stack.http('get', { reservationId: row.reservationId }, a.token)).rows.length, 1);
  const body = 'new body';
  const refused = 'POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED';
  const before = await stack.rowCount(a.account);
  assert.equal((await stack.http('create', { socialAccountId: a.account, clientBatchId: randomUUID(), revision: 1, mode: 'manual_exact', band: null, items: [{ draft_id: 'g1t36_new', scheduled_at: new Date(Date.now() + 90 * 86400e3).toISOString(), body, consent: { confirmed: true, content_sha256: stack.sha256(body) } }] }, a.token)).code, `403 ${refused}`);
  assert.equal((await stack.http('reschedule', { reservationId: row.reservationId, expectedRevision: 1, scheduledAt: new Date(Date.now() + 91 * 86400e3).toISOString() }, a.token)).code, `403 ${refused}`);
  assert.equal((await stack.http('reconfirm', { reservationId: row.reservationId, expectedRevision: 1, contentSha256: stack.sha256('server body') }, a.token)).code, `403 ${refused}`);
  assert.equal(await stack.rowCount(a.account), before);
  assert.equal(await stack.rowState(row.reservationId), 'planned/1/confirmed');
  assert.deepEqual((await stack.http('cancel', { reservationId: other.reservationId, expectedRevision: 1 }, a.token)).rows.map((r) => r.status), ['cancelled']);
  assert.equal((await stack.http('cancel', { reservationId: other.reservationId, expectedRevision: 2 }, a.token)).code, '409 POSTONA_RESV_ALREADY_FINAL', 'a second cancel changes nothing');
  assert.match(await stack.rowState(other.reservationId), /^cancelled\/2\//u);
});

test('stack: a stale screen that still says connected: the server refuses the time change; the screen never says it changed; 再接続 is recorded; the cancel still goes; after a reconnect writes work', async () => {
  const a = await stack.person('m3');
  const row = await stack.saveRow(a, a.account, 'stale body');
  const h = await onScreenFor(a);
  let tree = await openRow(h);
  await stack.xDisconnect(a);
  field(tree, '新しい日時').onChangeText('2027-06-01 10:00');
  tree = await pressButton(h, '時刻を変更');
  assert.deepEqual(writesSent(), ['reschedule']);
  assert.equal(await stack.rowState(row.reservationId), 'planned/1/confirmed');
  assert.ok(has(tree, 'Xの再接続が必要です'), shown(tree));
  assert.ok(!has(tree, '日時を変更しました') && !has(tree, '時刻を変更しました'), shown(tree));
  assert.equal(reconnectSignal.isXReconnectRequired(a.account), true);
  assert.equal(button(tree, '時刻を変更').disabled, true);
  await stack.xConnect(a, 'm3b', `${a.puid}`);
  reconnectSignal.clearAllXReconnectRequired();
  assert.equal(await stack.connectionStatus(a, a.account), 'identity_verified');
  assert.equal((await stack.http('reschedule', { reservationId: row.reservationId, expectedRevision: 1, scheduledAt: soon(10) }, a.token)).code, '200 ok');
});

test('stack: the row was cancelled on another device: the screen is refused (409 final), says no success, re-reads and shows it cancelled; one cancel only', async () => {
  const a = await stack.person('m4');
  const row = await stack.saveRow(a, a.account, 'final body');
  await stack.xDisconnect(a);
  const h = await onScreenFor(a, { status: 'needs_attention' });
  await openRow(h);
  assert.equal((await stack.http('cancel', { reservationId: row.reservationId, expectedRevision: 1 }, a.token)).rows[0].status, 'cancelled');
  await pressButton(h, '予約を取り消す');
  const tree = await pressButton(h, '本当に取り消す');
  assert.deepEqual(writesSent(), ['cancel']);
  assert.ok(!has(tree, '予約を取り消しました'), shown(tree));
  assert.ok(has(tree, '取消済み'), shown(tree));
  assert.match(await stack.rowState(row.reservationId), /^cancelled\/2\//u, 'one revision only');
});

test('stack: the answer of a real cancel is lost: the store\'s read-back decides; with the read-back lost too it is not called a success, and the next read shows what the server did. The request never left: nothing changed', async () => {
  const a = await stack.person('m5');
  const row = await stack.saveRow(a, a.account, 'answer gone');
  const both = await stack.saveRow(a, a.account, 'both gone');
  const safe = await stack.saveRow(a, a.account, 'down body');
  await stack.xDisconnect(a);
  const h = await onScreenFor(a, { status: 'needs_attention' });
  await openRowOf(h, 'answer gone');
  await pressButton(h, '予約を取り消す');
  netlog.after = async (action) => { if (action === 'cancel') { netlog.after = null; throw new TypeError('network lost after the write'); } };
  let tree = await pressButton(h, '本当に取り消す');
  assert.match(await stack.rowState(row.reservationId), /^cancelled\/2\//u, 'the server did it');
  assert.ok(has(tree, '予約を取り消しました'), `the read-back confirmed it: ${shown(tree)}`);
  assert.deepEqual(netlog.actions.slice(-2), ['cancel', 'get'], 'the same request is never sent twice; it reads');

  await openRowOf(h, 'both gone');
  await pressButton(h, '予約を取り消す');
  netlog.after = async (action) => { if (action === 'cancel') { netlog.after = null; netlog.before = async () => { throw new TypeError('network down'); }; throw new TypeError('network lost after the write'); } };
  tree = await pressButton(h, '本当に取り消す');
  netlog.before = null;
  assert.match(await stack.rowState(both.reservationId), /^cancelled\/2\//u, 'the server did it');
  assert.ok(!has(tree, '予約を取り消しました'), shown(tree));
  assert.ok(has(tree, '確認できませんでした'), shown(tree));
  tree = await pressButton(h, '最新の状態を読み込む');
  assert.ok(has(tree, '取消済み'), shown(tree));
  assert.ok(!has(tree, '確認できませんでした'), 'the old warning goes with the good read');

  const down = await onScreenFor(a, { status: 'needs_attention' });
  netlog.before = async () => { throw new TypeError('network down'); };
  tree = await down.render();
  assert.ok(!has(tree, 'このアカウントの予約はありません'), shown(tree));
  assert.ok(has(tree, '予約があるかどうかを確認できていません'), shown(tree));
  assert.ok(!has(tree, 'down body'));
  netlog.before = null;
  tree = await pressButton(down, '最新の状態を読み込む');
  assert.ok(has(tree, 'down body'), shown(tree));
  assert.equal(await stack.rowState(safe.reservationId), 'planned/1/confirmed');
});

test('stack: a signed-out session: the real server answers 401; the screen stops reads and the cancel for that token, with the sign-out there; a new sign-in reads and cancels', async () => {
  const a = await stack.person('m6');
  const row = await stack.saveRow(a, a.account, 'session body');
  await stack.xDisconnect(a);
  const second = await stack.signIn(a);
  await stack.signOut(second);
  assert.equal((await stack.http('list', { socialAccountId: a.account }, second.token)).code, '401 AUTH_REQUIRED');
  assert.equal((await stack.http('cancel', { reservationId: row.reservationId, expectedRevision: 1 }, second.token)).code, '401 AUTH_REQUIRED');
  assert.equal(await stack.rowState(row.reservationId), 'planned/1/confirmed');

  const h = await onScreenFor(second, { status: 'needs_attention' });
  let tree = await h.render();
  assert.ok(has(tree, 'ログインの有効期限が切れた'), shown(tree));
  assert.ok(!has(tree, 'このアカウントの予約はありません'), shown(tree));
  assert.ok(!has(tree, 'session body'));
  let signOuts = 0; walk(tree, (n) => { if (n.type === 'SignOutButton') signOuts += 1; });
  assert.equal(signOuts, 1);
  const count = netlog.actions.length;
  assert.equal(button(tree, '最新の状態を読み込む').disabled, true);
  await h.render();
  assert.equal(netlog.actions.length, count, 'nothing more with that token');

  const third = await stack.signIn(a);
  h.setToken(third.token);
  tree = await h.render();
  assert.ok(has(tree, 'session body'), shown(tree));
  tree = await openRow(h);
  await pressButton(h, '予約を取り消す');
  await pressButton(h, '本当に取り消す');
  assert.match(await stack.rowState(row.reservationId), /^cancelled\/2\//u);
});

test('stack: another person: list 200 empty, get / cancel / reschedule 404, nothing changes; the real screen with a spoofed account shows none of it; another workspace is refused before a request', async () => {
  const a = await stack.person('m7');
  const b = await stack.person('m7b');
  const row = await stack.saveRow(a, a.account, 'private body');
  for (const disconnected of [false, true]) {
    if (disconnected) await stack.xDisconnect(a);
    const list = await stack.http('list', { socialAccountId: a.account }, b.token);
    assert.deepEqual([list.code, list.rows.length], ['200 ok', 0]);
    assert.equal((await stack.http('get', { reservationId: row.reservationId }, b.token)).code, '404 POSTONA_RESV_NOT_FOUND');
    assert.equal((await stack.http('cancel', { reservationId: row.reservationId, expectedRevision: 1 }, b.token)).code, '404 POSTONA_RESV_NOT_FOUND');
    assert.equal((await stack.http('reschedule', { reservationId: row.reservationId, expectedRevision: 1, scheduledAt: new Date(Date.now() + 93 * 86400e3).toISOString() }, b.token)).code, '404 POSTONA_RESV_NOT_FOUND');
    assert.equal(await stack.rowState(row.reservationId), 'planned/1/confirmed');
  }
  const spoofed = await onScreenFor(b, { account: a.account, status: 'needs_attention' });
  const tree = await spoofed.render();
  assert.ok(!has(tree, 'private body'), shown(tree));
  assert.ok(netlog.actions.includes('list'), 'the request went; the server gave nothing');
  netlog.actions = [];
  const shared = await onScreenFor(b, { account: a.account, brandId: a.workspace, status: 'needs_attention' });
  assert.ok(has(await shared.render(), 'ご自身の個人ワークスペース'));
  assert.deepEqual(netlog.actions, [], 'another workspace: no request');
});

test('stack: service end (SYNTHETIC row): list / get / cancel answer, create / reschedule / reconfirm 403; the screen says so; restart (G5 real RPC): what the old connection can do is recorded', async () => {
  const a = await stack.person('m8');
  const row = await stack.saveRow(a, a.account, 'ended body');
  const other = await stack.saveRow(a, a.account, 'ended other');
  const lifecycleBefore = await stack.lifecycleOf(a);
  await stack.endService(a);
  const refused = 'POSTONA_RESV_SERVICE_NOT_ACTIVE';
  assert.equal((await stack.http('list', { socialAccountId: a.account }, a.token)).code, '200 ok');
  assert.equal((await stack.http('reschedule', { reservationId: row.reservationId, expectedRevision: 1, scheduledAt: new Date(Date.now() + 94 * 86400e3).toISOString() }, a.token)).code, `403 ${refused}`);
  assert.equal((await stack.http('reconfirm', { reservationId: row.reservationId, expectedRevision: 1, contentSha256: stack.sha256('ended body') }, a.token)).code, `403 ${refused}`);
  const h = await onScreenFor(a);
  let tree = await openRow(h);
  field(tree, '新しい日時').onChangeText('2027-06-02 10:00');
  tree = await pressButton(h, '時刻を変更');
  assert.ok(!has(tree, '時刻を変更しました'), shown(tree));
  assert.ok(button(tree, '設定画面を開く'), 'the way to the service');
  assert.equal(await stack.rowState(row.reservationId), 'planned/1/confirmed');
  await pressButton(h, '予約を取り消す');
  tree = await pressButton(h, '本当に取り消す');
  assert.match(await stack.rowState(row.reservationId), /^cancelled\/2\//u, 'cancel during a service end');
  assert.ok(has(tree, '予約を取り消しました'), shown(tree));

  const asked = await stack.rpc('start_x_autopost_service', a.token);
  console.log('OBSERVED start after end:', JSON.stringify(asked.body));
  assert.equal(asked.body.status, 'reenroll_required', 'the app never restarts by itself');
  const restarted = await stack.rpc('reactivate_x_autopost_service', a.token, { p_expected_lifecycle_version: asked.body.lifecycle_version });
  console.log('OBSERVED restart:', JSON.stringify(restarted.body));
  assert.equal(restarted.body.status, 'active');
  const lifecycleAfter = await stack.lifecycleOf(a);
  console.log('OBSERVED lifecycle:', lifecycleBefore, '->', lifecycleAfter);
  const status = await stack.connectionStatus(a, a.account);
  console.log('OBSERVED connection_status after the restart:', status);
  const afterRestart = await stack.http('reschedule', { reservationId: other.reservationId, expectedRevision: 1, scheduledAt: soon(11) }, a.token);
  console.log('OBSERVED old connection, reschedule after the restart:', afterRestart.code);
  // The app's answer to this gap: an observed restart stops its own writes, and only those.
  reconnectSignal.markXServiceRestarted(a.userId);
  netlog.actions = [];
  const again = await onScreenFor(a, { status: stack.asAppStatus(status) });
  tree = await again.render();
  assert.ok(has(tree, 'X自動投稿を再開しました'), shown(tree));
  tree = await openRowOf(again, 'ended other');
  assert.equal(button(tree, '時刻を変更').disabled, true);
  await pressButton(again, '予約を取り消す');
  await pressButton(again, '本当に取り消す');
  assert.deepEqual(writesSent(), ['cancel']);
  reconnectSignal.clearXServiceRestarted(a.userId);
});

test('stack, with G3 #624: after a restart, before and after a reconnect: 403 then 409 for a pre-restart row; the real screen says so, keeps the cancel; a new row works', { skip: process.env.G1T37_G3_624 === '1' ? false : 'needs G3 PR #624 in the tree' }, async () => {
  const a = await stack.person('m10');
  const row = await stack.saveRow(a, a.account, 'before restart');
  const gone = await stack.saveRow(a, a.account, 'before restart cancel');
  await stack.endService(a);
  const asked = await stack.rpc('start_x_autopost_service', a.token);
  assert.equal((await stack.rpc('reactivate_x_autopost_service', a.token, { p_expected_lifecycle_version: asked.body.lifecycle_version })).body.status, 'active');
  assert.equal(await stack.connectionStatus(a, a.account), 'identity_verified', 'the column cannot say');
  const notVerified = '403 POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED';
  const moved = { reservationId: row.reservationId, expectedRevision: 1, scheduledAt: soon(12) };
  const sum = { reservationId: row.reservationId, expectedRevision: 1, contentSha256: stack.sha256('before restart') };
  assert.equal((await stack.http('reschedule', moved, a.token)).code, notVerified);
  assert.equal((await stack.http('reconfirm', sum, a.token)).code, notVerified);
  assert.equal((await stack.http('list', { socialAccountId: a.account }, a.token)).code, '200 ok');

  // Another device restarted: this screen saw nothing, still says connected, and the server's 403 is what it learns from.
  const h = await onScreenFor(a);
  let tree = await openRowOf(h, 'before restart cancel');
  field(tree, '新しい日時').onChangeText('2026-11-20 10:00');
  tree = await pressButton(h, '時刻を変更');
  assert.ok(has(tree, 'Xの再接続が必要です'), shown(tree));
  assert.ok(!has(tree, '時刻を変更しました'), shown(tree));
  assert.equal(await stack.rowState(gone.reservationId), 'planned/1/confirmed');
  reconnectSignal.clearAllXReconnectRequired();

  await stack.xConnect(a, 'm10b', a.puid);
  assert.equal((await stack.http('reschedule', moved, a.token)).code, '409 POSTONA_RESV_NOT_PLANNED');
  assert.equal((await stack.http('reconfirm', sum, a.token)).code, '409 POSTONA_RESV_NOT_PLANNED');
  assert.equal(await stack.rowState(row.reservationId), 'planned/1/confirmed', 'still reads planned: the list cannot say');

  const after = await onScreenFor(a);
  tree = await openRowOf(after, 'before restart cancel');
  assert.ok(texts(tree).includes('予約済み'), 'nothing to tell it by yet');
  field(tree, '新しい日時').onChangeText('2026-11-20 10:00');
  netlog.actions = [];
  tree = await pressButton(after, '時刻を変更');
  assert.deepEqual(writesSent(), ['reschedule'], 'once');
  assert.ok(has(tree, 'サーバーがこの予約の変更を受け付けませんでした'), shown(tree));
  assert.ok(has(tree, '変更できない予約'), shown(tree));
  assert.equal(buttons(tree, '時刻を変更').length, 0);
  await pressButton(after, '予約を取り消す');
  tree = await pressButton(after, '本当に取り消す');
  assert.match(await stack.rowState(gone.reservationId), /^cancelled\/2\//u, 'the old row can still be cancelled');
  assert.ok(has(tree, '取消済み'), shown(tree));
  assert.equal(await stack.rowState(row.reservationId), 'planned/1/confirmed');
  const fresh = await stack.saveRow(a, a.account, 'after reconnect');
  assert.equal((await stack.http('reschedule', { reservationId: fresh.reservationId, expectedRevision: 1, scheduledAt: soon(13) }, a.token)).code, '200 ok', 'a new row works');
  const b = await stack.person('m10c');
  assert.equal((await stack.http('cancel', { reservationId: row.reservationId, expectedRevision: 1 }, b.token)).code, '404 POSTONA_RESV_NOT_FOUND');
});

test('stack: gates OFF (the build\'s stores) on a real session: no fetch, no token read, no write', async () => {
  const a = await stack.person('m9');
  const h = await onScreenFor(a, { gates: { x: POSTONA_RESERVATION_PERSISTENCE_ENABLED, threads: POSTONA_THREADS_RESERVATION_PERSISTENCE_ENABLED } });
  assert.equal(POSTONA_RESERVATION_PERSISTENCE_ENABLED, false);
  const tree = await h.render();
  assert.deepEqual(netlog.actions, []);
  assert.ok(button(tree, '最新の状態を読み込む').disabled);
});
