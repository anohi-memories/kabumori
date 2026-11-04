// G1 TASK 43: the media box (素材BOX) screen, its hook and checks, over a scripted stand-in of G5's server (the real client module,
// a fake supabase rpc / storage). No network: the client is the only way out and it is a fake here. The real local Supabase run is
// tests/local-stack/media-box.e2e.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as mbClient from '../src/features/media-box/media-box-client.ts';
import * as mbView from '../src/features/media-box/media-box-view.ts';
import { button, has, images, mountMediaBox, picked, sessionOf, tiles, walk } from './media-box-harness.mjs';

const NETWORK = ['fetch', 'XMLHttpRequest', 'WebSocket'];
const saved = new Map();
test.beforeEach(() => { for (const name of NETWORK) { saved.set(name, globalThis[name]); globalThis[name] = () => { throw new Error(`network: ${name}`); }; } });
test.afterEach(() => { for (const name of NETWORK) globalThis[name] = saved.get(name); });

const WS = 'u_0123456789abcdef01234567';
const API = 'http://127.0.0.1:54321';

// ---- a stand-in for G5's server: the four RPCs and storage-api as the contract describes them -----------------------------------------
function server() {
  const s = { calls: [], assets: new Map(), objects: new Set(), clock: 0, inject: {}, holds: {} };
  const next = async (name, real) => {
    s.calls.push(name);
    if (s.holds[name]) { const hold = s.holds[name]; delete s.holds[name]; await hold; }
    const queued = s.inject[name]?.shift();
    if (queued !== undefined) { if (queued instanceof Error) throw queued; return typeof queued === 'function' ? queued() : queued; }
    return real();
  };
  const asset = (a) => ({ id: a.id, kind: a.kind, content_type: a.type, display_name: a.name, bytes: a.size, status: a.status, created_at: a.created, ready_at: a.ready, bucket: 'postona-media', object_path: a.final });
  const ok = (data) => ({ data, error: null });
  const rpcs = {
    postona_media_begin_upload: ({ p_request_id, p_file_name, p_content_type, p_size_bytes }) => {
      let a = [...s.assets.values()].find((x) => x.request === p_request_id);
      if (!a) {
        const id = `00000000-0000-4000-8000-${String(s.assets.size + 1).padStart(12, '0')}`;
        const ext = p_content_type.split('/')[1];
        a = { id, request: p_request_id, name: p_file_name, type: p_content_type, kind: p_content_type.startsWith('video') ? 'video' : 'image', size: p_size_bytes, status: 'pending', created: new Date(Date.UTC(2026, 10, 4, 3, 0, ++s.clock)).toISOString(), ready: null, final: `${WS}/${id}.${ext}`, staging: `${WS}/staging/${id}.${ext}` };
        s.assets.set(id, a);
      }
      if (a.status === 'ready') return ok({ status: 'ready', asset: asset(a) });
      return ok({ status: 'upload', asset: asset(a), upload: { bucket: 'postona-media', object_path: a.staging, final_path: a.final, content_type: a.type, moved: s.objects.has(a.final) } });
    },
    postona_media_complete_upload: ({ p_asset_id }) => {
      const a = s.assets.get(p_asset_id);
      if (!a || !s.objects.has(a.final)) return ok({ status: 'MEDIA_OBJECT_MISSING' });
      a.status = 'ready'; a.ready = a.created;
      return ok({ status: 'ready', asset: asset(a) });
    },
    postona_media_list: ({ p_limit, p_before_created_at, p_before_id }) => {
      const ready = [...s.assets.values()].filter((a) => a.status === 'ready').sort((x, y) => (y.created.localeCompare(x.created) || y.id.localeCompare(x.id)));
      const from = p_before_created_at ? ready.findIndex((a) => a.created < p_before_created_at || (a.created === p_before_created_at && a.id < p_before_id)) : 0;
      const page = from < 0 ? [] : ready.slice(from, from + p_limit);
      const more = from >= 0 && ready.length > from + p_limit;
      return ok({ status: 'ok', items: page.map(asset), next: more ? { before_created_at: page.at(-1).created, before_id: page.at(-1).id } : null });
    },
    postona_media_delete: ({ p_asset_id }) => {
      const a = s.assets.get(p_asset_id);
      if (!a) return ok({ status: 'MEDIA_NOT_FOUND' });
      const already = a.status === 'deleted';
      a.status = 'deleted';
      const purged = !s.objects.has(a.final) && !s.objects.has(a.staging);
      return ok({ status: 'deleted', already, purged, remove: { bucket: 'postona-media', object_paths: [a.final, a.staging] } });
    },
  };
  s.client = {
    rpc: (fn, args) => next(fn, () => rpcs[fn](args)),
    storage: {
      from: (bucket) => ({
        upload: (path, body, options) => next('upload', () => { s.lastUpload = { bucket, path, size: body.byteLength, options }; if (s.objects.has(path)) return { data: null, error: { statusCode: '409' } }; s.objects.add(path); return { data: { path }, error: null }; }),
        move: (from, to) => next('move', () => { if (s.objects.has(to)) return { data: null, error: { statusCode: '409' } }; s.objects.delete(from); s.objects.add(to); return { data: {}, error: null }; }),
        download: (path) => next('download', () => ({ data: null, error: { statusCode: 404 } })),
        remove: (paths) => next('remove', () => { for (const p of paths) s.objects.delete(p); return { data: paths, error: null }; }),
      }),
    },
  };
  s.count = (name) => s.calls.filter((c) => c === name).length;
  s.seed = (count) => { for (let i = 0; i < count; i++) { const r = `seed-${s.assets.size}`; rpcs.postona_media_begin_upload({ p_request_id: r, p_file_name: `seed-${i}.png`, p_content_type: 'image/png', p_size_bytes: 70 }); const a = [...s.assets.values()].at(-1); s.objects.add(a.final); a.status = 'ready'; a.ready = a.created; } };
  return s;
}

async function mount({ srv = server(), session = sessionOf('person-a'), workspace = { kind: 'ready', workspaceId: WS }, config = { ok: true, config: { url: API, publishableKey: 'sb_publishable_x' } }, ...rest } = {}) {
  const h = await mountMediaBox({ ...rest, session, workspace, config, client: srv?.client ?? null });
  return { ...h, srv };
}
// ---- the contract copy and the checks ----------------------------------------------------------------------------------------------------
test('the app\'s client is G5\'s client.ts byte for byte (copied, not re-implemented)', async () => {
  const copy = await readFile(new URL('../src/features/media-box/media-box-client.ts', import.meta.url));
  const g5 = await readFile(new URL('../../../supabase/candidates/postona_personal_media_box/client.ts', import.meta.url));
  assert.ok(copy.equals(g5));
});

test('checkPicked: the server\'s exact types and limits, before anything is sent', () => {
  const MIB = 1024 * 1024;
  assert.deepEqual(mbView.checkPicked({ name: 'a.png', mimeType: 'image/png', size: 70 }), { ok: true, contentType: 'image/png', kind: 'image' });
  assert.deepEqual(mbView.checkPicked({ name: 'IMG_1.HEIC', mimeType: null, size: 10 }), { ok: true, contentType: 'image/heic', kind: 'image' });
  assert.deepEqual(mbView.checkPicked({ name: 'clip.mov', mimeType: 'application/octet-stream', size: 10 }), { ok: true, contentType: 'video/quicktime', kind: 'video' });
  assert.deepEqual(mbView.checkPicked({ name: 'a.jpg', mimeType: 'IMAGE/JPEG', size: 20 * MIB }), { ok: true, contentType: 'image/jpeg', kind: 'image' });
  assert.equal(mbView.checkPicked({ name: 'a.jpg', mimeType: 'image/jpeg', size: 20 * MIB + 1 }).text, mbView.sizeLimitText('image'));
  assert.equal(mbView.checkPicked({ name: 'a.mp4', mimeType: 'video/mp4', size: 50 * MIB }).ok, true);
  assert.equal(mbView.checkPicked({ name: 'a.mp4', mimeType: 'video/mp4', size: 50 * MIB + 1 }).text, mbView.sizeLimitText('video'));
  for (const file of [{ name: 'a.gif', mimeType: 'image/gif', size: 5 }, { name: 'a.png', mimeType: 'image/gif', size: 5 }, { name: 'doc', mimeType: null, size: 5 }, { name: 'a.jpg', mimeType: 'image/jpg', size: 5 }]) {
    assert.equal(mbView.checkPicked(file).text, mbView.UNSUPPORTED_TEXT, file.name);
  }
  for (const size of [null, 0, -1, 1.5]) assert.equal(mbView.checkPicked({ name: 'a.png', mimeType: 'image/png', size }).text, mbView.SIZE_UNKNOWN_TEXT);
});

test('failure classes: only unavailable is retried; auth / forbidden / workspace drop what is held; each status has words', () => {
  const f = (status, cls) => ({ ok: false, class: cls ?? mbClient.MEDIA_STATUS_CLASS[status], status });
  assert.equal(mbView.isRetryable(f('NETWORK', 'unavailable')), true);
  for (const s of ['MEDIA_QUOTA_EXCEEDED', 'MEDIA_TOO_LARGE', 'MEDIA_TYPE_UNSUPPORTED', 'MEDIA_INPUT_INVALID', 'MEDIA_NOT_FOUND', 'AUTH_REQUIRED']) assert.equal(mbView.isRetryable(f(s)), false, s);
  for (const s of ['AUTH_REQUIRED', 'SESSION_EXPIRED', 'SERVICE_NOT_ACTIVE', 'ACCOUNT_LOCKED', 'WORKSPACE_REQUIRED', 'OWN_WORKSPACE_CONFLICT']) assert.equal(mbView.dropsCache(f(s)), true, s);
  for (const s of ['MEDIA_NOT_FOUND', 'MEDIA_QUOTA_EXCEEDED', 'ACCOUNT_LIFECYCLE_BUSY']) assert.equal(mbView.dropsCache(f(s)), false, s);
  assert.match(mbView.failureText(f('MEDIA_QUOTA_EXCEEDED')), /200件、合計 2GB/u);
  assert.match(mbView.failureText(f('NETWORK', 'unavailable')), /もう一度送る/u);
  for (const status of Object.keys(mbClient.MEDIA_STATUS_CLASS)) assert.ok(mbView.failureText(f(status)).length > 10, status);
  for (const [kind, block] of [['ready', null], ['preparing', 'workspace_preparing'], ['idle', 'workspace_preparing'], ['relogin', 'relogin'], ['service_inactive', 'service_inactive'], ['unconfirmed', 'workspace_unavailable'], ['unavailable', 'workspace_unavailable'], ['off', 'not_available'], ['mystery', 'workspace_unavailable']]) {
    assert.equal(mbView.workspaceBlock(kind), block, kind);
  }
});

// ---- nothing is asked before the person may use the box ---------------------------------------------------------------------------------
test('gate OFF (the source constant), sample data, no config, signed out, workspace not ready: the reason, no request, no picker', async () => {
  for (const [options, block] of [[{ gate: false }, 'off'], [{ status: 'mock_preview' }, 'preview'], [{ config: { ok: false, kind: 'missing', reason: '' } }, 'unconfigured'], [{ srv: null }, 'unconfigured'], [{ session: null }, 'signed_out'],
    [{ workspace: { kind: 'preparing' } }, 'workspace_preparing'], [{ workspace: { kind: 'relogin' } }, 'relogin'], [{ workspace: { kind: 'service_inactive' } }, 'service_inactive'], [{ workspace: { kind: 'unavailable' } }, 'workspace_unavailable']]) {
    const srv = Object.hasOwn(options, 'srv') ? options.srv : server();
    const h = await mount({ ...options, srv });
    const tree = await h.render();
    assert.ok(has(tree, mbView.MEDIA_BLOCK_TEXT[block]), block);
    assert.equal(button(tree, '素材を追加'), undefined, block);
    assert.equal(srv?.calls.length ?? 0, 0, block);
    assert.equal(h.world.picks, 0);
  }
  const source = await readFile(new URL('../src/features/media-box/media-box-gate.ts', import.meta.url), 'utf8');
  assert.match(source, /export const POSTONA_MEDIA_BOX_ENABLED = false;/u);
});

// ---- the list --------------------------------------------------------------------------------------------------------------------------
test('list: empty is 「まだありません」; tiles newest first; images read with the person\'s own token, videos show no image; pages by cursor', async () => {
  const empty = await mount();
  assert.ok(has(await empty.render(), '素材はまだありません'));
  const srv = server(); srv.seed(32);
  const h = await mount({ srv });
  let tree = await h.render();
  assert.equal(tiles(tree).length, 30);
  assert.equal(tiles(tree)[0], 'seed-31.png', 'newest first');
  const img = images(tree)[0];
  assert.match(img.source.uri, new RegExp(`^${API}/storage/v1/object/authenticated/postona-media/${WS}/`, 'u'));
  assert.deepEqual(img.source.headers, { Authorization: 'Bearer jwt-person-a' });
  tree = await h.press('さらに読み込む');
  assert.equal(tiles(tree).length, 32);
  assert.equal(new Set(tiles(tree)).size, 32, 'no tile twice');
  assert.equal(button(tree, 'さらに読み込む'), undefined);
  assert.equal(srv.count('postona_media_list'), 2);
});

test('a next page that repeats a tile already shown (an add between the reads) does not show it twice', async () => {
  const srv = server(); srv.seed(31);
  const h = await mount({ srv });
  await h.render();
  const first = [...srv.assets.values()].filter((a) => a.status === 'ready').sort((x, y) => y.created.localeCompare(x.created));
  const shown = first[0];
  srv.inject.postona_media_list = [{ data: { status: 'ok', items: [{ id: shown.id, kind: 'image', content_type: 'image/png', display_name: shown.name, bytes: 70, status: 'ready', created_at: shown.created, ready_at: shown.created, bucket: 'postona-media', object_path: shown.final }, { id: first[30].id, kind: 'image', content_type: 'image/png', display_name: first[30].name, bytes: 70, status: 'ready', created_at: first[30].created, ready_at: first[30].created, bucket: 'postona-media', object_path: first[30].final }], next: null }, error: null }];
  const tree = await h.press('さらに読み込む');
  assert.equal(tiles(tree).length, 31);
  assert.equal(new Set(tiles(tree)).size, 31);
});

test('the token is never kept: not in the hook\'s state, and a refreshed token is used by the next render without a new read', async () => {
  const srv = server(); srv.seed(1);
  const h = await mount({ srv });
  await h.render();
  assert.doesNotMatch(JSON.stringify(h.slots.filter((s) => s && typeof s === 'object' && !('deps' in s) && !('current' in s))), /jwt-person-a/u);
  h.world.session = sessionOf('person-a', 'jwt-refreshed');
  const tree = await h.render();
  assert.deepEqual(images(tree)[0].source.headers, { Authorization: 'Bearer jwt-refreshed' });
  assert.equal(srv.count('postona_media_list'), 1);
});

test('offline: a failed read shows no old list and offers a re-read; nothing is written while it fails', async () => {
  const srv = server(); srv.seed(2);
  const h = await mount({ srv });
  assert.equal(tiles(await h.render()).length, 2);
  srv.inject.postona_media_list = [new Error('offline')];
  h.world.refocus += 1;
  let tree = await h.render();
  assert.equal(tiles(tree).length, 0);
  assert.ok(has(tree, '素材を読み込めませんでした'));
  tree = await h.press('もう一度読み込む');
  assert.equal(tiles(tree).length, 2);
  assert.equal(srv.count('postona_media_begin_upload') + srv.count('postona_media_delete'), 0);
});

// ---- add ---------------------------------------------------------------------------------------------------------------------------------
test('add: begin -> staging upload -> move -> complete; not in the box until the server says ready; then the tile and 「保存しました」', async () => {
  const srv = server();
  let release; srv.holds.postona_media_complete_upload = new Promise((r) => { release = r; });
  const h = await mount({ srv });
  await h.render();
  let tree = await h.press('素材を追加');
  assert.ok(has(tree, '保存しています'));
  assert.equal(tiles(tree).length, 0, 'not ready yet');
  assert.match(srv.lastUpload.path, /\/staging\//u);
  assert.deepEqual(srv.lastUpload.options, { contentType: 'image/png', upsert: false });
  release(); tree = await h.render();
  assert.deepEqual(tiles(tree), ['cafe.png']);
  assert.ok(has(tree, mbView.ADDED_TEXT));
  assert.deepEqual(srv.calls.slice(1), ['postona_media_begin_upload', 'upload', 'move', 'postona_media_complete_upload']);
});

test('add retry: a network failure keeps the file and its request id; 「もう一度送る」 continues (no second upload) and makes one asset', async () => {
  const srv = server();
  srv.inject.postona_media_complete_upload = [new Error('offline')];
  const h = await mount({ srv });
  await h.render();
  let tree = await h.press('素材を追加');
  assert.ok(has(tree, 'サーバーに接続できませんでした'));
  assert.equal(tiles(tree).length, 0);
  tree = await h.press('もう一度送る');
  assert.deepEqual(tiles(tree), ['cafe.png']);
  assert.equal(srv.count('postona_media_begin_upload'), 2);
  assert.equal(srv.count('upload'), 1, 'the bytes were already moved: no second upload');
  assert.equal(srv.assets.size, 1, 'one asset for one picked file');
  assert.equal(h.world.ids, 1, 'one request id');
});

test('add final answers: quota, too large, unsupported, expired -- the words, no retry, 「やめる」 drops the file', async () => {
  for (const [inject, words] of [
    [{ postona_media_begin_upload: [{ data: { status: 'MEDIA_QUOTA_EXCEEDED' }, error: null }] }, '200件、合計 2GB'],
    [{ upload: [{ data: null, error: { statusCode: '413' } }] }, '大きすぎる'],
    [{ upload: [{ data: null, error: { statusCode: '415' } }] }, 'この形式の素材は保存できません'],
    [{ postona_media_complete_upload: [{ data: { status: 'MEDIA_UPLOAD_EXPIRED' }, error: null }] }, '受付時間が過ぎました'],
  ]) {
    const srv = server(); Object.assign(srv.inject, inject);
    const h = await mount({ srv });
    await h.render();
    let tree = await h.press('素材を追加');
    assert.ok(has(tree, words), words);
    assert.equal(button(tree, 'もう一度送る'), undefined, words);
    tree = await h.press('この素材の保存をやめる');
    assert.ok(!has(tree, 'cafe.png（'), words);
  }
});

test('picker: cancelled, denied, a refused type or size, a read failure -- nothing is sent', async () => {
  for (const [answer, words] of [[{ kind: 'cancelled' }, null], [{ kind: 'denied' }, '写真へのアクセスが許可されていない'], [{ kind: 'refused', text: mbView.UNSUPPORTED_TEXT }, 'この形式'], [{ kind: 'failed' }, '読み込めませんでした']]) {
    const srv = server();
    const h = await mount({ srv });
    h.world.pick = async () => answer;
    await h.render();
    const tree = await h.press('素材を追加');
    if (words) assert.ok(has(tree, words), words);
    assert.equal(srv.calls.filter((c) => c !== 'postona_media_list').length, 0, answer.kind);
    assert.equal(button(tree, '素材を追加').disabled, false);
  }
});

test('a 401 / service end answer to an add drops the list and the held bytes; nothing of the person stays', async () => {
  const srv = server(); srv.seed(1);
  srv.inject.postona_media_begin_upload = [{ data: { status: 'SESSION_EXPIRED' }, error: null }];
  const h = await mount({ srv });
  assert.equal(tiles(await h.render()).length, 1);
  const tree = await h.press('素材を追加');
  assert.equal(tiles(tree).length, 0);
  assert.ok(has(tree, 'ログインを確認できませんでした'));
  assert.ok(!has(tree, 'cafe.png（'));
});

// ---- view and delete --------------------------------------------------------------------------------------------------------------------
test('view: a tile opens the image (authenticated source) or the video player with the same headers', async () => {
  const srv = server();
  const h = await mount({ srv });
  await h.render();
  await h.press('素材を追加');
  h.world.pick = async () => picked('clip.mp4', 'video/mp4', 900);
  await h.press('素材を追加');
  let tree = await h.open('clip.mp4');
  let video; walk(tree, (n) => { if (n.type === 'MediaVideo') video = n.props; });
  assert.match(video.source.uri, /\/object\/authenticated\/postona-media\/.*\.mp4$/u);
  assert.deepEqual(video.source.headers, { Authorization: 'Bearer jwt-person-a' });
  tree = await h.open('cafe.png');
  assert.ok(images(tree).some((p) => p.accessibilityLabel === 'cafe.png の画像' && p.source.headers.Authorization === 'Bearer jwt-person-a'));
});

test('delete: asked twice; purged -> gone and 「解放もサーバーで確認済み」; not purged -> gone, 「解放待ち」 until the confirm says purged', async () => {
  const srv = server(); srv.seed(2);
  const h = await mount({ srv });
  await h.render();
  let tree = await h.open('seed-1.png');
  tree = await h.press('この素材を削除する');
  assert.equal(srv.count('postona_media_delete'), 0, 'the first press only asks');
  tree = await h.press('本当に削除する');
  assert.deepEqual(tiles(tree), ['seed-0.png']);
  assert.ok(has(tree, mbView.DELETED_TEXT));
  assert.deepEqual(srv.calls.slice(-3), ['postona_media_delete', 'remove', 'postona_media_delete']);
  srv.inject.postona_media_delete = [undefined, () => ({ data: { status: 'deleted', already: true, purged: false, remove: { bucket: 'postona-media', object_paths: [] } }, error: null })];
  await h.open('seed-0.png'); await h.press('この素材を削除する');
  tree = await h.press('本当に削除する');
  assert.deepEqual(tiles(tree), []);
  assert.ok(has(tree, '解放待ち'));
  assert.ok(!has(tree, mbView.DELETED_TEXT));
  tree = await h.press('解放を確認する');
  assert.ok(has(tree, mbView.DELETED_TEXT));
  assert.ok(!has(tree, '解放待ち'));
});

test('delete failures: a failed removal says so and offers the delete again (the list is read again); not found removes the tile', async () => {
  const srv = server(); srv.seed(2);
  srv.inject.remove = [{ data: null, error: { statusCode: '503' } }];
  const h = await mount({ srv });
  await h.render();
  await h.open('seed-1.png'); await h.press('この素材を削除する');
  let tree = await h.press('本当に削除する');
  assert.ok(has(tree, '削除を完了できませんでした'));
  assert.equal(srv.count('postona_media_list'), 2, 'read again after the failure');
  assert.deepEqual(tiles(tree), ['seed-0.png'], 'the row was deleted: the server no longer lists it');
  tree = await h.press('削除をやり直す');
  assert.ok(has(tree, mbView.DELETED_TEXT));
  srv.inject.postona_media_delete = [{ data: { status: 'MEDIA_NOT_FOUND' }, error: null }];
  await h.open('seed-0.png'); await h.press('この素材を削除する');
  tree = await h.press('本当に削除する');
  assert.deepEqual(tiles(tree), []);
  assert.ok(has(tree, '見つかりませんでした'));
});

// ---- whose box ---------------------------------------------------------------------------------------------------------------------------
test('user A -> B -> A on one device, sign-out, a workspace that stops being ready: no frame ever shows another person\'s tile', async () => {
  const a = server(); a.seed(2);
  const b = server();
  const h = await mount({ srv: a });
  assert.equal(tiles(await h.render()).length, 2);
  h.frames.length = 0;
  h.world.session = sessionOf('person-b'); h.world.client = b.client;
  let tree = await h.render();
  assert.ok(h.frames.every((frame) => tiles(frame).length === 0), 'B never sees A\'s tiles');
  assert.ok(has(tree, '素材はまだありません'));
  h.world.session = sessionOf('person-a'); h.world.client = a.client;
  tree = await h.render();
  assert.equal(tiles(tree).length, 2, 'A reads again');
  assert.equal(a.count('postona_media_list'), 2);
  h.world.session = null;
  tree = await h.render();
  assert.ok(has(tree, mbView.MEDIA_BLOCK_TEXT.signed_out));
  assert.equal(tiles(tree).length, 0);
  h.world.session = sessionOf('person-a');
  h.world.workspace = { kind: 'service_inactive' };
  tree = await h.render();
  assert.equal(tiles(tree).length, 0);
  assert.ok(has(tree, mbView.MEDIA_BLOCK_TEXT.service_inactive));
});

test('a late answer for A does not reach B: an add that finishes after the switch is not shown', async () => {
  const a = server();
  let release; a.holds.postona_media_complete_upload = new Promise((r) => { release = r; });
  const h = await mount({ srv: a });
  await h.render();
  await h.press('素材を追加');
  h.world.session = sessionOf('person-b'); h.world.client = server().client;
  await h.render();
  release();
  const tree = await h.render();
  assert.equal(tiles(tree).length, 0);
  assert.ok(!has(tree, mbView.ADDED_TEXT));
});

test('a service end seen by the list read drops the box; WORKSPACE_REQUIRED says the workspace is being prepared', async () => {
  const srv = server(); srv.seed(1);
  const h = await mount({ srv });
  assert.equal(tiles(await h.render()).length, 1);
  srv.inject.postona_media_list = [{ data: { status: 'SERVICE_NOT_ACTIVE' }, error: null }];
  h.world.refocus += 1;
  let tree = await h.render();
  assert.equal(tiles(tree).length, 0);
  assert.ok(has(tree, '表示していた素材は閉じました'));
  srv.inject.postona_media_list = [{ data: { status: 'WORKSPACE_REQUIRED' }, error: null }];
  tree = await h.press('もう一度読み込む');
  assert.ok(has(tree, '個人ワークスペースを準備しています'));
});

// ---- wiring --------------------------------------------------------------------------------------------------------------------------------
test('boundaries: the settings tab opens /media; the screen reaches the server only through G5\'s client copy; no G3/G4/G6 code; no mock data', async () => {
  const settings = await readFile(new URL('../src/app/(tabs)/settings.tsx', import.meta.url), 'utf8');
  assert.match(settings, /router\.push\('\/media'\)/u);
  const screen = await readFile(new URL('../src/app/media/index.tsx', import.meta.url), 'utf8');
  const hook = await readFile(new URL('../src/features/media-box/use-media-box.ts', import.meta.url), 'utf8');
  for (const [name, text] of [['screen', screen], ['hook', hook]]) {
    assert.doesNotMatch(text, /mock-repository|mockRepository|reservation-store|post-assist|x-connect|threads-|supabase\.(from|rpc|storage)/u, name);
  }
  assert.doesNotMatch(hook, /AsyncStorage|SecureStore|localStorage|console\./u, 'nothing is persisted or logged');
  const app = JSON.parse(await readFile(new URL('../app.json', import.meta.url), 'utf8'));
  const picker = app.expo.plugins.find((p) => Array.isArray(p) && p[0] === 'expo-image-picker');
  assert.equal(picker[1].cameraPermission, false);
  assert.equal(picker[1].microphonePermission, false);
  assert.match(picker[1].photosPermission, /素材BOX/u);
});
