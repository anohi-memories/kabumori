// G1 TASK 43: the media box screen (src/app/media/index.tsx, its real hook and G5's client copy) on the REAL local Supabase: GoTrue
// ES256 JWTs, Kong, PostgREST, storage-api v1.70.3 with real bytes, PG 17.6 with G5's media box candidate (PR #638) installed as the
// lifecycle owner. React / RN are stubbed (tests/media-box-harness.mjs); the client is the app's supabase-js 2.115.0. The photo picker is
// the only stand-in: it hands over real PNG / JPEG / MP4 bytes. Run by run-media-box.sh (never against a managed project).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { button, has, images, mountMediaBox, picked, texts, tiles, videos } from '../media-box-harness.mjs';

const API = process.env.G1MB_API ?? '';
const PUBLISHABLE = process.env.G1MB_PUBLISHABLE ?? '';
const DB_PORT = process.env.G1MB_DB_PORT ?? '';
const MVP = process.env.G1MB_MVP ?? '';
const MEDIA = process.env.G1MB_MEDIA ?? '';
const FIXTURES = process.env.G1MB_FIXTURES ?? '';
const enabled = API !== '' && PUBLISHABLE !== '' && DB_PORT !== '' && MVP !== '' && MEDIA !== '' && FIXTURES !== '';
const opts = { skip: enabled ? false : 'needs run-media-box.sh', concurrency: false };
const BUCKET = 'postona-media';

function psql(user, args) {
  const r = spawnSync('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', DB_PORT, '-U', user, '-d', 'postgres', ...args], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  assert.equal(r.status, 0, `${args.join(' ')}\n${r.stderr}`);
  return r.stdout.trim();
}
const sql = (text) => psql('supabase_admin', ['-c', text]);
const asOwner = (dir, file) => psql('postgres', ['-f', `${dir}/${file}`]);
const sha = (bytes) => createHash('sha256').update(Buffer.from(bytes)).digest('hex');
const file = (name) => new Uint8Array(readFileSync(`${FIXTURES}/${name}`));
const newClient = () => createClient(API, PUBLISHABLE, { auth: { persistSession: false, autoRefreshToken: false } });
const config = { ok: true, config: { url: API, publishableKey: PUBLISHABLE } };

async function install() {
  if (sql(`select to_regprocedure('private.postona_personal_session()') is null`) === 't') { asOwner(MVP, 'MVP_INSTALL.sql'); asOwner(MVP, 'MVP_R1_EXECUTE_GRANT.sql'); }
  if (sql(`select to_regprocedure('public.postona_ensure_my_personal_workspace()') is null`) === 't') asOwner(MVP, 'MVP_W0_INSTALL.sql');
  asOwner(MVP, 'MVP_W0_EXECUTE_GRANT.sql');
  if (sql(`select to_regprocedure('public.postona_media_list(integer, timestamp with time zone, uuid)') is null`) === 't') asOwner(MEDIA, '001_media_box.sql');
  sql(`notify pgrst, 'reload schema'`);
  const probe = newClient();
  for (let i = 0; i < 100; i++) {
    const r = await probe.rpc('postona_media_list', { p_limit: 1 });
    if (r.error?.code === '42501' || r.error === null) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail('the media box did not answer after the install');
}

let n = 0;
async function person(label) {
  const client = newClient();
  const email = `g1mb-${label}-${++n}-${crypto.randomUUID().slice(0, 6)}@example.test`;
  const password = crypto.randomUUID();
  const r = await client.auth.signUp({ email, password });
  assert.ok(r.data.session, r.error?.message);
  assert.equal((await client.rpc('start_x_autopost_service')).data?.status, 'active');
  assert.equal((await client.rpc('postona_ensure_my_personal_workspace')).data?.status, 'ready');
  const id = r.data.user.id;
  return { id, email, password, client, ws: sql(`select 'u_' || substr(md5('${id}'), 1, 24)`), session: async () => (await client.auth.getSession()).data.session };
}

/** Renders until the screen shows what is expected (real HTTP in between); every frame is kept. */
async function until(h, predicate, label, ms = 20000) {
  const end = Date.now() + ms;
  let tree = await h.render();
  while (!predicate(tree)) {
    const failures = h.slots.filter((slot) => slot && Array.isArray(slot.adds)).flatMap((box) => box.adds.map((add) => add.failure?.status));
    assert.ok(Date.now() < end, `timed out: ${label}; the screen says: ${texts(tree).join(' / ')}; add answers: ${failures.join(',')}; raw: ${rawErrors.join(' | ')}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    tree = await h.render();
  }
  return tree;
}
// storage-api's raw errors, as supabase-js hands them over (kept to explain a failure; never asserted on)
const rawErrors = [];
const recording = (client) => ({
  rpc: async (fn, args) => { try { const r = await client.rpc(fn, args); if (r.error) rawErrors.push(`${fn}: ${r.error.code ?? '-'} ${r.error.message}`); return r; } catch (error) { rawErrors.push(`${fn}: threw ${error?.cause?.code ?? error?.message}`); throw error; } },
  auth: client.auth,
  storage: { from: (bucket) => { const s = client.storage.from(bucket); const keep = (step) => async (...args) => { const r = await s[step](...args); if (r.error) rawErrors.push(`${step}: ${r.error.name} ${r.error.status ?? r.error.statusCode ?? '-'} ${r.error.message} ${String(r.error.originalError?.cause?.code ?? r.error.originalError?.message ?? '')}`); return r; };
    return { upload: keep('upload'), move: keep('move'), download: keep('download'), remove: keep('remove') }; } },
});
const mountFor = async (who) => mountMediaBox({ session: await who.session(), workspace: { kind: 'ready', workspaceId: who.ws }, client: recording(who.client), config, settleTimes: 3, wait: () => new Promise((resolve) => setTimeout(resolve, 50)) });
const objectsOf = (ws) => Number(sql(`select count(*) from storage.objects where bucket_id = '${BUCKET}' and name like '${ws}/%'`));
const readWith = async (source, headers) => { const r = await fetch(source.uri, { headers }); return { status: r.status, sha: r.ok ? sha(new Uint8Array(await r.arrayBuffer())) : null }; };

test('the person on the real stack: add PNG / JPEG / MP4 from the screen -> the grid -> the authenticated preview -> delete with the objects gone', opts, async () => {
  await install();
  const A = await person('a');
  const h = await mountFor(A);
  await until(h, (t) => has(t, '素材はまだありません'), 'empty box');

  const PNG = file('cafe.png'); const JPEG = file('menu.jpg'); const MP4 = file('clip.mp4');
  for (const [name, type, bytes] of [['cafe.png', 'image/png', PNG], ['menu.jpg', 'image/jpeg', JPEG], ['clip.mp4', 'video/mp4', MP4]]) {
    h.world.uuid = () => crypto.randomUUID();
    h.world.pick = async () => picked(name, type, bytes.byteLength, bytes.slice().buffer);
    button(h.once(), '素材を追加').onPress();
    // node's fetch may reuse a socket the local Kong already closed (UND_ERR_SOCKET): the screen then offers the retry with the same
    // request id, which is what a person would press; it is counted and its raw error printed, never hidden.
    for (let retries = 0; ; retries++) {
      const t = await until(h, (x) => tiles(x).includes(name) || !!button(x, 'もう一度送る'), `${name} in the grid`);
      if (tiles(t).includes(name)) break;
      assert.ok(retries < 3, `${name}: three retries`);
      const answer = h.slots.filter((slot) => slot && Array.isArray(slot.adds)).flatMap((box) => box.adds.map((add) => add.failure?.status)).join(',');
      // RPC_ = supabase-js's fetch failure (its error code is ''), which G5's client classes as unavailable
      assert.match(answer, /^(NETWORK|STORAGE_ERROR|RPC_ERROR|RPC_)$/u, `${name}: only a transport failure is retried here`);
      console.log(`G1MB transient retry for ${name}: ${answer} ${rawErrors.at(-1) ?? '(rpc)'}`);
      rawErrors.length = 0;
      button(t, 'もう一度送る').onPress();
    }
    assert.equal(sql(`select count(*) from private.postona_media_assets where owner_user_id = '${A.id}' and display_name = '${name}'`), '1', `${name}: one asset`);
  }
  let tree = h.once();
  assert.deepEqual(tiles(tree), ['clip.mp4', 'menu.jpg', 'cafe.png'], 'newest first, from the server');
  assert.equal(sql(`select count(*) from private.postona_media_assets where owner_user_id = '${A.id}' and status = 'ready'`), '3');
  assert.equal(objectsOf(A.ws), 3, 'three final objects, no staging leftovers');

  // the preview: the tile's own source, read with the headers it carries; without them storage-api refuses
  const png = images(tree).find((p) => p.accessibilityLabel === 'cafe.png のプレビュー');
  assert.deepEqual(await readWith(png.source, png.source.headers), { status: 200, sha: sha(PNG) });
  assert.notEqual((await readWith(png.source, {})).status, 200, 'no token, no bytes');
  tree = await h.open('clip.mp4');
  const [video] = videos(tree);
  assert.deepEqual(await readWith(video.source, video.source.headers), { status: 200, sha: sha(MP4) });
  tree = await h.open('menu.jpg');
  const jpeg = images(tree).find((p) => p.accessibilityLabel === 'menu.jpg の画像');
  assert.deepEqual(await readWith(jpeg.source, jpeg.source.headers), { status: 200, sha: sha(JPEG) });

  // delete from the viewer: two presses; the tile leaves; storage-api holds nothing of it
  const asset = sql(`select id || ' ' || object_path from private.postona_media_assets where owner_user_id = '${A.id}' and display_name = 'menu.jpg'`).split(' ');
  button(h.once(), 'この素材を削除する').onPress(); await h.render();
  button(h.once(), '本当に削除する').onPress();
  tree = await until(h, (t) => !tiles(t).includes('menu.jpg') && (has(t, '解放もサーバーで確認済み') || has(t, '解放待ち')), 'deleted');
  assert.equal(Number(sql(`select count(*) from storage.objects where bucket_id = '${BUCKET}' and name = '${asset[1]}'`)), 0, 'the final object is removed');
  const purged = sql(`select purged_at is not null from private.postona_media_assets where id = '${asset[0]}'`);
  assert.equal(purged === 't', has(tree, '解放もサーバーで確認済み'), 'the words match the server\'s purged_at');
  console.log(`G1MB measured delete: purged=${purged} shown=${has(tree, '解放待ち') ? 'awaiting' : 'purged'}`);
  if (purged !== 't') {
    // the asset was deleted inside its upload window: the server gives the space back a minute later; ask as the screen does
    sql(`update private.postona_media_assets set upload_expires_at = now() - interval '2 minutes', deleted_at = now() - interval '2 minutes' where id = '${asset[0]}'`);
    button(h.once(), '解放を確認する').onPress();
    tree = await until(h, (t) => has(t, '解放もサーバーで確認済み'), 'purge confirmed');
    assert.equal(sql(`select purged_at is not null from private.postona_media_assets where id = '${asset[0]}'`), 't');
  }
  assert.deepEqual(tiles(tree), ['clip.mp4', 'cafe.png']);
});

test('retry on the real stack: the move fails once (network) -> 「もう一度送る」 with the same request id -> one ready asset; a GIF is refused by the server', opts, async () => {
  await install();
  const B = await person('b');
  const real = B.client.storage.from.bind(B.client.storage);
  let failMoves = 1;
  const wrapped = { rpc: (fn, args) => B.client.rpc(fn, args), storage: { from: (bucket) => { const s = real(bucket); return { upload: s.upload.bind(s), download: s.download.bind(s), remove: s.remove.bind(s), move: (a, b) => (failMoves-- > 0 ? Promise.reject(new TypeError('Network request failed')) : s.move(a, b)) }; } } };
  const h = await mountMediaBox({ session: await B.session(), workspace: { kind: 'ready', workspaceId: B.ws }, client: wrapped, config, settleTimes: 3, wait: () => new Promise((resolve) => setTimeout(resolve, 50)) });
  await until(h, (t) => has(t, '素材はまだありません'), 'empty');
  const PNG = file('cafe.png');
  h.world.uuid = () => crypto.randomUUID();
  h.world.pick = async () => picked('retry.png', 'image/png', PNG.byteLength, PNG.slice().buffer);
  button(h.once(), '素材を追加').onPress();
  let tree = await until(h, (t) => !!button(t, 'もう一度送る'), 'the retry offered');
  assert.equal(tiles(tree).length, 0, 'not ready: not in the grid');
  assert.equal(sql(`select status from private.postona_media_assets where owner_user_id = '${B.id}'`), 'pending');
  button(tree, 'もう一度送る').onPress();
  tree = await until(h, (t) => tiles(t).includes('retry.png'), 'ready after the retry');
  assert.equal(sql(`select count(*) || ':' || count(distinct request_id) from private.postona_media_assets where owner_user_id = '${B.id}'`), '1:1', 'one asset, one request id');
  h.world.pick = async () => picked('anim.gif', 'image/gif', 6, new TextEncoder().encode('GIF89a').buffer);
  button(h.once(), '素材を追加').onPress();
  tree = await until(h, (t) => has(t, 'この形式の素材は保存できません'), 'gif refused');
  assert.equal(sql(`select count(*) from private.postona_media_assets where owner_user_id = '${B.id}'`), '1');
});

test('whose box on the real stack: A -> B -> A on one screen, sign-out, an old token, the service ended -- nothing of another person, ever', opts, async () => {
  await install();
  const A = await person('c');
  const B = await person('d');
  const PNG = file('cafe.png');
  const h = await mountFor(A);
  await until(h, (t) => has(t, '素材はまだありません'), 'A empty');
  h.world.uuid = () => crypto.randomUUID();
  h.world.pick = async () => picked('a-only.png', 'image/png', PNG.byteLength, PNG.slice().buffer);
  button(h.once(), '素材を追加').onPress();
  let tree = await until(h, (t) => tiles(t).includes('a-only.png'), 'A has one');
  const oldSource = images(tree)[0].source;

  h.frames.length = 0;
  h.world.session = await B.session(); h.world.client = B.client; h.world.workspace = { kind: 'ready', workspaceId: B.ws };
  tree = await until(h, (t) => has(t, '素材はまだありません'), 'B empty');
  assert.ok(h.frames.every((frame) => !tiles(frame).includes('a-only.png')), 'no frame of B shows A\'s tile');
  assert.notEqual((await readWith(oldSource, { Authorization: `Bearer ${h.world.session.access_token}` })).status, 200, 'B\'s token cannot read A\'s object');

  h.world.session = await A.session(); h.world.client = A.client; h.world.workspace = { kind: 'ready', workspaceId: A.ws };
  tree = await until(h, (t) => tiles(t).includes('a-only.png'), 'A again');

  const token = h.world.session.access_token;
  await A.client.auth.signOut({ scope: 'local' });
  h.world.session = null;
  tree = await until(h, (t) => has(t, 'ログインが確認できないため'), 'signed out');
  assert.equal(tiles(tree).length, 0);
  assert.notEqual((await readWith(oldSource, { Authorization: `Bearer ${token}` })).status, 200, 'the signed-out token reads nothing');

  const again = newClient();
  assert.ok((await again.auth.signInWithPassword({ email: A.email, password: A.password })).data.session);
  A.client = again;
  h.world.client = again; h.world.session = (await again.auth.getSession()).data.session;
  tree = await until(h, (t) => tiles(t).includes('a-only.png'), 'signed in again');
  sql(`update public.service_entitlements set status = 'ended', ended_at = now() where user_id = '${A.id}' and service_key = 'x_autopost'`);
  h.world.refocus += 1;
  tree = await until(h, (t) => has(t, '表示していた素材は閉じました'), 'service ended');
  assert.equal(tiles(tree).length, 0);
  console.log('G1MB_LOCAL_STACK_PASS');
});
