
// ---- G1 TASK 48 (Issue #316): appended to G4's threads-connect-product-flow.e2e.mjs by tests/local-stack/run-threads-g1-flow.sh in a
// THROW-AWAY tree that has G4 PR #664 merged locally (never pushed; G4's file is changed by no PR). It reuses G4's world and helpers
// (real publish Edge over HTTP, attested SQL on disposable PostgreSQL 17, fake Threads that counts every write) and checks what G1's
// card is built on: the publish hook's answer to "確認する" under an expired credential (the code and the action the card turns into
// the requested copy and the reconnect entry), the same Threads account's reconnect, then a new read of the card's state.
test('36. G1 TASK 48: unknown outcome -> credential expired -> 確認する gives the card CREDENTIALS_EXPIRED for reconcile -> the same Threads account reconnects -> a new read shows the settled post; nothing is sent twice', { timeout: 180000 }, async (t) => {
  // G4's runner re-runs this file against its recovery mutants (expecting only 34 to fail); this scenario depends on that recovery.
  if (owner(`select count(*) from pg_proc where prosrc like '%-- MUTANT%'`) !== '0') { t.skip('a G4 recovery mutant is installed'); return; }
  const account = () => threadsAccount(F)?.id ?? null;
  const results = {};
  const p0 = writes(PUID_F, 'publish');
  const c0 = writes(PUID_F, 'container');
  try {
    results.start = await reconnectResult();
    threadsApi.plan[PUID_F] = { publish: 'lost' };
    const { card, view } = await readyCard();
    await view.publish(view.pin('G1第48 結果不明の投稿'));
    let shown = await card.settle();
    threadsApi.plan[PUID_F] = {};
    const lost = shown.answer.id;
    results.unknown = `${shown.answer.status}|${shown.context.mode}`;
    expireCredential(account());
    await shown.followUp('reconcile', shown.answer);
    shown = await card.settle();
    results.check = `${shown.message?.code}|${shown.message?.action}|${shown.message?.userId === shown.context.userId}|${shown.context.mode}`;
    results.stillOpen = statusError(lost);
    results.publishesBeforeRecovery = writes(PUID_F, 'publish') - p0;
    results.recovery = await reconnectResult();
    results.recovered = statusError(lost);
    // The account screen read the accounts again (its refreshKey): a fresh read of the card's state, as after the reconnect.
    const again = await publishScreen({ session: SESSION_F, account: appAccount(F) });
    const after = await again.settle();
    results.after = `${after.context.mode}|${after.server.kind === 'loaded' ? (after.server.last?.status ?? '-') : after.server.kind}|${after.message === null}`;
  } finally {
    threadsApi.plan[PUID_F] = {};
    results.publishes = writes(PUID_F, 'publish') - p0;
    results.containers = writes(PUID_F, 'container') - c0;
    console.log(`measured 36 (G1 TASK 48): ${JSON.stringify(results)}`);
  }
  assert.equal(results.start, 'verifying');
  assert.equal(results.unknown, 'uncertain|busy', 'unknown: the card blocks a new post');
  assert.equal(results.check, 'CREDENTIALS_EXPIRED|reconcile|true|busy', 'the card gets the code and the action it turns into the copy + reconnect entry');
  assert.equal(results.stillOpen.split('|')[0], 'uncertain', 'a refused check changes nothing');
  assert.equal(results.publishesBeforeRecovery, 1, 'the check sent nothing to Threads');
  assert.equal(results.recovery, 'verifying', 'the same Threads account reconnects');
  assert.equal(results.recovered, 'published_unidentified|PUBLISHED_POST_NOT_FOUND', 'settled from the container: posted, which post not provable');
  assert.equal(results.after, 'ready|published_unidentified|true', 'a new read: the settled post, a new post allowed, no stale refusal');
  assert.deepEqual([results.publishes, results.containers], [1, 1], 'one post, never resent');
  assert.deepEqual(denied, [], 'no request left this process');
});
