// G5-02 task 5: the POSTONA media box (supabase/candidates/postona_personal_media_box) on the REAL local Supabase runtime, run by
// postona_personal_workspace_local_run.sh after the workspace suite: GoTrue ES256 JWTs, PostgREST, Kong, storage-api v1.70.3 with its local
// file backend (real bytes written, read back by signed URL and removed), PG 17.6.1.165. The person's calls go through the G5-owned client
// module (client.ts) over supabase-js 2.115.0, as G1 will make them. Network: only the local API / fake ports (the runner's --allow-net).
import assert from 'node:assert/strict';
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.115.0';

const API = Deno.env.get('G5LS_API') ?? '';
const PUBLISHABLE = Deno.env.get('G5LS_PUBLISHABLE') ?? '';
const SECRET = Deno.env.get('G5LS_SECRET') ?? '';
const DB_PORT = Deno.env.get('G5LS_DB_PORT') ?? '';
const MVP = Deno.env.get('G5LS_MVP') ?? '';
const MEDIA = Deno.env.get('G5LS_MEDIA') ?? '';
const enabled = API !== '' && PUBLISHABLE !== '' && SECRET !== '' && MVP !== '' && MEDIA !== '';
const opts = { ignore: !enabled, sanitizeOps: false, sanitizeResources: false };
const OWNER = 'postgres';
const SUPER = 'supabase_admin';
const BUCKET = 'postona-media';
const decoder = new TextDecoder();
const mb = enabled ? await import(`file://${MEDIA}/client.ts`) : null;

// ---- psql ---------------------------------------------------------------------------------------------------------------------------------
type Result = { ok: boolean; out: string; error: string };
async function psql(user: string, args: string[], stdin?: string): Promise<Result> {
  const cmd = new Deno.Command('psql', {
    args: ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', DB_PORT, '-U', user, '-d', 'postgres', ...args],
    env: { LC_ALL: 'C', PGOPTIONS: '-c client_min_messages=notice' }, stdin: stdin === undefined ? 'null' : 'piped', stdout: 'piped', stderr: 'piped',
  }).spawn();
  if (stdin !== undefined) {
    const w = cmd.stdin.getWriter();
    await w.write(new TextEncoder().encode(stdin));
    await w.close();
  }
  const o = await cmd.output();
  return { ok: o.success, out: decoder.decode(o.stdout).trim(), error: decoder.decode(o.stderr).trim() };
}
async function sql(user: string, text: string): Promise<string> {
  const r = await psql(user, ['-c', text]);
  assert.ok(r.ok, `${text}\n${r.error}`);
  return r.out;
}
const run = (dir: string, name: string, user = OWNER) => psql(user, ['-f', `${dir}/${name}`]);
const ok = async (dir: string, name: string, user = OWNER) => { const r = await run(dir, name, user); assert.ok(r.ok, `${name}\n${r.error}`); };
const INSTALL = '001_media_box.sql';
const STOP = '001_media_box_stop.sql';
const ROLLBACK = '001_media_box_rollback.sql';
// functions (body / ACL / owner / config), default ACLs, role memberships, relation ACLs and row security, storage.objects policies, buckets
const catalog = () => sql(SUPER, `select md5(string_agg(x, E'\\n' order by x)) from (
  select 'p ' || p.oid::regprocedure::text || ' ' || md5(p.prosrc) || ' ' || coalesce(p.proacl::text, '-') || ' ' || p.proowner::regrole::text || coalesce(p.proconfig::text, '') x
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname !~ '^(pg_|information_schema)'
  union all select 'd ' || d.defaclrole::regrole::text || ' ' || d.defaclnamespace::text || d.defaclobjtype::text || ' ' || d.defaclacl::text from pg_default_acl d
  union all select 'm ' || m.roleid::regrole::text || ' ' || m.member::regrole::text || m.admin_option || m.inherit_option || m.set_option from pg_auth_members m
  union all select 'c ' || c.oid::regclass::text || ' ' || c.relrowsecurity || ' ' || coalesce((select string_agg(a::text, ',' order by a::text) from unnest(c.relacl) a), '-')
    from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname !~ '^(pg_|information_schema)'
  union all select 'pol ' || polname || ' ' || polcmd::text || ' ' || polpermissive || ' ' || array_to_string(polroles::regrole[]::text[], ',') || ' '
    || coalesce(pg_get_expr(polqual, polrelid), '-') || ' ' || coalesce(pg_get_expr(polwithcheck, polrelid), '-') from pg_policy where polrelid = 'storage.objects'::regclass
  union all select 'b ' || id || ' ' || public || ' ' || coalesce(file_size_limit::text, '-') || ' ' || coalesce(array_to_string(allowed_mime_types, ','), '-') from storage.buckets) s`);
const objects = (path: string) => sql(SUPER, `select count(*) from storage.objects where bucket_id = '${BUCKET}' and name = '${path}'`);
const assetRow = (id: string) => sql(SUPER, `select coalesce((select status || ':' || coalesce(stored_bytes::text, '-') from private.postona_media_assets where id = '${id}'), '-')`);

// ---- people: real GoTrue sign-ups, POSTONA started, the personal workspace made by W0 -----------------------------------------------------
type Person = { id: string; email: string; password: string; token: string; client: SupabaseClient; ws: string };
const newClient = () => createClient(API, PUBLISHABLE, { auth: { persistSession: false, autoRefreshToken: false } });
let n = 0;
async function person(label: string, workspace = true): Promise<Person> {
  const client = newClient();
  const email = `g5mb-${label.toLowerCase()}-${++n}-${crypto.randomUUID().slice(0, 6)}@example.test`;
  const password = crypto.randomUUID();
  const r = await client.auth.signUp({ email, password });
  assert.ok(r.data.session && r.data.user, r.error?.message);
  assert.equal(((await client.rpc('start_x_autopost_service')).data as { status: string }).status, 'active');
  if (workspace) assert.equal(((await client.rpc('postona_ensure_my_personal_workspace')).data as { status: string }).status, 'ready');
  const id = r.data.user.id;
  return { id, email, password, token: r.data.session.access_token, client, ws: await sql(SUPER, `select 'u_' || substr(md5('${id}'), 1, 24)`) };
}
const status = async (c: SupabaseClient, fn: string, args: Record<string, unknown>) => {
  const r = await c.rpc(fn, args);
  return r.error ? `HTTP:${r.error.code}` : String((r.data as { status: string }).status);
};

// ---- files: real bytes ----------------------------------------------------------------------------------------------------------------------
function bytes(size: number, seed = 1): Uint8Array {
  const b = new Uint8Array(size);
  for (let i = 0; i < size; i += 65536) crypto.getRandomValues(b.subarray(i, Math.min(size, i + 65536)));
  b[0] = seed;
  return b;
}
// a real 1x1 PNG
const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
const sha = async (b: Uint8Array | ArrayBuffer) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(b)))).map((x) => x.toString(16).padStart(2, '0')).join('');
const file = (name: string, contentType: string, body: Uint8Array) => ({ name, contentType, body, size: body.byteLength });
async function readBack(c: SupabaseClient, asset: { bucket: string; object_path: string }): Promise<string> {
  const u = await mb.mediaReadUrl(c, asset, 60);
  if (!u.ok) return `${u.class}:${u.status}`;
  const res = await fetch(u.url);
  return res.ok ? await sha(await res.arrayBuffer()) : `HTTP${res.status}`;
}

// ---- the profile the media box builds on (MVP_INSTALL + W0, as the workspace suite releases it) ---------------------------------------
async function ensureProfile() {
  if (await sql(SUPER, `select to_regprocedure('private.postona_personal_session()') is null`) === 't') {
    await ok(MVP, 'MVP_INSTALL.sql');
    await ok(MVP, 'MVP_R1_EXECUTE_GRANT.sql');
  }
  if (await sql(SUPER, `select to_regprocedure('public.postona_ensure_my_personal_workspace()') is null`) === 't') await ok(MVP, 'MVP_W0_INSTALL.sql');
  await ok(MVP, 'MVP_W0_EXECUTE_GRANT.sql');
}

Deno.test({ name: 'storage-api facts the box depends on (measured): a policy sees role authenticated, the per-claim sub / role but NOT session_id (so the reviewed S2-2 answers AUTH_REQUIRED there), the JSON claims with session_id and is_anonymous, and storage.operation (sign / delete_many); its uploads test INSERT under row security and write as storage-api; SQL deletes on storage tables are refused', ...opts }, async () => {
  await ensureProfile();
  await sql(SUPER, `create table public.g5mb_probe (op text, s jsonb);
    create function public.g5mb_probe_fn(p text) returns boolean language plpgsql volatile security definer set search_path = '' as $f$ begin
      insert into public.g5mb_probe values (p, pg_catalog.jsonb_build_object('claim_sub', pg_catalog.current_setting('request.jwt.claim.sub', true) is not null,
        'claim_role', pg_catalog.current_setting('request.jwt.claim.role', true), 'claim_session', pg_catalog.current_setting('request.jwt.claim.session_id', true),
        'json_session', (pg_catalog.current_setting('request.jwt.claims', true)::jsonb ->> 'session_id') is not null,
        'json_anonymous', pg_catalog.current_setting('request.jwt.claims', true)::jsonb -> 'is_anonymous', 'operation', pg_catalog.current_setting('storage.operation', true),
        's2_2', private.postona_personal_session()));
      return true; end $f$;
    grant execute on function public.g5mb_probe_fn(text) to authenticated;
    insert into storage.buckets (id, name, public) values ('g5mb-probe', 'g5mb-probe', false);
    create policy g5mb_probe_i on storage.objects for insert to authenticated with check (bucket_id = 'g5mb-probe' and public.g5mb_probe_fn('insert'));
    create policy g5mb_probe_s on storage.objects for select to authenticated using (bucket_id = 'g5mb-probe' and public.g5mb_probe_fn('select'));
    create policy g5mb_probe_d on storage.objects for delete to authenticated using (bucket_id = 'g5mb-probe' and public.g5mb_probe_fn('delete'));`);
  try {
    const c = newClient();
    const r = await c.auth.signUp({ email: `g5mb-probe-${crypto.randomUUID().slice(0, 6)}@example.test`, password: crypto.randomUUID() });
    assert.ok(r.data.session);
    assert.equal((await c.storage.from('g5mb-probe').upload('x/a.png', PNG, { contentType: 'image/png' })).error, null);
    assert.equal((await c.storage.from('g5mb-probe').createSignedUrl('x/a.png', 60)).error, null);
    assert.equal((await c.storage.from('g5mb-probe').remove(['x/a.png'])).error, null);
    const seen = await sql(SUPER, `select string_agg(op || '=' || s::text, ' ' order by op, s::text) from public.g5mb_probe`);
    // the upload's INSERT check ran in a transaction storage-api rolled back (no 'insert' row survives); the write was storage-api's own
    assert.doesNotMatch(seen, /insert=/u);
    for (const [op, operation] of [['select', 'storage.object.sign'], ['delete', 'storage.object.delete_many'], ['select', 'storage.object.delete_many']]) {
      assert.match(seen, new RegExp(`${op}=\\{"s2_2": "AUTH_REQUIRED", "claim_sub": true, "operation": "${operation.replace(/\./g, '\\.')}", "claim_role": "authenticated", "json_session": true, "claim_session": null, "json_anonymous": false\\}`, 'u'), seen);
    }
    const del = await psql(SUPER, ['-c', `delete from storage.buckets where id = 'g5mb-probe'`]);
    assert.match(del.error, /Direct deletion from storage tables is not allowed/u);
  } finally {
    await sql(SUPER, `drop policy g5mb_probe_i on storage.objects; drop policy g5mb_probe_s on storage.objects; drop policy g5mb_probe_d on storage.objects;
      begin; set local storage.allow_delete_query = 'true'; delete from storage.buckets where id = 'g5mb-probe'; commit;
      drop function public.g5mb_probe_fn(text); drop table public.g5mb_probe`);
  }
});

const BEFORE = { catalog: '' };
Deno.test({ name: 'install: refuses a superuser, a changed G5 gate, another open storage policy and a taken bucket, changing nothing; installs; a re-run changes nothing; PF_BRANDS still PASS', ...opts }, async () => {
  await ensureProfile();
  BEFORE.catalog = await catalog();
  const text = await Deno.readTextFile(`${MEDIA}/${INSTALL}`);
  const refused = async (r: Result, want: RegExp) => { assert.ok(!r.ok, 'installed'); assert.match(r.error, want); assert.equal(await catalog(), BEFORE.catalog, `${want}: nothing changed`); };
  await refused(await run(MEDIA, INSTALL, SUPER), /MEDIA_SUPERUSER/u);
  await refused(await psql(OWNER, ['-f', '-'], text.replace("'fa4623601fe2ef6efc38478c9f65105e:true'", "'00000000000000000000000000000000:true'")), /MEDIA_GATE_CHANGED/u);
  await sql(SUPER, `create policy g5mb_open on storage.objects for select to authenticated using (true)`);
  try {
    BEFORE.catalog = await catalog();
    await refused(await run(MEDIA, INSTALL), /MEDIA_UNREVIEWED_STORAGE_POLICY: g5mb_open/u);
  } finally {
    await sql(SUPER, 'drop policy g5mb_open on storage.objects');
  }
  await sql(SUPER, `insert into storage.buckets (id, name, public) values ('${BUCKET}', '${BUCKET}', true)`);
  try {
    BEFORE.catalog = await catalog();
    await refused(await run(MEDIA, INSTALL), /MEDIA_TAKEN: bucket postona-media/u);
  } finally {
    await sql(SUPER, `begin; set local storage.allow_delete_query = 'true'; delete from storage.buckets where id = '${BUCKET}'; commit`);
  }
  BEFORE.catalog = await catalog();
  await ok(MEDIA, INSTALL);
  const installed = await catalog();
  await ok(MEDIA, INSTALL);
  assert.equal(await catalog(), installed, 'a re-run changes nothing');
  assert.equal(await sql(SUPER, `select public || ':' || file_size_limit from storage.buckets where id = '${BUCKET}'`), 'false:52428800', 'private');
  const pf = await psql(OWNER, ['-f', `${MVP}/MVP_RELEASE_PREFLIGHT.sql`]);
  assert.match(pf.error, /G5_MVP_PREFLIGHT PF_BRANDS PASS/u, pf.error);
});

const SAMPLES: Record<string, unknown> = {};
Deno.test({ name: 'the person: add (begin -> upload the real bytes -> complete) -> list (newest first, pages) -> read back by a signed URL (the same SHA-256) -> delete (row, then object) -> gone; a retry of each step is safe', ...opts }, async () => {
  const A = await person('A');
  // the raw answers, for the contract
  const rid = crypto.randomUUID();
  const args = { p_request_id: rid, p_file_name: '../../etc/いちごタルト.png', p_content_type: 'image/png', p_size_bytes: PNG.byteLength };
  const begun = await A.client.rpc('postona_media_begin_upload', args);
  SAMPLES.begin = begun.data;
  const b = begun.data as { status: string; asset: { id: string; display_name: string }; upload: { bucket: string; object_path: string } };
  assert.equal(b.status, 'upload');
  assert.equal(b.asset.display_name, 'いちごタルト.png', 'only the last path segment is kept, as a display name');
  assert.match(b.upload.object_path, new RegExp(`^${A.ws}/[0-9a-f-]{36}\\.png$`, 'u'), 'the server chose the path');
  assert.equal(await status(A.client, 'postona_media_begin_upload', args), 'upload', 'a retry: the same asset');
  assert.equal((await A.client.storage.from(BUCKET).upload(b.upload.object_path, PNG, { contentType: 'image/png', upsert: false })).error, null);
  const done = await A.client.rpc('postona_media_complete_upload', { p_asset_id: b.asset.id });
  SAMPLES.complete = done.data;
  assert.equal((done.data as { status: string }).status, 'ready');
  assert.equal(await status(A.client, 'postona_media_complete_upload', { p_asset_id: b.asset.id }), 'ready', 'complete again: the same');
  assert.equal(await assetRow(b.asset.id), `ready:${PNG.byteLength}`);
  assert.equal(await readBack(A.client, b.upload), await sha(PNG), 'the stored bytes are the uploaded bytes');

  // through the client module: a 1.5 MB JPEG and a 1 MB MP4, then pages of 2
  const jpg = bytes(1_500_000, 0xff);
  const mp4 = bytes(1_000_000, 0x00);
  const j = await mb.addMedia(A.client, file('朝の一枚.jpg', 'image/jpeg', jpg), crypto.randomUUID());
  const v = await mb.addMedia(A.client, file('clip.mp4', 'video/mp4', mp4), crypto.randomUUID());
  assert.ok(j.ok && v.ok, JSON.stringify([j, v]));
  assert.equal(await readBack(A.client, j.asset), await sha(jpg));
  assert.equal(await readBack(A.client, v.asset), await sha(mp4));
  const page1 = await mb.listMedia(A.client, 2);
  SAMPLES.list = (await A.client.rpc('postona_media_list', { p_limit: 2 })).data;
  assert.ok(page1.ok);
  assert.deepEqual(page1.items.map((x: { id: string }) => x.id), [v.asset.id, j.asset.id], 'newest first');
  assert.ok(page1.next);
  const page2 = await mb.listMedia(A.client, 2, page1.next);
  assert.ok(page2.ok);
  assert.deepEqual(page2.items.map((x: { id: string }) => x.id), [b.asset.id]);
  assert.equal(page2.next, null);
  assert.equal(await status(A.client, 'postona_media_list', { p_limit: 51 }), 'MEDIA_INPUT_INVALID');

  // delete: the row (it leaves the list at once), then the object through storage-api; again: already, and the remove is a no-op
  const signedBefore = await mb.mediaReadUrl(A.client, j.asset, 60);
  assert.ok(signedBefore.ok);
  const del = await A.client.rpc('postona_media_delete', { p_asset_id: j.asset.id });
  SAMPLES.delete = del.data;
  const d = await mb.deleteMedia(A.client, j.asset.id);
  assert.deepEqual(d, { ok: true, already: true });
  assert.equal(await objects(j.asset.object_path), '0', 'the bytes are gone');
  assert.equal(await assetRow(j.asset.id), `deleted:${jpg.byteLength}`);
  assert.deepEqual(((await mb.listMedia(A.client, 10)) as { items: Array<{ id: string }> }).items.map((x) => x.id), [v.asset.id, b.asset.id]);
  assert.match(await readBack(A.client, j.asset), /^not_found:|^invalid:/u, 'no new read URL for a deleted asset');
  assert.notEqual((await fetch(signedBefore.url)).status, 200, 'a URL signed before the delete no longer serves the bytes');
  assert.equal(await status(A.client, 'postona_media_complete_upload', { p_asset_id: j.asset.id }), 'MEDIA_NOT_FOUND');
  console.log(`G5-02 #5 samples ${JSON.stringify(SAMPLES)}`);
});

Deno.test({ name: 'another person, anon and forged paths: B can neither list, read, sign, download, complete, delete, overwrite nor remove A\'s asset; uploads only to a path the server gave B for B\'s own pending asset; anon gets nothing', ...opts }, async () => {
  const A = await person('A2');
  const B = await person('B2');
  const a = await mb.addMedia(A.client, file('a.png', 'image/png', PNG), crypto.randomUUID());
  assert.ok(a.ok);
  // B's API answers about A's asset: not found (its existence is not told)
  assert.equal(await status(B.client, 'postona_media_complete_upload', { p_asset_id: a.asset.id }), 'MEDIA_NOT_FOUND');
  assert.equal(await status(B.client, 'postona_media_delete', { p_asset_id: a.asset.id }), 'MEDIA_NOT_FOUND');
  assert.deepEqual(((await mb.listMedia(B.client, 50)) as { items: unknown[] }).items, []);
  // B through storage-api
  assert.match(await readBack(B.client, a.asset), /^(not_found|invalid):STORAGE_(404|400)$/u, 'no signed URL for A\'s object');
  assert.notEqual((await B.client.storage.from(BUCKET).download(a.asset.object_path)).error, null, 'no download');
  assert.notEqual((await B.client.storage.from(BUCKET).upload(a.asset.object_path, PNG, { contentType: 'image/png', upsert: true })).error, null, 'no overwrite');
  assert.deepEqual((await B.client.storage.from(BUCKET).remove([a.asset.object_path])).data, [], 'remove touches nothing');
  assert.equal(await objects(a.asset.object_path), '1');
  assert.equal(await readBack(A.client, a.asset), await sha(PNG), 'A\'s bytes are untouched');
  // A's own object cannot be overwritten either (no UPDATE policy) or uploaded twice
  assert.notEqual((await A.client.storage.from(BUCKET).upload(a.asset.object_path, bytes(70), { contentType: 'image/png', upsert: true })).error, null);
  assert.notEqual((await A.client.storage.from(BUCKET).upload(a.asset.object_path, bytes(70), { contentType: 'image/png', upsert: false })).error, null);
  assert.equal(await readBack(A.client, a.asset), await sha(PNG));

  // forged paths: B begins an upload of its own, then tries every other path
  const bb = (await B.client.rpc('postona_media_begin_upload', { p_request_id: crypto.randomUUID(), p_file_name: 'b.png', p_content_type: 'image/png', p_size_bytes: PNG.byteLength })).data as { upload: { object_path: string } };
  const leaf = bb.upload.object_path.split('/')[1];
  const forged = [`${A.ws}/${crypto.randomUUID()}.png`, `${A.ws}/${leaf}`, `${B.ws}/${crypto.randomUUID()}.png`, `${B.ws}/../${A.ws}/x.png`,
    `../${A.ws}/x.png`, `${bb.upload.object_path}/../../${A.ws}/x.png`, `${B.ws}/${leaf}.png`, bb.upload.object_path.toUpperCase()];
  for (const path of forged) {
    const up = await B.client.storage.from(BUCKET).upload(path, PNG, { contentType: 'image/png' });
    assert.notEqual(up.error, null, `B uploaded to ${path}`);
  }
  assert.equal(await sql(SUPER, `select count(*) from storage.objects where bucket_id = '${BUCKET}' and owner_id = '${B.id}'`), '0', 'nothing of B\'s was stored');
  // a doubled slash is collapsed by the client library before it is sent: it lands on exactly the path the server gave (measured), nowhere else
  assert.equal((await B.client.storage.from(BUCKET).upload(`${B.ws}//${leaf}`, PNG, { contentType: 'image/png' })).error, null);
  assert.equal(await sql(SUPER, `select string_agg(name, ' ') from storage.objects where bucket_id = '${BUCKET}' and owner_id = '${B.id}'`), bb.upload.object_path);
  assert.notEqual((await B.client.storage.from(BUCKET).upload(bb.upload.object_path, PNG, { contentType: 'image/png' })).error, null, 'then the same path again: a duplicate');

  // anon: no RPC (EXECUTE is authenticated's only), no storage, no public URL
  const anon = newClient();
  for (const [fn, args] of [['postona_media_list', { p_limit: 10 }], ['postona_media_begin_upload', { p_request_id: crypto.randomUUID(), p_file_name: 'x', p_content_type: 'image/png', p_size_bytes: 1 }],
    ['postona_media_delete', { p_asset_id: a.asset.id }]] as Array<[string, Record<string, unknown>]>) {
    assert.equal((await anon.rpc(fn, args)).error?.code, '42501', fn);
  }
  assert.notEqual((await anon.storage.from(BUCKET).createSignedUrl(a.asset.object_path, 60)).error, null);
  assert.notEqual((await anon.storage.from(BUCKET).upload(`${A.ws}/${crypto.randomUUID()}.png`, PNG, { contentType: 'image/png' })).error, null);
  assert.notEqual((await fetch(`${API}/storage/v1/object/public/${BUCKET}/${a.asset.object_path}`)).status, 200, 'no public URL');
});

Deno.test({ name: 'lifecycle: signed out / expired session, service ended (then restarted), account locked, membership removed, no workspace yet, user A -> B -> A on one device: every list / add / read / delete refuses while it must, and comes back with the person', ...opts }, async () => {
  const A = await person('A3');
  const a = await mb.addMedia(A.client, file('a.png', 'image/png', PNG), crypto.randomUUID());
  assert.ok(a.ok);
  const refusedAll = async (c: SupabaseClient, want: string, label: string) => {
    assert.equal(await status(c, 'postona_media_list', { p_limit: 5 }), want, `${label}: list`);
    assert.equal(await status(c, 'postona_media_begin_upload', { p_request_id: crypto.randomUUID(), p_file_name: 'x.png', p_content_type: 'image/png', p_size_bytes: 1 }), want, `${label}: begin`);
    assert.equal(await status(c, 'postona_media_delete', { p_asset_id: a.asset.id }), want, `${label}: delete`);
    assert.notEqual((await c.storage.from(BUCKET).createSignedUrl(a.asset.object_path, 60)).error, null, `${label}: sign`);
  };
  // no session at all (signed out on this client)
  const gone = newClient();
  assert.ok((await gone.auth.signInWithPassword({ email: A.email, password: A.password })).data.session);
  await gone.auth.signOut({ scope: 'local' });
  await refusedAll(gone, 'HTTP:42501', 'no session');
  // a signed-out login whose JWT is still within exp
  const old = createClient(API, PUBLISHABLE, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${A.token}` } } });
  const s2 = newClient();
  assert.ok((await s2.auth.signInWithPassword({ email: A.email, password: A.password })).data.session);
  await A.client.auth.signOut({ scope: 'local' });
  await refusedAll(old, 'SESSION_REVOKED', 'signed out (JWT within exp)');
  A.client = s2;
  assert.equal(await readBack(A.client, a.asset), await sha(PNG), 'a live session of A still works');
  // the session past its not_after
  await sql(SUPER, `update auth.sessions set not_after = now() - interval '1 second' where user_id = '${A.id}'`);
  await refusedAll(s2, 'SESSION_EXPIRED', 'expired session');
  await sql(SUPER, `update auth.sessions set not_after = null where user_id = '${A.id}'`);
  assert.equal(await status(A.client, 'postona_media_list', { p_limit: 5 }), 'ok');
  // the service ended, then restarted through the real RPC
  await sql(SUPER, `update public.service_entitlements set status = 'ended', ended_at = now() where user_id = '${A.id}' and service_key = 'x_autopost'`);
  await refusedAll(A.client, 'SERVICE_NOT_ACTIVE', 'service ended');
  const re = await A.client.rpc('reactivate_x_autopost_service', { p_expected_lifecycle_version: Number(await sql(SUPER, `select lifecycle_version from public.common_accounts where user_id = '${A.id}'`)) });
  assert.equal((re.data as { status: string } | null)?.status, 'active', JSON.stringify(re.error));
  assert.equal(await readBack(A.client, a.asset), await sha(PNG), 'restarted: the same asset again');
  // the account locked
  await sql(SUPER, `update public.common_accounts set status = 'locked' where user_id = '${A.id}'`);
  await refusedAll(A.client, 'ACCOUNT_LOCKED', 'locked');
  await sql(SUPER, `update public.common_accounts set status = 'active' where user_id = '${A.id}'`);
  // the membership removed (the workspace is then nobody's), then put back
  await sql(SUPER, `delete from public.brand_memberships where user_id = '${A.id}'`);
  await refusedAll(A.client, 'WORKSPACE_OWNER_UNKNOWN', 'membership removed');
  await sql(SUPER, `insert into public.brand_memberships (brand_id, user_id, role) values ('${A.ws}', '${A.id}', 'owner')`);
  assert.equal(await readBack(A.client, a.asset), await sha(PNG));
  // a person without a workspace yet
  const N = await person('N3', false);
  assert.equal(await status(N.client, 'postona_media_list', { p_limit: 5 }), 'WORKSPACE_REQUIRED');
  assert.equal(await status(N.client, 'postona_media_begin_upload', { p_request_id: crypto.randomUUID(), p_file_name: 'x.png', p_content_type: 'image/png', p_size_bytes: 1 }), 'WORKSPACE_REQUIRED');
  // A -> B -> A on one device (one client): each sees only their own
  const B = await person('B3');
  const device = newClient();
  const ids = async () => ((await mb.listMedia(device, 50)) as { items: Array<{ id: string }> }).items.map((x) => x.id);
  await device.auth.signInWithPassword({ email: A.email, password: A.password });
  assert.deepEqual(await ids(), [a.asset.id]);
  await device.auth.signOut({ scope: 'local' });
  await device.auth.signInWithPassword({ email: B.email, password: B.password });
  assert.deepEqual(await ids(), []);
  assert.notEqual((await device.storage.from(BUCKET).createSignedUrl(a.asset.object_path, 60)).error, null);
  await device.auth.signOut({ scope: 'local' });
  await device.auth.signInWithPassword({ email: A.email, password: A.password });
  assert.deepEqual(await ids(), [a.asset.id]);
});

Deno.test({ name: 'limits and failures: unsupported type, empty / oversize declarations, bytes or type that differ from the declaration, the bucket\'s own limits, retries and conflicts, two at once, an expired upload, a never-removed object (orphans), quotas', ...opts }, async () => {
  const A = await person('A4');
  const begin = (ct: string, size: number, rid = crypto.randomUUID(), name = 'x') => A.client.rpc('postona_media_begin_upload', { p_request_id: rid, p_file_name: name, p_content_type: ct, p_size_bytes: size });
  const st = async (p: PromiseLike<{ data: unknown; error: unknown }>) => String(((await p).data as { status: string }).status);
  assert.equal(await st(begin('image/gif', 10)), 'MEDIA_TYPE_UNSUPPORTED');
  assert.equal(await st(begin('IMAGE/PNG', 10)), 'MEDIA_TYPE_UNSUPPORTED', 'exact types only');
  assert.equal(await st(begin('image/png', 0)), 'MEDIA_INPUT_INVALID');
  assert.equal(await st(begin('image/png', 20971521)), 'MEDIA_TOO_LARGE');
  assert.equal(await st(begin('video/mp4', 52428801)), 'MEDIA_TOO_LARGE');
  // declared 70 bytes, uploaded 71 / declared png, uploaded as jpeg: storage-api stores them, complete refuses and the asset is not listed
  for (const [label, body, ct] of [['more bytes', bytes(PNG.byteLength + 1), 'image/png'], ['another type', PNG, 'image/jpeg']] as Array<[string, Uint8Array, string]>) {
    const b = (await begin('image/png', PNG.byteLength)).data as { asset: { id: string }; upload: { object_path: string } };
    assert.equal((await A.client.storage.from(BUCKET).upload(b.upload.object_path, body, { contentType: ct })).error, null, label);
    assert.equal(await status(A.client, 'postona_media_complete_upload', { p_asset_id: b.asset.id }), 'MEDIA_OBJECT_MISMATCH', label);
    assert.equal(await assetRow(b.asset.id), 'pending:-', label);
    assert.deepEqual(await mb.deleteMedia(A.client, b.asset.id), { ok: true, already: false }, `${label}: cleaned up by the person`);
    assert.equal(await objects(b.upload.object_path), '0', `${label}: the object went too`);
  }
  // the bucket's own limits (storage-api): a type outside the bucket and more than 50 MiB
  {
    const b = (await begin('video/mp4', 52428800)).data as { asset: { id: string }; upload: { object_path: string } };
    assert.notEqual((await A.client.storage.from(BUCKET).upload(b.upload.object_path, bytes(10), { contentType: 'text/plain' })).error, null, 'text/plain refused by the bucket');
    assert.notEqual((await A.client.storage.from(BUCKET).upload(b.upload.object_path, bytes(52428801), { contentType: 'video/mp4' })).error, null, 'over 50 MiB refused by the bucket');
    assert.equal(await objects(b.upload.object_path), '0');
    assert.equal(await status(A.client, 'postona_media_complete_upload', { p_asset_id: b.asset.id }), 'MEDIA_OBJECT_MISSING');
    await mb.deleteMedia(A.client, b.asset.id);
  }
  // retries and conflicts: the same request id is the same asset; asking something else under it is a conflict; two at once are one
  const rid = crypto.randomUUID();
  const [x1, x2] = await Promise.all([begin('image/png', PNG.byteLength, rid, 'p.png'), begin('image/png', PNG.byteLength, rid, 'p.png')]);
  const i1 = (x1.data as { asset: { id: string } }).asset.id;
  assert.equal((x2.data as { asset: { id: string } }).asset.id, i1, 'two begins at once: one asset');
  assert.equal(await st(begin('image/png', PNG.byteLength + 1, rid, 'p.png')), 'MEDIA_REQUEST_CONFLICT');
  assert.equal(await st(begin('image/png', PNG.byteLength, rid, 'q.png')), 'MEDIA_REQUEST_CONFLICT');
  const path1 = (x1.data as { upload: { object_path: string } }).upload.object_path;
  const ups = await Promise.all([A.client.storage.from(BUCKET).upload(path1, PNG, { contentType: 'image/png' }), A.client.storage.from(BUCKET).upload(path1, PNG, { contentType: 'image/png' })]);
  // storage-api tests the INSERT permission in its own transaction and writes afterwards, so two uploads of one new key can BOTH succeed
  // (measured: both succeeded in 6 of 8 local runs; the last write wins) -- always the person's own pending path, one object row, re-checked by complete
  console.log(`G5-02 #5 two uploads at once: ${JSON.stringify(ups.map((u) => u.error?.statusCode ?? 'ok'))}`);
  assert.ok(ups.some((u) => u.error === null) && ups.every((u) => u.error === null || String(u.error.statusCode) === '409'), JSON.stringify(ups.map((u) => u.error)));
  assert.equal(await objects(path1), '1', 'one object');
  assert.deepEqual(await Promise.all([status(A.client, 'postona_media_complete_upload', { p_asset_id: i1 }), status(A.client, 'postona_media_complete_upload', { p_asset_id: i1 })]), ['ready', 'ready']);
  const again = await mb.addMedia(A.client, file('p.png', 'image/png', PNG), rid);
  assert.ok(again.ok && again.asset.id === i1, 'the client module retried the whole add: the same asset');
  assert.deepEqual(await Promise.all([status(A.client, 'postona_media_delete', { p_asset_id: i1 }), status(A.client, 'postona_media_delete', { p_asset_id: i1 })]), ['deleted', 'deleted']);
  // a deleted asset whose object the client never removed: an orphan the owner sees; the person's remove clears it
  assert.equal(await objects(path1), '1');
  assert.match(await sql(OWNER, `select string_agg(kind || ':' || object_path, ' ') from private.postona_media_orphans()`), new RegExp(`object_without_asset:${path1}`, 'u'));
  assert.equal(await st(begin('image/png', PNG.byteLength, rid, 'p.png')), 'MEDIA_NOT_FOUND', 'a deleted request is not reopened');
  assert.deepEqual(await mb.deleteMedia(A.client, i1), { ok: true, already: true });
  assert.equal(await objects(path1), '0');
  // an expired upload window: no upload, no complete; the row is an orphan to clean
  {
    const b = (await begin('image/png', PNG.byteLength)).data as { asset: { id: string }; upload: { object_path: string } };
    await sql(SUPER, `update private.postona_media_assets set upload_expires_at = now() - interval '1 second' where id = '${b.asset.id}'`);
    assert.notEqual((await A.client.storage.from(BUCKET).upload(b.upload.object_path, PNG, { contentType: 'image/png' })).error, null);
    assert.equal(await status(A.client, 'postona_media_complete_upload', { p_asset_id: b.asset.id }), 'MEDIA_UPLOAD_EXPIRED');
    assert.match(await sql(OWNER, `select string_agg(kind || ':' || object_path, ' ') from private.postona_media_orphans()`), new RegExp(`expired_upload:${b.upload.object_path}`, 'u'));
    await mb.deleteMedia(A.client, b.asset.id);
  }
  // quotas: 10 open uploads; 200 assets; 2 GiB (the last two seeded as the owner: the counting is what is tested)
  const open = await Promise.all(Array.from({ length: 10 }, () => begin('image/png', 10)));
  assert.ok(open.every((o) => (o.data as { status: string }).status === 'upload'));
  assert.equal(await st(begin('image/png', 10)), 'MEDIA_QUOTA_EXCEEDED', 'the 11th open upload');
  for (const o of open) await mb.deleteMedia(A.client, (o.data as { asset: { id: string } }).asset.id);
  const seed = (count: number, size: number) => sql(OWNER, `insert into private.postona_media_assets (id, owner_user_id, workspace_id, request_id, bucket_id, object_path, kind, content_type, display_name, declared_bytes, stored_bytes, status, upload_expires_at, ready_at)
    select g.id, '${A.id}', '${A.ws}', gen_random_uuid(), '${BUCKET}', '${A.ws}/' || g.id || '.png', 'image', 'image/png', 'seed', ${size}, ${size}, 'ready', now(), now()
      from (select gen_random_uuid() id from generate_series(1, ${count})) g`);
  await seed(199, 10);
  assert.equal(await st(begin('image/png', 10)), 'upload', '199 + 1');
  assert.equal(await st(begin('image/png', 10)), 'MEDIA_QUOTA_EXCEEDED', 'the 201st asset');
  await sql(OWNER, `delete from private.postona_media_assets where owner_user_id = '${A.id}'`);
  await seed(100, 21474836);
  assert.equal(await st(begin('image/png', 49)), 'MEDIA_QUOTA_EXCEEDED', '2 147 483 600 + 49 > 2 GiB');
  assert.equal(await st(begin('image/png', 48)), 'upload', '2 147 483 600 + 48 = 2 GiB');
  await sql(OWNER, `delete from private.postona_media_assets where owner_user_id = '${A.id}'`);
});

Deno.test({ name: 'stop / rollback: the stop closes every path at once and keeps rows and objects; a re-install opens them again; the rollback refuses while anything is stored, then removes the box (the catalog as before it)', ...opts }, async () => {
  const A = await person('A5');
  const a = await mb.addMedia(A.client, file('a.png', 'image/png', PNG), crypto.randomUUID());
  assert.ok(a.ok);
  await ok(MEDIA, STOP);
  await ok(MEDIA, STOP);
  assert.equal((await A.client.rpc('postona_media_list', { p_limit: 5 })).error?.code, '42501');
  assert.notEqual((await A.client.storage.from(BUCKET).createSignedUrl(a.asset.object_path, 60)).error, null);
  assert.notEqual((await A.client.storage.from(BUCKET).upload(`${A.ws}/${crypto.randomUUID()}.png`, PNG, { contentType: 'image/png' })).error, null);
  assert.equal(await objects(a.asset.object_path), '1');
  assert.equal(await assetRow(a.asset.id), `ready:${PNG.byteLength}`);
  assert.match((await run(MEDIA, ROLLBACK)).error, /MEDIA_ROLLBACK_NOT_EMPTY: postona-media still holds objects/u);
  await ok(MEDIA, INSTALL);
  assert.equal(await readBack(A.client, a.asset), await sha(PNG), 're-installed: the same asset');
  // the operator's cleanup before a rollback: every asset deleted, every object removed through storage-api (service key; never SQL)
  await sql(OWNER, `update private.postona_media_assets set status = 'deleted', deleted_at = now() where status <> 'deleted'`);
  assert.match((await run(MEDIA, ROLLBACK)).error, /MEDIA_ROLLBACK_NOT_EMPTY: postona-media still holds objects/u);
  const left = (await sql(SUPER, `select coalesce(string_agg(name, ' '), '') from storage.objects where bucket_id = '${BUCKET}'`)).split(' ').filter(Boolean);
  const svc = createClient(API, SECRET, { auth: { persistSession: false, autoRefreshToken: false } });
  if (left.length > 0) assert.equal((await svc.storage.from(BUCKET).remove(left)).error, null);
  assert.equal(await sql(SUPER, `select count(*) from storage.objects where bucket_id = '${BUCKET}'`), '0');
  await ok(MEDIA, ROLLBACK);
  await ok(MEDIA, ROLLBACK);
  assert.equal(await catalog(), BEFORE.catalog, 'the catalog as before the box');
  // and the box comes back by the install
  await ok(MEDIA, INSTALL);
});

// ---- mutants: every guard is load-bearing (each mutated install changes the answer of its own case; the reviewed file is restored) ------
Deno.test({ name: 'mutants: the owner, state, expiry, session, lifecycle, quota, size, list / delete owner and idempotency guards are each load-bearing (each mutant flips its own case; the original refuses it)', ...opts }, async () => {
  const text = await Deno.readTextFile(`${MEDIA}/${INSTALL}`);
  const A = await person('mA');
  const B = await person('mB');
  const ready = await mb.addMedia(A.client, file('r.png', 'image/png', PNG), crypto.randomUUID());
  assert.ok(ready.ok);
  const begin = (p: Person, size = PNG.byteLength) => p.client.rpc('postona_media_begin_upload', { p_request_id: crypto.randomUUID(), p_file_name: 'm.png', p_content_type: 'image/png', p_size_bytes: size });
  type Upload = { asset: { id: string; object_path: string }; upload: { object_path: string } };
  const signs = async (c: SupabaseClient, path: string) => (await c.storage.from(BUCKET).createSignedUrl(path, 60)).error === null;
  // each case: true when the guard did NOT hold (what the mutant must make happen and the original must never)
  const cases: Array<[string, string, string, () => Promise<boolean>]> = [
    // the owner and workspace lines together (the workspace is a function of the owner: its line alone is a defense in depth)
    ['MB1 object owner', "     where a.bucket_id = p_bucket and a.object_path = p_name and a.owner_user_id = v_user\n       and a.workspace_id = 'u_' || pg_catalog.substr(pg_catalog.md5(v_user::text), 1, 24)",
      '     where a.bucket_id = p_bucket and a.object_path = p_name', () => signs(B.client, ready.asset.object_path)],
    ['MB2 insert only while pending', "             when 'insert' then a.status = 'pending' and a.upload_expires_at > pg_catalog.clock_timestamp()", "             when 'insert' then true",
      async () => { const u = (await begin(A)).data as Upload; await mb.deleteMedia(A.client, u.asset.id); return (await A.client.storage.from(BUCKET).upload(u.upload.object_path, PNG, { contentType: 'image/png' })).error === null; }],
    ['MB3 insert only before expiry', "             when 'insert' then a.status = 'pending' and a.upload_expires_at > pg_catalog.clock_timestamp()", "             when 'insert' then a.status = 'pending'",
      async () => { const u = (await begin(A)).data as Upload; await sql(SUPER, `update private.postona_media_assets set upload_expires_at = now() - interval '1 second' where id = '${u.asset.id}'`);
        const r = (await A.client.storage.from(BUCKET).upload(u.upload.object_path, PNG, { contentType: 'image/png' })).error === null; await mb.deleteMedia(A.client, u.asset.id); return r; }],
    ['MB4 a deleted object visible only to removal', "                                or (a.status = 'deleted' and pg_catalog.current_setting('storage.operation', true) = 'storage.object.delete_many')",
      "                                or (a.status = 'deleted')",
      async () => { const r = await mb.addMedia(A.client, file('d.png', 'image/png', PNG), crypto.randomUUID()); await A.client.rpc('postona_media_delete', { p_asset_id: r.asset.id });
        const s = await signs(A.client, r.asset.object_path); await mb.deleteMedia(A.client, r.asset.id); return s; }],
    ['MB5 removal only after the delete RPC', "             else a.status = 'deleted'\n           end);", "             else a.status in ('ready', 'deleted')\n           end);",
      async () => { const r = await mb.addMedia(A.client, file('x.png', 'image/png', PNG), crypto.randomUUID()); await A.client.storage.from(BUCKET).remove([r.asset.object_path]);
        const gone = await objects(r.asset.object_path) === '0'; await mb.deleteMedia(A.client, r.asset.id); return gone; }],
    ['MB6 storage session gate', "  if private.postona_media_session() is distinct from 'active' then\n    return false;", "  if false then\n    return false;",
      async () => { const old = createClient(API, PUBLISHABLE, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${A.token}` } } });
        const live = newClient(); await live.auth.signInWithPassword({ email: A.email, password: A.password }); await A.client.auth.signOut({ scope: 'local' }); A.client = live;
        A.token = (await live.auth.getSession()).data.session!.access_token; return await signs(old, ready.asset.object_path); }],
    ['MB7 storage lifecycle state', "  if private.postona_media_reader_state(v_user) is not null then\n    return false;", "  if false then\n    return false;",
      async () => { await sql(SUPER, `update public.common_accounts set status = 'locked' where user_id = '${A.id}'`);
        const s = await signs(A.client, ready.asset.object_path); await sql(SUPER, `update public.common_accounts set status = 'active' where user_id = '${A.id}'`); return s; }],
    ['MB8 writers ask T13', "    perform private.account_lifecycle_assert_active_service_write(v_user, 'x_autopost');", '    perform 1;',
      async () => { await sql(SUPER, `update public.service_entitlements set status = 'ended', ended_at = now() where user_id = '${A.id}' and service_key = 'x_autopost'`);
        const st = ((await begin(A)).data as { status: string }).status;
        await sql(SUPER, `update public.service_entitlements set status = 'active', ended_at = null where user_id = '${A.id}' and service_key = 'x_autopost'`); return st === 'upload'; }],
    ['MB9 open-upload quota', '  if f_active >= 200 or f_pending >= 10 or f_bytes + p_size_bytes > 2147483648 then', '  if f_active >= 200 or f_bytes + p_size_bytes > 2147483648 then',
      async () => { const open = await Promise.all(Array.from({ length: 11 }, () => begin(A, 10)));
        const r = open.every((o) => (o.data as { status: string }).status === 'upload');
        await sql(OWNER, `delete from private.postona_media_assets where owner_user_id = '${A.id}' and status = 'pending'`); return r; }],
    ['MB10 complete checks the stored size', "     or f_size::bigint is distinct from v_row.declared_bytes then", '     or false then',
      async () => { const u = (await begin(A)).data as Upload; await A.client.storage.from(BUCKET).upload(u.upload.object_path, bytes(PNG.byteLength + 5), { contentType: 'image/png' });
        const st = ((await A.client.rpc('postona_media_complete_upload', { p_asset_id: u.asset.id })).data as { status: string }).status; await mb.deleteMedia(A.client, u.asset.id); return st === 'ready'; }],
    ['MB11 list is the caller\'s', "     where a.owner_user_id = v_user and a.workspace_id = v_ws and a.status = 'ready'\n       and (p_before_created_at", "     where a.status = 'ready'\n       and (p_before_created_at",
      async () => ((await mb.listMedia(B.client, 50)) as { items: Array<{ id: string }> }).items.some((x) => x.id === ready.asset.id)],
    ['MB12 delete is the caller\'s', "  select * into v_row from private.postona_media_assets a\n   where a.id = p_asset_id and a.owner_user_id = v_user and a.workspace_id = v_ws for update;\n  if not found then\n    return pg_catalog.jsonb_build_object('status', 'MEDIA_NOT_FOUND');\n  end if;\n  v_already",
      "  select * into v_row from private.postona_media_assets a\n   where a.id = p_asset_id for update;\n  if not found then\n    return pg_catalog.jsonb_build_object('status', 'MEDIA_NOT_FOUND');\n  end if;\n  v_already",
      async () => { const st = await status(B.client, 'postona_media_delete', { p_asset_id: ready.asset.id });
        if (st === 'deleted') await sql(OWNER, `update private.postona_media_assets set status = 'ready', deleted_at = null where id = '${ready.asset.id}'`); return st === 'deleted'; }],
    ['MB13 a retry must ask the same thing', '    if v_row.workspace_id <> v_ws or v_row.content_type <> p_content_type or v_row.declared_bytes <> p_size_bytes or v_row.display_name <> v_name then',
      '    if v_row.workspace_id <> v_ws then',
      async () => { const rid = crypto.randomUUID(); await A.client.rpc('postona_media_begin_upload', { p_request_id: rid, p_file_name: 'a.png', p_content_type: 'image/png', p_size_bytes: 10 });
        const st = await status(A.client, 'postona_media_begin_upload', { p_request_id: rid, p_file_name: 'a.png', p_content_type: 'image/png', p_size_bytes: 11 });
        await sql(OWNER, `delete from private.postona_media_assets where request_id = '${rid}'`); return st === 'upload'; }],
  ];
  const killed: string[] = [];
  try {
    for (const [label, from, to, broken] of cases) {
      assert.equal(await broken(), false, `${label}: the original holds`);
      assert.equal(text.split(from).length, 2, `${label}: site`);
      const r = await psql(OWNER, ['-f', '-'], text.replace(from, to));
      assert.ok(r.ok, `${label}: mutant install\n${r.error}`);
      try {
        assert.equal(await broken(), true, `${label}: survived`);
        killed.push(label.split(' ')[0]);
      } finally {
        await ok(MEDIA, INSTALL);
      }
    }
  } finally {
    await ok(MEDIA, INSTALL);
  }
  assert.equal(await readBack(A.client, ready.asset), await sha(PNG), 'the reviewed file is back');
  console.log(`G5-02 #5 media mutants killed ${killed.length} / ${cases.length}: ${killed.join(' ')}`);
  assert.equal(killed.length, cases.length);
});
