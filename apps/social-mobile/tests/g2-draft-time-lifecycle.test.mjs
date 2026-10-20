// G2 QA (Issue #317, task postona-g2-draft-expiry-logout-session-transition-qa-20261020) -- QA only, no product code.
// Adds what PR #380 (g2-draft-session-boundary.test.mjs, 13 tests) does not cover: the exact 24-hour boundary, clock
// changes, an app restart after a long stop, which device-storage keys are touched, a late INITIAL_SESSION, a refresh
// during a pending restore, the orders of an old restore that finishes FIRST, and what sign-out / account deletion leave
// behind. Real route + screen + draft store of PR #366; MOCK sessions (see g2-draft-harness.mjs); dummy values only.
//
// Naming as in PR #380: "G2-L.." holds today. "KNOWN SM4" / "FINDING .." pass while the gap exists, FAIL once fixed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createApp, deviceKV, mockAuth, mutate, mutatedDraftModule, ROUTE_SOURCE, DKEY, T0, SECOND, MINUTE, HOUR } from './g2-draft-harness.mjs';

const DAY = 24 * HOUR;
const TEXT = '期限確認用の下書き';

/** Type a draft at clock T0 in session s1, leave, move the clock, open again. */
async function reopenAfter(offset, opts = {}) {
  const auth = mockAuth();
  const clock = { t: T0 };
  const app = await createApp({ ...opts, clock });
  await app.auth(auth.signIn('UA'));
  await app.open();
  await app.type(TEXT);
  app.leave();
  clock.t = T0 + offset;
  await app.open();
  return { draft: app.draft(), record: app.record('UA') };
}

/** Restore at T0+23h (only looked at), leave, open again at T0+24h+1s. */
async function viewThenReopen(opts = {}) {
  const auth = mockAuth();
  const clock = { t: T0 };
  const app = await createApp({ ...opts, clock });
  await app.auth(auth.signIn('UA'));
  await app.open();
  await app.type(TEXT);
  app.leave();
  clock.t = T0 + 23 * HOUR;
  await app.open();
  const viewed = app.draft();
  app.leave();
  clock.t = T0 + DAY + SECOND;
  await app.open();
  return { viewed, draft: app.draft(), record: app.record('UA') };
}

/** A writes; A signs out; B signs in and uses the screen (type, empty, reopen). Returns every key B's visit touched. */
async function keysTouchedByB(opts = {}) {
  const auth = mockAuth();
  const kv = deviceKV();
  const app = await createApp({ ...opts, kv });
  await app.auth(auth.signIn('UA'));
  await app.open();
  await app.type('Aさんの本文');
  app.leave();
  const aBefore = kv.data.get(DKEY('UA'));
  await app.auth(null);
  await app.auth(auth.signIn('UB'));
  kv.log.length = 0;
  await app.open();
  await app.type('Bさんの本文');
  await app.type('');
  await app.type('Bさんの2つ目');
  app.leave();
  await app.open();
  return { keys: [...new Set(kv.log.map(([, key]) => key))], aSame: kv.data.get(DKEY('UA')) === aBefore, draftB: app.draft() };
}

// ---- time ---------------------------------------------------------------------------------------------------------------

test('G2-L1 24-hour boundary after the last edit: 23:59:59 and 24:00:00 come back; 24:00:01 is discarded and removed', async () => {
  for (const [offset, kept] of [[DAY - SECOND, true], [DAY, true], [DAY + SECOND, false], [DAY + 1, false]]) {
    const seen = await reopenAfter(offset);
    assert.equal(seen.draft, kept ? TEXT : '', `offset ${offset}`);
    assert.equal(seen.record === null, !kept, `record at offset ${offset}`);
  }
});

test('G2-L2 only looking at a restored draft does not extend it; editing does (24 hours count from the last edit)', async () => {
  const seen = await viewThenReopen();
  assert.equal(seen.viewed, TEXT);
  assert.equal(seen.draft, '', 'viewed at 23h, gone at 24h+1s');
  assert.equal(seen.record, null);

  const auth = mockAuth();
  const clock = { t: T0 };
  const app = await createApp({ clock });
  await app.auth(auth.signIn('UA'));
  await app.open();
  await app.type(TEXT);
  app.leave();
  clock.t = T0 + 23 * HOUR;
  await app.open();
  await app.type(`${TEXT}。`);
  app.leave();
  clock.t = T0 + DAY + SECOND;
  await app.open();
  assert.equal(app.draft(), `${TEXT}。`, 'edited at 23h: still there 1h later');
});

test('G2-L3 clock moved back or far forward: within 5 minutes back it is kept; more than that, or a year ahead, is discarded and removed (fail closed)', async () => {
  for (const [offset, kept] of [[-4 * MINUTE, true], [-6 * MINUTE, false], [-3 * DAY, false], [365 * DAY, false]]) {
    const seen = await reopenAfter(offset);
    assert.equal(seen.draft, kept ? TEXT : '', `offset ${offset}`);
    assert.equal(seen.record === null, !kept, `record at offset ${offset}`);
  }
  // written while the device clock was a year ahead, read after it was corrected
  const auth = mockAuth();
  const clock = { t: T0 + 365 * DAY };
  const app = await createApp({ clock });
  await app.auth(auth.signIn('UA'));
  await app.open();
  await app.type(TEXT);
  app.leave();
  clock.t = T0;
  await app.open();
  assert.equal(app.draft(), '');
  assert.equal(app.record('UA'), null);
});

test('G2-L4 app restart: after 23 hours stopped it comes back; after 48 hours it is discarded and removed when the screen opens', async () => {
  for (const [stopped, kept] of [[23 * HOUR, true], [48 * HOUR, false]]) {
    const auth = mockAuth();
    const first = await createApp({ clock: { t: T0 } });
    const s1 = auth.signIn('UA');
    await first.auth(s1);
    await first.open();
    await first.type(TEXT);
    first.leave();
    const second = await createApp({ kv: first.kv, clock: { t: T0 + stopped } }); // a new process, same storage
    await second.auth(s1); // the stored session, announced as it was stored (auth-js 2.115.0 _recoverAndRefresh)
    await second.open();
    assert.equal(second.draft(), kept ? TEXT : '', `stopped ${stopped}`);
    assert.equal(second.record('UA') === null, !kept);
  }
});

test('KNOWN SM4 (not re-reported): nothing removes an expired draft at start-up -- after 48 hours stopped it is still on the device until the screen is opened', async () => {
  const auth = mockAuth();
  const first = await createApp({ clock: { t: T0 } });
  const s1 = auth.signIn('UA');
  await first.auth(s1);
  await first.open();
  await first.type(TEXT);
  first.leave();
  const second = await createApp({ kv: first.kv, clock: { t: T0 + 48 * HOUR } });
  await second.auth(s1); // started and signed in, but the manual post screen is not opened
  assert.equal(second.record('UA')?.text, TEXT);
});

// ---- storage keys and late answers -----------------------------------------------------------------------------------

test('G2-L5 a visit of B reads, writes and removes only B\'s key; A\'s stored bytes are untouched', async () => {
  const seen = await keysTouchedByB();
  assert.deepEqual(seen.keys, [DKEY('UB')]);
  assert.equal(seen.aSame, true);
  assert.equal(seen.draftB, 'Bさんの2つ目');
});

test('G2-L6 late INITIAL_SESSION: a screen opened before the session is known touches no draft, and restores once the session arrives', async () => {
  const auth = mockAuth();
  const first = await createApp();
  const s1 = auth.signIn('UA');
  await first.auth(s1);
  await first.open();
  await first.type(TEXT);
  first.leave();
  const second = await createApp({ kv: first.kv });
  first.kv.log.length = 0;
  await second.open(); // no session yet
  assert.equal(second.draft(), '');
  assert.deepEqual(first.kv.log, [], 'the signed-out screen does not touch any draft');
  await second.auth(s1); // INITIAL_SESSION arrives
  assert.equal(second.draft(), TEXT);
});

test('G2-L7 TOKEN_REFRESHED (same mark) while the restore read is pending: no second read, nothing removed, restored', async () => {
  const auth = mockAuth();
  const kv = deviceKV();
  const app = await createApp({ kv });
  const s1 = auth.signIn('UA');
  await app.auth(s1);
  await app.open();
  await app.type(TEXT);
  app.leave();
  kv.hold(true);
  kv.log.length = 0;
  await app.open();
  assert.equal(kv.heldCount(), 1);
  await app.auth(auth.refresh(s1));
  assert.equal(kv.heldCount(), 1, 'the refresh did not start another read');
  kv.hold(false);
  kv.release();
  await app.sync();
  assert.equal(app.draft(), TEXT);
  assert.deepEqual(kv.log.filter(([op]) => op !== 'get'), [], 'nothing written or removed');
});

test('G2-L8 an old restore that is left pending when the screen is closed, then the screen is opened again: restored exactly once, by the new screen', async () => {
  const auth = mockAuth();
  const kv = deviceKV();
  const app = await createApp({ kv });
  await app.auth(auth.signIn('UA'));
  await app.open();
  await app.type(TEXT);
  app.leave();
  kv.hold(true);
  await app.open();
  assert.equal(kv.heldCount(), 1);
  app.leave(); // closed before the read answered
  kv.hold(false);
  await app.open(); // its read waits behind the old one (the store applies calls in order)
  assert.equal(kv.heldCount(), 1);
  kv.release();
  await app.sync();
  await app.sync();
  assert.equal(app.draft(), TEXT);
  assert.equal(app.record('UA')?.text, TEXT);
});

test('G2-L9 an old restore that answered FIRST, then another person / sign-out: nothing of A is shown afterwards; A\'s next new session discards it', async () => {
  for (const next of ['other', 'signed-out']) {
    const auth = mockAuth();
    const app = await createApp();
    await app.auth(auth.signIn('UA'));
    await app.open();
    await app.type(TEXT);
    app.leave();
    await app.open();
    assert.equal(app.draft(), TEXT, `${next}: restored in A's session first`);
    await app.auth(next === 'other' ? auth.signIn('UB') : null);
    assert.equal(app.draft(), '', next);
    assert.equal(app.record('UB'), null, next);
    assert.equal(app.record('UA')?.text, TEXT, `${next}: A's record is left alone`);
    app.leave();
    await app.auth(null);
    await app.auth(auth.signIn('UA')); // A again: a new session
    await app.open();
    assert.equal(app.draft(), '', next);
    assert.equal(app.record('UA'), null, next);
  }
});

test('G2-L10 while A\'s old read is pending, B signs in and opens: B\'s read is only issued after A\'s answered, and B sees nothing of A', async () => {
  const auth = mockAuth();
  const kv = deviceKV();
  const app = await createApp({ kv });
  await app.auth(auth.signIn('UA'));
  await app.open();
  await app.type(TEXT);
  app.leave();
  kv.hold(true);
  await app.open();
  await app.auth(null);
  kv.log.length = 0;
  await app.auth(auth.signIn('UB'));
  assert.deepEqual(kv.log.filter(([, key]) => key === DKEY('UB')), [], "B's read waits for A's");
  kv.hold(false);
  kv.release();
  await app.sync();
  await app.sync();
  assert.equal(app.draft(), '');
  assert.equal(app.record('UA')?.text, TEXT);
});

test('G2-L11 a day: A types, signs out; B types, signs out; A signs in the next day (new session): A gets nothing and A\'s text is removed', async () => {
  const auth = mockAuth();
  const clock = { t: T0 };
  const app = await createApp({ clock });
  await app.auth(auth.signIn('UA'));
  await app.open();
  await app.type('Aさんの朝の下書き');
  app.leave();
  await app.auth(null);
  clock.t = T0 + HOUR;
  await app.auth(auth.signIn('UB'));
  await app.open();
  await app.type('Bさんの下書き');
  app.leave();
  await app.auth(null);
  clock.t = T0 + 25 * HOUR;
  await app.auth(auth.signIn('UA'));
  await app.open();
  assert.equal(app.draft(), '');
  assert.equal(app.record('UA'), null);
  assert.equal(app.record('UB')?.text, 'Bさんの下書き', "KNOWN SM4: B's text stays after B signed out, past 24 hours");
});

// ---- what sign-out and account deletion leave behind (static + mock) --------------------------------------------------

test('FINDING G2-SM4-D (P3, new condition, owner G1/G5): account deletion forgets "per-user state" but not the draft, and a deleted person never reads it again -- so it stays for good', async () => {
  const provider = await readFile(new URL('../src/providers/auth-provider.tsx', import.meta.url), 'utf8');
  const start = provider.indexOf("// The server confirmed: forget this device's session and per-user state.");
  assert.ok(start > 0, 'the deletion clean-up block exists');
  const block = provider.slice(start, provider.indexOf('setDeletionNotice(', start));
  assert.match(block, /AsyncStorage\.removeItem\(onboardingStorageKey\(/u, 'it removes the onboarding state');
  assert.doesNotMatch(block, /manual-publish|draftStore|draftKeyOf|attemptStore|storeKeyOf/u, 'and nothing of the manual post');
  // Nothing outside the screen removes a draft (no sign-out, deletion or start-up clean-up).
  const { readdir } = await import('node:fs/promises');
  const users = [];
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dir);
      if (entry.isDirectory()) await walk(path);
      else if (/\.(ts|tsx)$/u.test(entry.name) && /draftStore\.|draftKeyOf\(/u.test(await readFile(path, 'utf8'))) users.push(path.pathname.split('/src/')[1]);
    }
  };
  await walk(new URL('../src/', import.meta.url));
  assert.deepEqual(users.sort(), ['app/manual-publish.tsx', 'features/manual-publish/manual-publish-draft-store.ts']);
  // mock: A types, A's account is deleted (session gone for good), 30 days pass while B uses the app
  const auth = mockAuth();
  const clock = { t: T0 };
  const app = await createApp({ clock });
  await app.auth(auth.signIn('UA'));
  await app.open();
  await app.type('退会した人の下書き');
  app.leave();
  await app.auth(null);
  clock.t = T0 + 30 * DAY;
  await app.auth(auth.signIn('UB'));
  await app.open();
  app.leave();
  assert.equal(app.record('UA')?.text, '退会した人の下書き', 'still on the device, in plain text, after 30 days');
});

// ---- negative controls: each mutation must be caught by a G2-L scenario -------------------------------------------------

test('negative controls: ">=" at 24h, no future check, a restore that re-saves, and a key without the user are each caught by the scenarios above', async () => {
  const atLeast = { draftModule: await mutatedDraftModule('if (now.at - record.savedAt > DRAFT_MAX_AGE_MS)', 'if (now.at - record.savedAt >= DRAFT_MAX_AGE_MS)') };
  assert.equal((await reopenAfter(DAY, atLeast)).draft, '', '">=": 24:00:00 is discarded');
  assert.equal((await reopenAfter(DAY)).draft, TEXT, 'real code: 24:00:00 is kept');

  const noFuture = { draftModule: await mutatedDraftModule("if (record.savedAt > now.at + FUTURE_TOLERANCE_MS) return { kind: 'discard', reason: 'future' };", '') };
  assert.equal((await reopenAfter(-6 * MINUTE, noFuture)).draft, TEXT, 'no future check: a draft from 6 minutes "ahead" comes back');
  assert.equal((await reopenAfter(-6 * MINUTE)).draft, '');

  const resaves = { source: mutate(ROUTE_SOURCE, '        draftOnDevice.current = JSON.stringify([decision.text, decision.accountId]);\n', '') };
  assert.equal((await viewThenReopen(resaves)).draft, TEXT, 'a restore that re-saves: looking at it extends it');
  assert.equal((await viewThenReopen()).draft, '');

  const sharedKey = { draftModule: await mutatedDraftModule('export const draftKeyOf = (userId: string) => `postona.manual-publish.draft.v${DRAFT_VERSION}:${userId}`;', 'export const draftKeyOf = (_userId: string) => `postona.manual-publish.draft.v${DRAFT_VERSION}:shared`;') };
  const leaked = await keysTouchedByB(sharedKey);
  assert.deepEqual(leaked.keys, ['postona.manual-publish.draft.v1:shared'], "a key without the user: B's visit reads, writes and removes the one slot A's draft was in");
});
