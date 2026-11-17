// G1-02 TASK 2: the first public release is Threads and X on the iPhone (Instagram later). This fixes the person's way through the app —
// login -> connect each SNS -> text -> post by hand -> post by a date -> see the result — as the app's real files and pure rules, with no
// request, no provider and no gate turned on. What the screens do in each step is proven by the per-feature suites named in
// docs/postona/g1-threads-x-ios-release-flow-20261117.md; this file only guards that every step can be REACHED, that Threads is not hidden
// behind X's screens, that Instagram is never offered, and that every release gate is still OFF in the product source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as entry from '../src/features/threads-publish/threads-entry.ts';
import * as publishSetting from '../src/domain/publish-setting.ts';
import * as xWrite from '../src/features/reservations/x-write-view.ts';

const SRC = new URL('../src/', import.meta.url).pathname;
const read = (rel) => readFile(join(SRC, rel), 'utf8');
async function files(dir, out = []) {
  for (const e of await readdir(join(SRC, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) await files(rel, out); else if (/\.tsx?$/u.test(e.name)) out.push(rel);
  }
  return out;
}
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/.*$/gmu, '$1');

// ---- Threads is reachable, not hidden behind X's screens --------------------------------------------------------------------------------
test('G1-02 Threads entry: the active Threads account, else the first one, else the way to connect one; nothing for X or Instagram accounts', () => {
  const x = { id: 'sa_x', platform: 'x' };
  const t1 = { id: 'sa_t1', platform: 'threads' };
  const t2 = { id: 'sa_t2', platform: 'threads' };
  const ig = { id: 'sa_ig', platform: 'instagram' };
  assert.deepEqual(entry.threadsEntry([x, t1, t2], 'sa_t2'), { kind: 'open', accountId: 'sa_t2', text: entry.THREADS_ENTRY_OPEN_TEXT, label: 'Threadsアカウントの詳細を開く' });
  assert.equal(entry.threadsEntry([x, t1, t2], 'sa_x').accountId, 'sa_t1', 'X is active: the first Threads account');
  assert.equal(entry.threadsEntry([t1, t2], null).accountId, 'sa_t1');
  for (const none of [[], [x], [ig], [x, ig]]) {
    const e = entry.threadsEntry(none, null);
    assert.deepEqual([e.kind, e.accountId, e.text], ['connect', undefined, entry.THREADS_ENTRY_CONNECT_TEXT], JSON.stringify(none));
  }
  assert.doesNotMatch(entry.THREADS_ENTRY_OPEN_TEXT + entry.THREADS_ENTRY_CONNECT_TEXT, /完了|投稿しました|成功/u, 'a pointer never says something was posted');
});

test('G1-02 Threads entry: the home screen and the manual-publish (X) screen both show it and open the account detail; the detail still holds the Threads card', async () => {
  for (const rel of ['app/(tabs)/index.tsx', 'app/manual-publish.tsx']) {
    const code = strip(await read(rel));
    assert.match(code, /threadsEntry\(accounts, activeAccount\?\.id \?\? null\)/u, rel);
    assert.match(code, /THREADS_ENTRY_TITLE/u, rel);
    assert.match(code, /pathname: '\/accounts\/\[id\]', params: \{ id: threads\.accountId \}/u, rel);
    assert.match(code, /<Link href="\/accounts" asChild>/u, `${rel}: no Threads account yet -> the accounts screen`);
  }
  const detail = strip(await read('app/accounts/[id].tsx'));
  assert.match(detail, /account\.platform === 'threads' \? <ThreadsPublishCard/u);
  assert.match(detail, /account\.platform === 'threads' && account\.connectionStatus !== 'connected' \? <ThreadsConnectCard/u);
});

// ---- every step of the way can be reached ---------------------------------------------------------------------------------------------
test('G1-02 reachability: every registered screen has a file and is linked from another screen; the home screen opens manual publish, reservations, the Threads entry and the notifications', async () => {
  const layout = strip(await read('app/_layout.tsx'));
  const names = [...layout.matchAll(/<Stack\.Screen name="([^"]+)"/gu)].map((m) => m[1]);
  assert.ok(names.length >= 12);
  const all = await files('app');
  for (const name of names) assert.ok(all.some((f) => f === `app/${name}.tsx` || f === `app/${name}/index.tsx`), `${name}: a file`);
  const links = new Set();
  for (const rel of [...all, ...(await files('features'))]) {
    const code = strip(await read(rel));
    for (const m of code.matchAll(/(?:href=|router\.(?:push|replace|navigate)\()\s*\{?\s*(?:"|')(\/[^"']*)(?:"|')/gu)) links.add(m[1]);
    for (const m of code.matchAll(/pathname: '(\/[^']+)'/gu)) links.add(m[1]);
  }
  for (const route of ['/accounts', '/accounts/[id]', '/reservations', '/media', '/notifications', '/approvals', '/manual-publish', '/posts/[id]', '/login-methods', '/account-deletion', '/(tabs)/schedule', '/(tabs)/history', '/(tabs)/settings', '/(tabs)/consult']) {
    assert.ok(links.has(route), `${route} is linked from some screen (linked: ${[...links].sort().join(' ')})`);
  }
  const home = strip(await read('app/(tabs)/index.tsx'));
  for (const route of ['/manual-publish', '/reservations', '/accounts', '/notifications']) assert.ok(home.includes(`href="${route}"`), `home -> ${route}`);
});

// ---- Instagram is later: never offered --------------------------------------------------------------------------------------------------
test('G1-02 Instagram: no screen or feature offers it — the pill says 後日対応 and the publish card says it is later and cannot be switched on; X and Threads are unchanged', async () => {
  for (const rel of [...(await files('app')), ...(await files('features'))]) {
    if (rel === 'features/reservations/x-write-view.ts') continue;
    assert.doesNotMatch(strip(await read(rel)), /instagram/iu, `${rel} does not mention Instagram`);
  }
  assert.deepEqual(xWrite.connectionPill('connected', false, 'x', false, 'instagram'), { label: '後日対応', tone: 'warning' });
  assert.deepEqual(xWrite.connectionPill('not_connected', false, '未接続', false, 'instagram'), { label: '後日対応', tone: 'warning' });
  assert.equal(xWrite.connectionPill('connected', false, 'x', false, 'threads').label, '接続済み');
  assert.equal(xWrite.connectionPill('connected', false, 'x', false, 'x').label, xWrite.X_CONNECTION_UNVERIFIED_LABEL);
  const base = { id: 'sa_1', connectionStatus: 'connected', postingState: 'paused' };
  const ig = publishSetting.publishSettingView({ ...base, platform: 'instagram' });
  assert.deepEqual([ig.canTurnOn, ig.canTurnOff], [false, false]);
  assert.match(ig.note, /Instagramは後日対応/u);
  const th = publishSetting.publishSettingView({ ...base, platform: 'threads' });
  assert.deepEqual([th.canTurnOn, th.canTurnOff], [false, false]);
  assert.match(th.note, /Threadsには、この自動投稿の切り替えはありません/u);
  assert.doesNotMatch(th.note, /まだ利用できません/u, 'Threads is not described as unavailable');
  const x = publishSetting.publishSettingView({ ...base, platform: 'x' });
  assert.equal(x.canTurnOn, true, 'X: unchanged');
  const igOn = publishSetting.publishSettingView({ ...base, platform: 'instagram', postingState: 'active' });
  assert.equal(igOn.canTurnOff, true, 'an ON state of any account can still be stopped');
});

// ---- the gates stay OFF in the product source -------------------------------------------------------------------------------------------
test('G1-02 gates: every release gate is still OFF in the product source (the central release decides, not this PR)', async () => {
  const gates = [
    ['features/schedule/reservation-store.ts', /export const POSTONA_RESERVATION_PERSISTENCE_ENABLED = false as const;/u],
    ['features/schedule/remote-threads-reservation-store.ts', /export const POSTONA_THREADS_RESERVATION_PERSISTENCE_ENABLED = false as const;/u],
    ['features/media-box/media-box-gate.ts', /export const POSTONA_MEDIA_BOX_ENABLED = false;/u],
    ['features/approvals/approval-gate.ts', /export const POSTONA_APPROVAL_UI_ENABLED = false;/u],
    ['domain/threads-manual-publish.ts', /export const THREADS_MANUAL_PUBLISH_UI_ENABLED = false;/u],
    ['domain/threads-connect.ts', /export const THREADS_CONNECT_UI_ENABLED = false;/u],
    ['domain/threads-disconnect.ts', /export const THREADS_DISCONNECT_UI_ENABLED = false;/u],
  ];
  for (const [rel, pattern] of gates) assert.match(strip(await read(rel)), pattern, rel);
  const all = [];
  for (const rel of [...(await files('features')), ...(await files('domain')), ...(await files('app'))]) {
    for (const m of strip(await read(rel)).matchAll(/export const ([A-Z_]*(?:ENABLED|_GATE)[A-Z_]*)\s*(?::[^=]+)?=\s*(true|false)/gu)) all.push([m[1], m[2], rel]);
  }
  assert.ok(all.length >= gates.length);
  assert.deepEqual(all.filter(([, value]) => value !== 'false'), [], `no gate constant is true: ${JSON.stringify(all)}`);
});
