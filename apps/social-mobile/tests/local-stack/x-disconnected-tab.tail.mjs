
// ---- G1 TASK 36: the REAL 投稿予定 tab (schedule.tsx) + G3's REAL store over the real local runtime. Appended by run-x-disconnected.sh to the
// harness of tests/x-reservation-composer.test.mjs. React / RN are that harness's stubs; the composer is a stub that hands over the planner's result.
const forward = async (call) => {
  const r = await REAL_FETCH(stack.X_FUNCTION, { method: 'POST', headers: { apikey: stack.PUBLISHABLE, authorization: call.token, 'content-type': 'application/json' }, body: JSON.stringify(call.body) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
const onTab = (p, { status = 'connected', hook = forward, gate = true } = {}) => screen({ gate, reply: hook, account: { ...ACCOUNT, id: p.account, brandId: p.workspace, connectionStatus: status }, workspaceId: p.workspace, token: p.token, userId: p.userId });
const cards = (h) => { const out = []; walk(h.render(), (n) => { if (n.type === 'ServerReservationCard') out.push(n.props); }); return out; };
const titles = (h) => { const out = []; walk(h.render(), (n) => { if (n.type === 'EmptyState') out.push(n.props.title); }); return out; };
const sent = (h, action) => h.world.calls.filter((c) => c.body?.action === action).length;
const text = (h) => textOf(h.render());

test('stack tab: disconnected: rows are read and shown, no false empty; a save and a time change stop before a request; a cancel asks twice and goes once', async () => {
  const a = await stack.person('t1');
  const row = await stack.saveRow(a, a.account, 'tab body');
  await stack.xDisconnect(a);
  const h = await onTab(a, { status: 'needs_attention' });
  await h.update();
  assert.equal(sent(h, 'list') > 0, true);
  assert.equal(cards(h).length, 1, text(h));
  assert.deepEqual(titles(h), []);
  assert.match(text(h), /既存の予約の確認と取消はできます/u);
  await planOne(h, 'tab new', randomUUID(), 60);
  await confirmAll(h);
  assert.equal(saveButton(h).disabled, true);
  cards(h)[0].onRetime(); await h.update();
  cards(h)[0].onRetimeApply(); await settle(); await h.update();
  assert.equal(sent(h, 'reschedule'), 0);
  cards(h)[0].onCancel(); await settle(); await h.update();
  assert.equal(sent(h, 'cancel'), 0, 'the first press asks');
  assert.equal(await stack.rowState(row.reservationId), 'planned/1/confirmed');
  cards(h)[0].onCancel(); await settle(); await settle(); await h.update();
  assert.equal(sent(h, 'cancel'), 1);
  assert.match(await stack.rowState(row.reservationId), /^cancelled\/2\//u);
  assert.match(text(h), /予約を取り消しました/u, text(h));
});

test('stack tab: a stale screen that still says connected: the server refuses the save; no success words; nothing stored', async () => {
  const a = await stack.person('t2');
  const h = await onTab(a);
  await h.update();
  assert.deepEqual(titles(h), ['投稿予定はありません'], 'really read, really empty');
  await planOne(h, 'stale save', randomUUID(), 61);
  await confirmAll(h);
  await stack.xDisconnect(a);
  await pressSave(h);
  assert.equal(sent(h, 'create'), 1);
  assert.equal(await stack.rowCount(a.account), '0');
  assert.match(text(h), /Xの再接続が必要です/u, text(h));
  assert.doesNotMatch(text(h), /一致を確認しました/u);
  assert.equal(signal.isXReconnectRequired(a.account), true);
  signal.clearAllXReconnectRequired();
});

test('stack tab: a signed-out session: the real 401; no false empty, no cancel, the sign-out is there; the network down: no false empty', async () => {
  const a = await stack.person('t3');
  await stack.saveRow(a, a.account, 'session tab');
  const second = await stack.signIn(a);
  await stack.signOut(second);
  const h = await onTab(second, { status: 'needs_attention' });
  await h.update();
  assert.equal(cards(h).length, 0);
  assert.deepEqual(titles(h), []);
  let signOuts = 0; walk(h.render(), (n) => { if (n.type === 'SignOutButton') signOuts += 1; });
  assert.equal(signOuts, 1, text(h));
  const down = await onTab(a, { hook: async () => 'lost' });
  await down.update();
  assert.deepEqual(titles(down), []);
  assert.match(text(down), /サーバーの予約を読み込めませんでした/u);
});

test('stack tab: another person with a spoofed account: none of the rows, and the cancel of a known id answers 404', async () => {
  const a = await stack.person('t4');
  const b = await stack.person('t4b');
  const row = await stack.saveRow(a, a.account, 'private tab');
  await stack.xDisconnect(a);
  const h = await onTab({ ...b, account: a.account });
  await h.update();
  assert.equal(cards(h).length, 0);
  assert.doesNotMatch(text(h), /private tab/u);
  assert.equal((await stack.http('cancel', { reservationId: row.reservationId, expectedRevision: 1 }, b.token)).code, '404 POSTONA_RESV_NOT_FOUND');
  assert.equal(await stack.rowState(row.reservationId), 'planned/1/confirmed');
});

test('stack tab: gate OFF on a real session: no fetch, no token read', async () => {
  const a = await stack.person('t5');
  const h = await onTab(a, { gate: false });
  await h.update();
  assert.deepEqual([h.world.calls.length, h.world.sessionReads], [0, 0]);
});
