// G5-02 task 5: the POSTONA media box (supabase/candidates/postona_personal_media_box) on the REAL local Supabase runtime, run by
// postona_personal_workspace_local_run.sh after the workspace suite: GoTrue ES256 JWTs, PostgREST, Kong, storage-api v1.70.3 with its local
// file backend (real bytes written, read back by signed URL and removed), PG 17.6.1.165. The person's calls go through the G5-owned client
// module (client.ts) over supabase-js 2.115.0, as G1 will make them. Network: only the local API / fake ports (the runner's --allow-net).
// G5-02 #6: the H1 F1 / F2 / F3 cases run first on PR #636's own install (before: each FAIL reproduced), then on this tree's (after).
import assert from 'node:assert/strict';
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.115.0';

const API = Deno.env.get('G5LS_API') ?? '';
const PUBLISHABLE = Deno.env.get('G5LS_PUBLISHABLE') ?? '';
const SECRET = Deno.env.get('G5LS_SECRET') ?? '';
const DB_PORT = Deno.env.get('G5LS_DB_PORT') ?? '';
const MVP = Deno.env.get('G5LS_MVP') ?? '';
const MEDIA = Deno.env.get('G5LS_MEDIA') ?? '';
const PR636 = Deno.env.get('G5LS_PR636') ?? '';
const enabled = API !== '' && PUBLISHABLE !== '' && SECRET !== '' && MVP !== '' && MEDIA !== '' && PR636 !== '';
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
// PostgREST keeps its own view of the functions: after an install or a rollback, reload it and wait until the box answers again
async function reloadApi() {
  await sql(SUPER, `notify pgrst, 'reload schema'`);
  const probe = newClient();
  for (let i = 0; i < 100; i++) {
    const r = await probe.rpc('postona_media_list', { p_limit: 1 });
    if (r.error?.code === '42501' || r.error === null) return;   // anon is refused by EXECUTE: the function is there
    await new Promise((res) => setTimeout(res, 100));
  }
}
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
// the person's own read: storage-api's authenticated download with their JWT (G5-02 #6: no signed URL exists)
async function readBack(c: SupabaseClient, asset: { bucket: string; object_path: string }): Promise<string> {
  const d = await mb.mediaDownload(c, asset);
  if (!d.ok) return `${d.class}:${d.status}`;
  return await sha(new Uint8Array(await d.blob.arrayBuffer()));
}
type Begun = { status: string; asset: { id: string; object_path: string; display_name: string; bucket: string }; upload: { bucket: string; object_path: string; final_path: string; moved: boolean } };
// upload to the staging key, then storage-api's move onto the final key (as client.ts does); the first error, or null
async function stage(c: SupabaseClient, b: Begun, body: Uint8Array, contentType: string) {
  const u = await c.storage.from(BUCKET).upload(b.upload.object_path, body, { contentType });
  if (u.error) return u.error;
  return (await c.storage.from(BUCKET).move(b.upload.object_path, b.upload.final_path)).error;
}
// ready rows without objects, as the owner (the counting is what is tested)
const seed = (p: Person, count: number, size: number) => sql(OWNER, `insert into private.postona_media_assets (id, owner_user_id, workspace_id, request_id, bucket_id, object_path, staging_path, kind, content_type, display_name, declared_bytes, stored_bytes, object_version, status, upload_expires_at, ready_at)
    select g.id, '${p.id}', '${p.ws}', gen_random_uuid(), '${BUCKET}', '${p.ws}/' || g.id || '.png', '${p.ws}/staging/' || g.id || '.png', 'image', 'image/png', 'seed', ${size}, ${size}, 'seed', 'ready', now(), now()
      from (select gen_random_uuid() id from generate_series(1, ${count})) g`);
const orphans = () => sql(OWNER, `select coalesce(string_agg(kind || ':' || object_path, ' '), '') from private.postona_media_orphans()`);
// the operator's (and storage-api's own) writes: the local service key, never on a device
const service = () => createClient(API, SECRET, { auth: { persistSession: false, autoRefreshToken: false } });

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
Deno.test({ name: 'the person: add (begin -> upload to the staging key -> move onto the final key -> complete) -> list (newest first, pages) -> read back with the person\'s own JWT (the same SHA-256) -> delete (row, then objects) -> gone; a retry of each step is safe', ...opts }, async () => {
  const A = await person('A');
  const rid = crypto.randomUUID();
  const args = { p_request_id: rid, p_file_name: '../../etc/いちごタルト.png', p_content_type: 'image/png', p_size_bytes: PNG.byteLength };
  const begun = await A.client.rpc('postona_media_begin_upload', args);
  SAMPLES.begin = begun.data;
  const b = begun.data as Begun;
  assert.equal(b.status, 'upload');
  assert.equal(b.asset.display_name, 'いちごタルト.png', 'only the last path segment is kept, as a display name');
  assert.match(b.upload.object_path, new RegExp(`^${A.ws}/staging/[0-9a-f-]{36}\\.png$`, 'u'), 'the server chose the staging key');
  assert.equal(b.upload.final_path, b.asset.object_path);
  assert.match(b.asset.object_path, new RegExp(`^${A.ws}/[0-9a-f-]{36}\\.png$`, 'u'), 'and the final key');
  assert.equal(await status(A.client, 'postona_media_begin_upload', args), 'upload', 'a retry: the same asset');
  assert.equal(await status(A.client, 'postona_media_complete_upload', { p_asset_id: b.asset.id }), 'MEDIA_OBJECT_MISSING', 'nothing uploaded yet');
  assert.equal((await A.client.storage.from(BUCKET).upload(b.upload.object_path, PNG, { contentType: 'image/png', upsert: false })).error, null);
  assert.equal(await status(A.client, 'postona_media_complete_upload', { p_asset_id: b.asset.id }), 'MEDIA_MOVE_REQUIRED', 'staged, not moved');
  assert.equal((await A.client.storage.from(BUCKET).move(b.upload.object_path, b.upload.final_path)).error, null, 'storage-api\'s move onto the final key');
  assert.equal(((await A.client.rpc('postona_media_begin_upload', args)).data as Begun).upload.moved, true, 'a retry now goes straight to complete');
  const done = await A.client.rpc('postona_media_complete_upload', { p_asset_id: b.asset.id });
  SAMPLES.complete = done.data;
  assert.equal((done.data as { status: string }).status, 'ready');
  assert.equal(await status(A.client, 'postona_media_complete_upload', { p_asset_id: b.asset.id }), 'ready', 'complete again: the same');
  assert.equal(await assetRow(b.asset.id), `ready:${PNG.byteLength}`);
  assert.equal(await sql(SUPER, `select (object_version = (select version from storage.objects where name = a.object_path)) || ':' || (object_etag is not null) from private.postona_media_assets a where id = '${b.asset.id}'`), 'true:true', 'the version and eTag are pinned');
  assert.equal(await readBack(A.client, b.asset), await sha(PNG), 'the stored bytes are the uploaded bytes');

  // through the client module: a 1.5 MB JPEG and a 1 MB MP4, then pages of 2
  const jpg = bytes(1_500_000, 0xff);
  const mp4 = bytes(1_000_000, 0x00);
  const j = await mb.addMedia(A.client, file('朝の一枚.jpg', 'image/jpeg', jpg), crypto.randomUUID());
  const v = await mb.addMedia(A.client, file('clip.mp4', 'video/mp4', mp4), crypto.randomUUID());
  assert.ok(j.ok && v.ok, JSON.stringify([j, v]));
  assert.equal(await readBack(A.client, j.asset), await sha(jpg));
  assert.equal(await readBack(A.client, v.asset), await sha(mp4));
  const src = mb.mediaReadSource(`${API}/storage/v1`, (await A.client.auth.getSession()).data.session!.access_token, v.asset);
  assert.equal(await sha(new Uint8Array(await (await fetch(src.uri, { headers: src.headers })).arrayBuffer())), await sha(mp4), 'the <Image> / player source reads the same bytes');
  const page1 = await mb.listMedia(A.client, 2);
  SAMPLES.list = (await A.client.rpc('postona_media_list', { p_limit: 2 })).data;
  assert.ok(page1.ok);
  assert.deepEqual(page1.items.map((x: { id: string }) => x.id), [v.asset.id, j.asset.id], 'newest first');
  const page2 = await mb.listMedia(A.client, 2, page1.next);
  assert.ok(page2.ok);
  assert.deepEqual(page2.items.map((x: { id: string }) => x.id), [b.asset.id]);
  assert.equal(page2.next, null);
  assert.equal(await status(A.client, 'postona_media_list', { p_limit: 51 }), 'MEDIA_INPUT_INVALID');

  // delete: the row (it leaves the list at once), then the objects through storage-api; again: already
  const del = await A.client.rpc('postona_media_delete', { p_asset_id: j.asset.id });
  SAMPLES.delete = del.data;
  assert.match(await readBack(A.client, j.asset), /^(not_found|invalid):STORAGE_(404|400)$/u, 'no read the moment the row is deleted');
  assert.deepEqual(await mb.deleteMedia(A.client, j.asset.id), { ok: true, already: true });
  assert.equal(await objects(j.asset.object_path), '0', 'the bytes are gone');
  assert.equal(await assetRow(j.asset.id), `deleted:${jpg.byteLength}`);
  assert.deepEqual(((await mb.listMedia(A.client, 10)) as { items: Array<{ id: string }> }).items.map((x) => x.id), [v.asset.id, b.asset.id]);
  assert.equal(await status(A.client, 'postona_media_complete_upload', { p_asset_id: j.asset.id }), 'MEDIA_NOT_FOUND');
  console.log(`G5-02 #6 samples ${JSON.stringify(SAMPLES)}`);
});

Deno.test({ name: 'another person, anon and forged paths: B can neither list, read, sign, download, complete, delete, overwrite, move nor remove A\'s asset; B uploads only to the staging key the server gave B; anon gets nothing', ...opts }, async () => {
  const A = await person('A2');
  const B = await person('B2');
  const a = await mb.addMedia(A.client, file('a.png', 'image/png', PNG), crypto.randomUUID());
  assert.ok(a.ok);
  assert.equal(await status(B.client, 'postona_media_complete_upload', { p_asset_id: a.asset.id }), 'MEDIA_NOT_FOUND');
  assert.equal(await status(B.client, 'postona_media_delete', { p_asset_id: a.asset.id }), 'MEDIA_NOT_FOUND');
  assert.deepEqual(((await mb.listMedia(B.client, 50)) as { items: unknown[] }).items, []);
  assert.match(await readBack(B.client, a.asset), /^(not_found|invalid):STORAGE_(404|400)$/u, 'no download of A\'s object');
  assert.notEqual((await B.client.storage.from(BUCKET).createSignedUrl(a.asset.object_path, 60)).error, null, 'no signed URL');
  assert.notEqual((await B.client.storage.from(BUCKET).upload(a.asset.object_path, PNG, { contentType: 'image/png', upsert: true })).error, null, 'no overwrite');
  assert.notEqual((await B.client.storage.from(BUCKET).move(a.asset.object_path, `${B.ws}/x.png`)).error, null, 'no move');
  assert.deepEqual((await B.client.storage.from(BUCKET).remove([a.asset.object_path])).data, [], 'remove touches nothing');
  assert.equal(await objects(a.asset.object_path), '1');
  assert.equal(await readBack(A.client, a.asset), await sha(PNG), 'A\'s bytes are untouched');

  // forged paths: B begins an upload of its own, then tries every other path (the final keys included: no upload ever reaches one)
  const bb = (await B.client.rpc('postona_media_begin_upload', { p_request_id: crypto.randomUUID(), p_file_name: 'b.png', p_content_type: 'image/png', p_size_bytes: PNG.byteLength })).data as Begun;
  const leaf = bb.upload.object_path.split('/').pop()!;
  const forged = [`${A.ws}/staging/${crypto.randomUUID()}.png`, `${A.ws}/staging/${leaf}`, bb.upload.final_path, `${B.ws}/${crypto.randomUUID()}.png`,
    `${B.ws}/staging/${crypto.randomUUID()}.png`, `${B.ws}/staging/../${leaf}`, `../${A.ws}/x.png`, `${bb.upload.object_path}/../../${A.ws}/x.png`,
    `${B.ws}/staging/${leaf}.png`, bb.upload.object_path.toUpperCase()];
  for (const path of forged) {
    assert.notEqual((await B.client.storage.from(BUCKET).upload(path, PNG, { contentType: 'image/png' })).error, null, `B uploaded to ${path}`);
  }
  assert.equal(await sql(SUPER, `select count(*) from storage.objects where bucket_id = '${BUCKET}' and owner_id = '${B.id}'`), '0', 'nothing of B\'s was stored');
  // a doubled slash is collapsed by the client library before it is sent: it lands on exactly the staging key the server gave (measured)
  assert.equal((await B.client.storage.from(BUCKET).upload(`${B.ws}/staging//${leaf}`, PNG, { contentType: 'image/png' })).error, null);
  assert.equal(await sql(SUPER, `select string_agg(name, ' ') from storage.objects where bucket_id = '${BUCKET}' and owner_id = '${B.id}'`), bb.upload.object_path);
  // B's move may go only onto B's own final key
  assert.notEqual((await B.client.storage.from(BUCKET).move(bb.upload.object_path, `${A.ws}/${leaf}`)).error, null, 'not onto A\'s workspace');
  assert.notEqual((await B.client.storage.from(BUCKET).move(bb.upload.object_path, `${B.ws}/${crypto.randomUUID()}.png`)).error, null, 'not onto another key');
  assert.equal((await B.client.storage.from(BUCKET).move(bb.upload.object_path, bb.upload.final_path)).error, null);

  const anon = newClient();
  for (const [fn, args] of [['postona_media_list', { p_limit: 10 }], ['postona_media_begin_upload', { p_request_id: crypto.randomUUID(), p_file_name: 'x', p_content_type: 'image/png', p_size_bytes: 1 }],
    ['postona_media_delete', { p_asset_id: a.asset.id }]] as Array<[string, Record<string, unknown>]>) {
    assert.equal((await anon.rpc(fn, args)).error?.code, '42501', fn);
  }
  assert.notEqual((await anon.storage.from(BUCKET).download(a.asset.object_path)).error, null);
  assert.notEqual((await anon.storage.from(BUCKET).upload(`${A.ws}/staging/${crypto.randomUUID()}.png`, PNG, { contentType: 'image/png' })).error, null);
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
    assert.notEqual((await c.storage.from(BUCKET).download(a.asset.object_path)).error, null, `${label}: read`);
  };
  const gone = newClient();
  assert.ok((await gone.auth.signInWithPassword({ email: A.email, password: A.password })).data.session);
  await gone.auth.signOut({ scope: 'local' });
  await refusedAll(gone, 'HTTP:42501', 'no session');
  const old = createClient(API, PUBLISHABLE, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${A.token}` } } });
  const s2 = newClient();
  assert.ok((await s2.auth.signInWithPassword({ email: A.email, password: A.password })).data.session);
  await A.client.auth.signOut({ scope: 'local' });
  await refusedAll(old, 'SESSION_REVOKED', 'signed out (JWT within exp)');
  A.client = s2;
  assert.equal(await readBack(A.client, a.asset), await sha(PNG), 'a live session of A still works');
  await sql(SUPER, `update auth.sessions set not_after = now() - interval '1 second' where user_id = '${A.id}'`);
  await refusedAll(s2, 'SESSION_EXPIRED', 'expired session');
  await sql(SUPER, `update auth.sessions set not_after = null where user_id = '${A.id}'`);
  assert.equal(await status(A.client, 'postona_media_list', { p_limit: 5 }), 'ok');
  await sql(SUPER, `update public.service_entitlements set status = 'ended', ended_at = now() where user_id = '${A.id}' and service_key = 'x_autopost'`);
  await refusedAll(A.client, 'SERVICE_NOT_ACTIVE', 'service ended');
  const re = await A.client.rpc('reactivate_x_autopost_service', { p_expected_lifecycle_version: Number(await sql(SUPER, `select lifecycle_version from public.common_accounts where user_id = '${A.id}'`)) });
  assert.equal((re.data as { status: string } | null)?.status, 'active', JSON.stringify(re.error));
  assert.equal(await readBack(A.client, a.asset), await sha(PNG), 'restarted: the same asset again');
  await sql(SUPER, `update public.common_accounts set status = 'locked' where user_id = '${A.id}'`);
  await refusedAll(A.client, 'ACCOUNT_LOCKED', 'locked');
  await sql(SUPER, `update public.common_accounts set status = 'active' where user_id = '${A.id}'`);
  await sql(SUPER, `delete from public.brand_memberships where user_id = '${A.id}'`);
  await refusedAll(A.client, 'WORKSPACE_OWNER_UNKNOWN', 'membership removed');
  await sql(SUPER, `insert into public.brand_memberships (brand_id, user_id, role) values ('${A.ws}', '${A.id}', 'owner')`);
  assert.equal(await readBack(A.client, a.asset), await sha(PNG));
  const N = await person('N3', false);
  assert.equal(await status(N.client, 'postona_media_list', { p_limit: 5 }), 'WORKSPACE_REQUIRED');
  assert.equal(await status(N.client, 'postona_media_begin_upload', { p_request_id: crypto.randomUUID(), p_file_name: 'x.png', p_content_type: 'image/png', p_size_bytes: 1 }), 'WORKSPACE_REQUIRED');
  const B = await person('B3');
  const device = newClient();
  const ids = async () => ((await mb.listMedia(device, 50)) as { items: Array<{ id: string }> }).items.map((x) => x.id);
  await device.auth.signInWithPassword({ email: A.email, password: A.password });
  assert.deepEqual(await ids(), [a.asset.id]);
  await device.auth.signOut({ scope: 'local' });
  await device.auth.signInWithPassword({ email: B.email, password: B.password });
  assert.deepEqual(await ids(), []);
  assert.notEqual((await device.storage.from(BUCKET).download(a.asset.object_path)).error, null);
  await device.auth.signOut({ scope: 'local' });
  await device.auth.signInWithPassword({ email: A.email, password: A.password });
  assert.deepEqual(await ids(), [a.asset.id]);
});

Deno.test({ name: 'limits and failures: unsupported type, empty / oversize declarations, bytes or type that differ from the declaration, the bucket\'s own limits, retries and conflicts, two at once, an expired upload, never-removed objects (orphans), quotas', ...opts }, async () => {
  const A = await person('A4');
  const begin = (ct: string, size: number, rid = crypto.randomUUID(), name = 'x') => A.client.rpc('postona_media_begin_upload', { p_request_id: rid, p_file_name: name, p_content_type: ct, p_size_bytes: size });
  const st = async (p: PromiseLike<{ data: unknown; error: unknown }>) => String(((await p).data as { status: string }).status);
  assert.equal(await st(begin('image/gif', 10)), 'MEDIA_TYPE_UNSUPPORTED');
  assert.equal(await st(begin('IMAGE/PNG', 10)), 'MEDIA_TYPE_UNSUPPORTED', 'exact types only');
  assert.equal(await st(begin('image/png', 0)), 'MEDIA_INPUT_INVALID');
  assert.equal(await st(begin('image/png', 20971521)), 'MEDIA_TOO_LARGE');
  assert.equal(await st(begin('video/mp4', 52428801)), 'MEDIA_TOO_LARGE');
  for (const [label, body, ct] of [['more bytes', bytes(PNG.byteLength + 1), 'image/png'], ['another type', PNG, 'image/jpeg']] as Array<[string, Uint8Array, string]>) {
    const b = (await begin('image/png', PNG.byteLength)).data as Begun;
    assert.equal(await stage(A.client, b, body, ct), null, label);
    assert.equal(await status(A.client, 'postona_media_complete_upload', { p_asset_id: b.asset.id }), 'MEDIA_OBJECT_MISMATCH', label);
    assert.equal(await assetRow(b.asset.id), 'pending:-', label);
    assert.deepEqual(await mb.deleteMedia(A.client, b.asset.id), { ok: true, already: false }, `${label}: cleaned up by the person`);
    assert.equal(await objects(b.asset.object_path), '0', `${label}: the object went too`);
  }
  {
    const b = (await begin('video/mp4', 52428800)).data as Begun;
    assert.notEqual((await A.client.storage.from(BUCKET).upload(b.upload.object_path, bytes(10), { contentType: 'text/plain' })).error, null, 'text/plain refused by the bucket');
    assert.notEqual((await A.client.storage.from(BUCKET).upload(b.upload.object_path, bytes(52428801), { contentType: 'video/mp4' })).error, null, 'over 50 MiB refused by the bucket');
    assert.equal(await objects(b.upload.object_path), '0');
    assert.equal(await status(A.client, 'postona_media_complete_upload', { p_asset_id: b.asset.id }), 'MEDIA_OBJECT_MISSING');
    await mb.deleteMedia(A.client, b.asset.id);
  }
  const rid = crypto.randomUUID();
  const [x1, x2] = await Promise.all([begin('image/png', PNG.byteLength, rid, 'p.png'), begin('image/png', PNG.byteLength, rid, 'p.png')]);
  const b1 = x1.data as Begun;
  assert.equal((x2.data as Begun).asset.id, b1.asset.id, 'two begins at once: one asset');
  assert.equal(await st(begin('image/png', PNG.byteLength + 1, rid, 'p.png')), 'MEDIA_REQUEST_CONFLICT');
  assert.equal(await st(begin('image/png', PNG.byteLength, rid, 'q.png')), 'MEDIA_REQUEST_CONFLICT');
  const ups = await Promise.all([A.client.storage.from(BUCKET).upload(b1.upload.object_path, PNG, { contentType: 'image/png' }), A.client.storage.from(BUCKET).upload(b1.upload.object_path, PNG, { contentType: 'image/png' })]);
  console.log(`G5-02 #6 two staging uploads at once: ${JSON.stringify(ups.map((u) => u.error?.statusCode ?? 'ok'))}`);
  assert.ok(ups.some((u) => u.error === null) && ups.every((u) => u.error === null || String(u.error.statusCode) === '409'));
  const mvs = await Promise.all([A.client.storage.from(BUCKET).move(b1.upload.object_path, b1.upload.final_path), A.client.storage.from(BUCKET).move(b1.upload.object_path, b1.upload.final_path)]);
  assert.equal(mvs.filter((m) => m.error === null).length, 1, `two moves at once: one (${JSON.stringify(mvs.map((m) => m.error?.statusCode ?? 'ok'))})`);
  assert.deepEqual(await Promise.all([status(A.client, 'postona_media_complete_upload', { p_asset_id: b1.asset.id }), status(A.client, 'postona_media_complete_upload', { p_asset_id: b1.asset.id })]), ['ready', 'ready']);
  const again = await mb.addMedia(A.client, file('p.png', 'image/png', PNG), rid);
  assert.ok(again.ok && again.asset.id === b1.asset.id, 'the client module retried the whole add: the same asset');
  assert.deepEqual(await Promise.all([status(A.client, 'postona_media_delete', { p_asset_id: b1.asset.id }), status(A.client, 'postona_media_delete', { p_asset_id: b1.asset.id })]), ['deleted', 'deleted']);
  assert.equal(await objects(b1.asset.object_path), '1');
  assert.match(await orphans(), new RegExp(`object_without_asset:${b1.asset.object_path}`, 'u'));
  assert.equal(await st(begin('image/png', PNG.byteLength, rid, 'p.png')), 'MEDIA_NOT_FOUND', 'a deleted request is not reopened');
  assert.deepEqual(await mb.deleteMedia(A.client, b1.asset.id), { ok: true, already: true });
  assert.equal(await objects(b1.asset.object_path), '0');
  {
    const b = (await begin('image/png', PNG.byteLength)).data as Begun;
    await sql(SUPER, `update private.postona_media_assets set upload_expires_at = now() - interval '1 second' where id = '${b.asset.id}'`);
    assert.notEqual((await A.client.storage.from(BUCKET).upload(b.upload.object_path, PNG, { contentType: 'image/png' })).error, null);
    assert.equal(await status(A.client, 'postona_media_complete_upload', { p_asset_id: b.asset.id }), 'MEDIA_UPLOAD_EXPIRED');
    assert.match(await orphans(), new RegExp(`expired_upload:${b.upload.object_path}`, 'u'));
    await mb.deleteMedia(A.client, b.asset.id);
  }
  const open = await Promise.all(Array.from({ length: 10 }, () => begin('image/png', 10)));
  assert.ok(open.every((o) => (o.data as { status: string }).status === 'upload'));
  assert.equal(await st(begin('image/png', 10)), 'MEDIA_QUOTA_EXCEEDED', 'the 11th open upload');
  for (const o of open) await mb.deleteMedia(A.client, (o.data as Begun).asset.id);
  await seed(A, 199, 10);
  assert.equal(await st(begin('image/png', 10)), 'upload', '199 + 1');
  assert.equal(await st(begin('image/png', 10)), 'MEDIA_QUOTA_EXCEEDED', 'the 201st asset');
  await sql(OWNER, `delete from private.postona_media_assets where owner_user_id = '${A.id}'`);
  await seed(A, 100, 21474836);
  assert.equal(await st(begin('image/png', 49)), 'MEDIA_QUOTA_EXCEEDED', '2 147 483 600 + 49 > 2 GiB');
  assert.equal(await st(begin('image/png', 48)), 'upload', '2 147 483 600 + 48 = 2 GiB');
  await sql(OWNER, `delete from private.postona_media_assets where owner_user_id = '${A.id}'`);
});

// ---- G5-02 #6: H1 F1 / F2 / F3 on PR #636's own files (before), then this tree (after) -----------------------------------------------
async function emptyBox() {
  await sql(OWNER, `update private.postona_media_assets set status = 'deleted', deleted_at = now() where status <> 'deleted'`);
  const left = (await sql(SUPER, `select coalesce(string_agg(name, ' '), '') from storage.objects where bucket_id = '${BUCKET}'`)).split(' ').filter(Boolean);
  for (let i = 0; i < left.length; i += 100) assert.equal((await service().storage.from(BUCKET).remove(left.slice(i, i + 100))).error, null);
  assert.equal(await sql(SUPER, `select count(*) from storage.objects where bucket_id = '${BUCKET}'`), '0');
}
const FOUND: Record<string, string> = {};
Deno.test({ name: 'H1 F1 / F2 / F3 BEFORE (PR #636 installed): a ready asset\'s key takes a later write (simulated as storage-api\'s own write) and then serves 25 MiB under a 70-byte image; the person signs a 1-year URL that still reads after sign-out, service end and the stop; an expired pending asset with an object leaves the quota and a late complete makes 201 ready assets', ...opts }, async () => {
  await emptyBox();
  await ok(MEDIA, ROLLBACK);
  await ok(PR636, INSTALL);
  await reloadApi();
  try {
    // F1: one real asset made ready the PR #636 way; then a write onto its key that storage-api performs after its permission check
    // (simulated with the service key: storage-api's completeUpload writes as storage-api, measured to commit after the check)
    const A = await person('A6b');
    const b = (await A.client.rpc('postona_media_begin_upload', { p_request_id: crypto.randomUUID(), p_file_name: 'a.png', p_content_type: 'image/png', p_size_bytes: PNG.byteLength })).data as { asset: { id: string }; upload: { object_path: string } };
    assert.equal((await A.client.storage.from(BUCKET).upload(b.upload.object_path, PNG, { contentType: 'image/png' })).error, null);
    assert.equal(await status(A.client, 'postona_media_complete_upload', { p_asset_id: b.asset.id }), 'ready');
    const big = bytes(26_214_400, 7);
    assert.equal((await service().storage.from(BUCKET).upload(b.upload.object_path, big, { contentType: 'image/png', upsert: true })).error, null);
    const listed = ((await A.client.rpc('postona_media_list', { p_limit: 5 })).data as { items: Array<{ id: string; bytes: number }> }).items;
    const signed = await A.client.storage.from(BUCKET).createSignedUrl(b.upload.object_path, 60);
    const served = new Uint8Array(await (await fetch(signed.data!.signedUrl)).arrayBuffer());
    assert.deepEqual([listed.find((x) => x.id === b.asset.id)?.bytes, served.byteLength, await sha(served) === await sha(big)], [PNG.byteLength, big.byteLength, true],
      'FAIL reproduced: listed as a 70-byte ready image, it serves 25 MiB');
    FOUND.F1 = `ready 70 B listed, ${served.byteLength} B served`;

    // F2: the person's own sign with a year's expiry, then sign-out / service end / stop: the URL still reads
    const year = await A.client.storage.from(BUCKET).createSignedUrl(b.upload.object_path, 31_536_000);
    assert.equal(year.error, null, 'a year-long URL is issued');
    const token = new URL(year.data!.signedUrl).searchParams.get('token')!;
    const claims = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    assert.equal(claims.exp - claims.iat, 31_536_000);
    await A.client.auth.signOut({ scope: 'local' });
    await sql(SUPER, `update public.service_entitlements set status = 'ended', ended_at = now() where user_id = '${A.id}' and service_key = 'x_autopost'`);
    assert.equal((await fetch(year.data!.signedUrl)).status, 200, 'FAIL reproduced: signed out and service ended, the URL still reads');
    FOUND.F2 = `exp-iat=${claims.exp - claims.iat}s, reads after sign-out + service end`;

    // F3: an expired pending asset holding an object, then 199 more real assets (200 with the first ready one): the quota answers "full",
    // and the late complete makes the 201st
    const C = await person('C6b');
    const late = (await C.client.rpc('postona_media_begin_upload', { p_request_id: crypto.randomUUID(), p_file_name: 'late.png', p_content_type: 'image/png', p_size_bytes: PNG.byteLength })).data as { asset: { id: string }; upload: { object_path: string } };
    assert.equal((await C.client.storage.from(BUCKET).upload(late.upload.object_path, PNG, { contentType: 'image/png' })).error, null);
    await sql(SUPER, `update private.postona_media_assets set upload_expires_at = now() - interval '1 second' where id = '${late.asset.id}'`);
    for (let i = 0; i < 200; i++) {
      const r = (await C.client.rpc('postona_media_begin_upload', { p_request_id: crypto.randomUUID(), p_file_name: `p${i}.png`, p_content_type: 'image/png', p_size_bytes: PNG.byteLength })).data as { status: string; asset: { id: string }; upload: { object_path: string } };
      assert.equal(r.status, 'upload', `asset ${i + 1}`);
      assert.equal((await C.client.storage.from(BUCKET).upload(r.upload.object_path, PNG, { contentType: 'image/png' })).error, null);
      assert.equal(await status(C.client, 'postona_media_complete_upload', { p_asset_id: r.asset.id }), 'ready');
    }
    assert.equal(await status(C.client, 'postona_media_begin_upload', { p_request_id: crypto.randomUUID(), p_file_name: 'x.png', p_content_type: 'image/png', p_size_bytes: 10 }), 'MEDIA_QUOTA_EXCEEDED');
    assert.equal(await status(C.client, 'postona_media_complete_upload', { p_asset_id: late.asset.id }), 'ready');
    const readyCount = await sql(SUPER, `select count(*) from private.postona_media_assets where owner_user_id = '${C.id}' and status = 'ready'`);
    assert.equal(readyCount, '201', 'FAIL reproduced: 201 ready assets');
    FOUND.F3 = `ready=${readyCount}`;
  } finally {
    await emptyBox();
    await ok(PR636, ROLLBACK);
    await ok(MEDIA, INSTALL);
    await reloadApi();
  }
  console.log(`G5-02 #6 before (PR #636): ${JSON.stringify(FOUND)}`);
});

Deno.test({ name: 'H1 F1 AFTER: the final key takes no client write in any state (upload, upsert, copy, move onto it, a second move), two different staging uploads end in one checked final object, a later write onto the staging key changes nothing ready, and a write onto the final key (simulated as storage-api\'s own) makes the asset unreadable and unlisted -- never 25 MiB under a 70-byte image', ...opts }, async () => {
  const A = await person('A6f');
  const b = (await A.client.rpc('postona_media_begin_upload', { p_request_id: crypto.randomUUID(), p_file_name: 'a.png', p_content_type: 'image/png', p_size_bytes: PNG.byteLength })).data as Begun;
  const bucket = () => A.client.storage.from(BUCKET);
  // pending: no upload / upsert onto the final key; two different bodies race on the staging key
  assert.notEqual((await bucket().upload(b.upload.final_path, PNG, { contentType: 'image/png' })).error, null, 'pending: no upload onto the final key');
  assert.notEqual((await bucket().upload(b.upload.final_path, PNG, { contentType: 'image/png', upsert: true })).error, null, 'pending: no upsert onto the final key');
  const other = bytes(5000, 3);
  await Promise.all([bucket().upload(b.upload.object_path, PNG, { contentType: 'image/png' }), bucket().upload(b.upload.object_path, other, { contentType: 'image/png' })]);
  assert.equal((await bucket().move(b.upload.object_path, b.upload.final_path)).error, null);
  const stored = Number(await sql(SUPER, `select metadata->>'size' from storage.objects where bucket_id = '${BUCKET}' and name = '${b.upload.final_path}'`));
  const verdict = await status(A.client, 'postona_media_complete_upload', { p_asset_id: b.asset.id });
  assert.equal(verdict, stored === PNG.byteLength ? 'ready' : 'MEDIA_OBJECT_MISMATCH', `the racing staging body that won (${stored} B) is checked against the declaration`);
  if (verdict !== 'ready') {
    await mb.deleteMedia(A.client, b.asset.id);
    const again = await mb.addMedia(A.client, file('a.png', 'image/png', PNG), crypto.randomUUID());
    assert.ok(again.ok);
    Object.assign(b, { asset: again.asset, upload: { ...b.upload, final_path: again.asset.object_path, object_path: again.asset.object_path.replace(/\/([^/]+)$/u, '/staging/$1') } });
  }
  const before = await readBack(A.client, b.asset);
  assert.equal(before, await sha(PNG));
  // ready: no client write reaches the final key; a second staging upload is refused too (the asset is no longer pending)
  assert.notEqual((await bucket().upload(b.upload.final_path, other, { contentType: 'image/png', upsert: true })).error, null, 'ready: no upsert onto the final key');
  assert.notEqual((await bucket().upload(b.upload.object_path, other, { contentType: 'image/png' })).error, null, 'ready: no staging upload');
  assert.notEqual((await bucket().copy(b.upload.final_path, `${A.ws}/staging/${crypto.randomUUID()}.png`)).error, null, 'no copy');
  // a write that already passed its check landing late on the staging key (simulated as storage-api's own write, with the service key)
  assert.equal((await service().storage.from(BUCKET).upload(b.upload.object_path, bytes(26_214_400, 9), { contentType: 'image/png', upsert: true })).error, null);
  assert.notEqual((await bucket().move(b.upload.object_path, b.upload.final_path)).error, null, 'a second move onto the final key fails');
  assert.equal(await readBack(A.client, b.asset), before, 'PASS: the ready bytes did not change');
  assert.match(await orphans(), new RegExp(`object_without_asset:${b.upload.object_path.replace(/\./gu, '\\.')}`, 'u'), 'the late staging object is an orphan to clean');
  // a write onto the final key that no client permission can make (storage-api's own write, simulated): the pinned version no longer
  // matches -> not readable, not listed, reported broken; it never serves the other bytes as this asset
  assert.equal((await service().storage.from(BUCKET).upload(b.upload.final_path, bytes(26_214_400, 8), { contentType: 'image/png', upsert: true })).error, null);
  assert.match(await readBack(A.client, b.asset), /^(not_found|invalid):STORAGE_(404|400)$/u, 'PASS: the replaced object is not served');
  assert.ok(!((await mb.listMedia(A.client, 50)) as { items: Array<{ id: string }> }).items.some((x) => x.id === b.asset.id), 'not listed');
  assert.match(await orphans(), new RegExp(`broken_ready:${b.asset.object_path.replace(/\./gu, '\\.')}`, 'u'));
  assert.deepEqual(await mb.deleteMedia(A.client, b.asset.id), { ok: true, already: false });
  assert.equal(await sql(SUPER, `select count(*) from storage.objects where bucket_id = '${BUCKET}' and name in ('${b.upload.final_path}', '${b.upload.object_path}')`), '0', 'the person removes both');
});

Deno.test({ name: 'H1 F2 AFTER: no signed URL can be issued (sign / sign_many, any expiry, the person\'s own ready asset), no list or copy; the person reads with their own JWT, and every read asks again: sign-out, expiry, service end, membership removal, the stop and the delete each refuse the next read at once', ...opts }, async () => {
  const A = await person('A6s');
  const a = await mb.addMedia(A.client, file('a.png', 'image/png', PNG), crypto.randomUUID());
  assert.ok(a.ok);
  const bucket = () => A.client.storage.from(BUCKET);
  for (const seconds of [31_536_000, 300, 60]) assert.notEqual((await bucket().createSignedUrl(a.asset.object_path, seconds)).error, null, `sign ${seconds}`);
  const many = await bucket().createSignedUrls([a.asset.object_path], 60);
  assert.ok(many.error !== null || (many.data ?? []).every((x) => !x.signedUrl), `sign_many: ${JSON.stringify(many.data)}`);
  const direct = await fetch(`${API}/storage/v1/object/sign/${BUCKET}/${a.asset.object_path}`, { method: 'POST', headers: { Authorization: `Bearer ${(await A.client.auth.getSession()).data.session!.access_token}`, apikey: PUBLISHABLE, 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 31_536_000 }) });
  assert.notEqual(direct.status, 200, 'PASS: the direct sign API with a year\'s expiry is refused');
  assert.deepEqual(((await bucket().list(A.ws)).data ?? []).map((o) => o.name), [], 'no list');
  assert.equal(await readBack(A.client, a.asset), await sha(PNG), 'the person\'s own read');
  const info = await fetch(`${API}/storage/v1/object/info/authenticated/${BUCKET}/${a.asset.object_path}`, { headers: { Authorization: `Bearer ${(await A.client.auth.getSession()).data.session!.access_token}`, apikey: PUBLISHABLE } });
  assert.equal(info.status, 200, 'info');
  const readAs = async (c: SupabaseClient) => (await c.storage.from(BUCKET).download(a.asset.object_path)).error === null;
  // sign-out (the JWT still within exp), expiry, service end, membership removal: each the next read
  const old = createClient(API, PUBLISHABLE, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${A.token}` } } });
  assert.ok(await readAs(old));
  const s2 = newClient();
  await s2.auth.signInWithPassword({ email: A.email, password: A.password });
  await A.client.auth.signOut({ scope: 'local' });
  assert.equal(await readAs(old), false, 'signed out: the next read is refused');
  A.client = s2;
  await sql(SUPER, `update auth.sessions set not_after = now() - interval '1 second' where user_id = '${A.id}'`);
  assert.equal(await readAs(s2), false, 'expired');
  await sql(SUPER, `update auth.sessions set not_after = null where user_id = '${A.id}'`);
  assert.ok(await readAs(s2));
  await sql(SUPER, `update public.service_entitlements set status = 'ended', ended_at = now() where user_id = '${A.id}' and service_key = 'x_autopost'`);
  assert.equal(await readAs(s2), false, 'service ended');
  await sql(SUPER, `update public.service_entitlements set status = 'active', ended_at = null where user_id = '${A.id}' and service_key = 'x_autopost'`);
  await sql(SUPER, `delete from public.brand_memberships where user_id = '${A.id}'`);
  assert.equal(await readAs(s2), false, 'membership removed');
  await sql(SUPER, `insert into public.brand_memberships (brand_id, user_id, role) values ('${A.ws}', '${A.id}', 'owner')`);
  assert.ok(await readAs(s2));
  await ok(MEDIA, STOP);
  assert.equal(await readAs(s2), false, 'the stop');
  await ok(MEDIA, INSTALL);
  assert.ok(await readAs(s2));
  await A.client.rpc('postona_media_delete', { p_asset_id: a.asset.id });
  assert.equal(await readAs(s2), false, 'deleted (the object not removed yet)');
  assert.equal((await mb.deleteMedia(A.client, a.asset.id) as { ok: boolean }).ok, true);
  const anon = newClient();
  assert.notEqual((await anon.storage.from(BUCKET).createSignedUrl(a.asset.object_path, 60)).error, null);
});

Deno.test({ name: 'H1 F3 AFTER: an expired pending asset that holds an object keeps holding quota; 199 more real assets fill the box at 200 and the late complete stays inside it; complete re-checks the limits (count and bytes) under T13\'s lock; a normal late complete, two completes at once, a retry and a delete', ...opts }, async () => {
  const C = await person('C6f');
  const begin = (name: string, size = PNG.byteLength) => C.client.rpc('postona_media_begin_upload', { p_request_id: crypto.randomUUID(), p_file_name: name, p_content_type: 'image/png', p_size_bytes: size });
  const late = (await begin('late.png')).data as Begun;
  assert.equal(await stage(C.client, late, PNG, 'image/png'), null);
  await sql(SUPER, `update private.postona_media_assets set upload_expires_at = now() - interval '1 second' where id = '${late.asset.id}'`);
  assert.match(await orphans(), new RegExp(`expired_upload_with_object:${late.asset.object_path.replace(/\./gu, '\\.')}`, 'u'), 'listed for cleanup, still holding quota');
  let made = 0;
  for (let i = 0; i < 200; i++) {
    const r = (await begin(`p${i}.png`)).data as Begun & { status: string };
    if (r.status !== 'upload') {
      assert.equal(r.status, 'MEDIA_QUOTA_EXCEEDED');
      break;
    }
    assert.equal(await stage(C.client, r, PNG, 'image/png'), null);
    assert.equal(await status(C.client, 'postona_media_complete_upload', { p_asset_id: r.asset.id }), 'ready');
    made++;
  }
  assert.equal(made, 199, 'PASS: the expired asset with an object still counts: 199 more, not 200');
  assert.equal(await status(C.client, 'postona_media_complete_upload', { p_asset_id: late.asset.id }), 'ready', 'a late complete is allowed, inside the limit');
  assert.equal(await sql(SUPER, `select count(*) from private.postona_media_assets where owner_user_id = '${C.id}' and status = 'ready'`), '200', 'PASS: never 201');
  // complete re-checks: a pending asset moved into place, then the box filled by others (seeded) -> its complete is refused
  const D = await person('D6f');
  const d = (await D.client.rpc('postona_media_begin_upload', { p_request_id: crypto.randomUUID(), p_file_name: 'd.png', p_content_type: 'image/png', p_size_bytes: PNG.byteLength })).data as Begun;
  assert.equal(await stage(D.client, d, PNG, 'image/png'), null);
  await seed(D, 199, 10);
  // while the pending asset holds an object, D holds 200: no begin
  assert.equal(await status(D.client, 'postona_media_begin_upload', { p_request_id: crypto.randomUUID(), p_file_name: 'x.png', p_content_type: 'image/png', p_size_bytes: 10 }), 'MEDIA_QUOTA_EXCEEDED');
  await seed(D, 1, 10);
  assert.equal(await status(D.client, 'postona_media_complete_upload', { p_asset_id: d.asset.id }), 'MEDIA_QUOTA_EXCEEDED', 'PASS: complete refuses the 201st');
  await sql(OWNER, `delete from private.postona_media_assets where owner_user_id = '${D.id}' and display_name = 'seed' and id in (select id from private.postona_media_assets where owner_user_id = '${D.id}' and display_name = 'seed' limit 1)`);
  assert.deepEqual(await Promise.all([status(D.client, 'postona_media_complete_upload', { p_asset_id: d.asset.id }), status(D.client, 'postona_media_complete_upload', { p_asset_id: d.asset.id })]), ['ready', 'ready'], 'two completes at once, inside the limit');
  // bytes: the same re-check (complete refuses past 2 GiB)
  await sql(OWNER, `delete from private.postona_media_assets where owner_user_id = '${D.id}'`);
  const e = (await D.client.rpc('postona_media_begin_upload', { p_request_id: crypto.randomUUID(), p_file_name: 'e.png', p_content_type: 'image/png', p_size_bytes: PNG.byteLength })).data as Begun;
  assert.equal(await stage(D.client, e, PNG, 'image/png'), null);
  await seed(D, 100, 21474836);
  assert.equal(await status(D.client, 'postona_media_complete_upload', { p_asset_id: e.asset.id }), 'MEDIA_QUOTA_EXCEEDED', '2 147 483 600 + 70 > 2 GiB at complete');
  await sql(OWNER, `update private.postona_media_assets set stored_bytes = 21474835, declared_bytes = 21474835 where owner_user_id = '${D.id}' and display_name = 'seed' and id in (select id from private.postona_media_assets where owner_user_id = '${D.id}' and display_name = 'seed' limit 1)`);
  assert.equal(await status(D.client, 'postona_media_complete_upload', { p_asset_id: e.asset.id }), 'MEDIA_QUOTA_EXCEEDED', '2 147 483 599 + 70 still > 2 GiB');
  await sql(OWNER, `delete from private.postona_media_assets where owner_user_id = '${D.id}' and display_name = 'seed' and id in (select id from private.postona_media_assets where owner_user_id = '${D.id}' and display_name = 'seed' limit 1)`);
  assert.equal(await status(D.client, 'postona_media_complete_upload', { p_asset_id: e.asset.id }), 'ready', 'inside 2 GiB: ready');
  await sql(OWNER, `delete from private.postona_media_assets where owner_user_id = '${D.id}' and display_name = 'seed'`);
  console.log('G5-02 #6 2 GiB: the counting is tested with seeded rows (a real 2 GiB write NOT_RUN)');
});

Deno.test({ name: 'stop / rollback: the stop closes every path at once and keeps rows and objects; a re-install opens them again; the rollback refuses while anything is stored, then removes the box (the catalog as before it)', ...opts }, async () => {
  const A = await person('A5');
  const a = await mb.addMedia(A.client, file('a.png', 'image/png', PNG), crypto.randomUUID());
  assert.ok(a.ok);
  await ok(MEDIA, STOP);
  await ok(MEDIA, STOP);
  assert.equal((await A.client.rpc('postona_media_list', { p_limit: 5 })).error?.code, '42501');
  assert.notEqual((await A.client.storage.from(BUCKET).download(a.asset.object_path)).error, null);
  assert.notEqual((await A.client.storage.from(BUCKET).upload(`${A.ws}/staging/${crypto.randomUUID()}.png`, PNG, { contentType: 'image/png' })).error, null);
  assert.equal(await objects(a.asset.object_path), '1');
  assert.equal(await assetRow(a.asset.id), `ready:${PNG.byteLength}`);
  assert.match((await run(MEDIA, ROLLBACK)).error, /MEDIA_ROLLBACK_NOT_EMPTY: postona-media still holds objects/u);
  await ok(MEDIA, INSTALL);
  assert.equal(await readBack(A.client, a.asset), await sha(PNG), 're-installed: the same asset');
  await emptyBox();
  await ok(MEDIA, ROLLBACK);
  await ok(MEDIA, ROLLBACK);
  assert.equal(await catalog(), BEFORE.catalog, 'the catalog as before the box');
  await ok(MEDIA, INSTALL);
  await reloadApi();
});

// ---- mutants: every guard is load-bearing (each mutated install changes the answer of its own case; the reviewed file is restored) ------
Deno.test({ name: 'mutants: owner, pending-only / unexpired / staging-only upload, the version pin, no sign, removal only after delete, moves only onto the own final key, session, lifecycle, T13, quotas (open uploads, expired-with-object, complete re-check), size, list / delete owner, idempotency -- each flips its own case; the original refuses it', ...opts }, async () => {
  const text = await Deno.readTextFile(`${MEDIA}/${INSTALL}`);
  const A = await person('mA');
  const B = await person('mB');
  const ready = await mb.addMedia(A.client, file('r.png', 'image/png', PNG), crypto.randomUUID());
  assert.ok(ready.ok);
  const begin = (p: Person, size = PNG.byteLength) => p.client.rpc('postona_media_begin_upload', { p_request_id: crypto.randomUUID(), p_file_name: 'm.png', p_content_type: 'image/png', p_size_bytes: size });
  const reads = async (c: SupabaseClient, path: string) => (await c.storage.from(BUCKET).download(path)).error === null;
  const fresh = async () => (await begin(A)).data as Begun;
  // MB8's two sites (the update check and the select branch for the move), replaced as one block
  const MOVE_BLOCK = "             when 'update_check' then p_name = a.object_path and a.status = 'pending' and v_op = 'storage.object.move'\n             when 'select' then\n               -- the person's own authenticated download / info of a ready asset, at its pinned version (no sign, list or copy)\n               (p_name = a.object_path and a.status = 'ready' and p_version is not distinct from a.object_version\n                and v_op in ('storage.object.get_authenticated', 'object.get_authenticated_info'))\n               -- the move reads its source and its destination (measured: three SELECT checks, the last on the new row)\n               or (p_name in (a.staging_path, a.object_path) and a.status = 'pending' and v_op = 'storage.object.move')";
  const MOVE_BLOCK_ANY = "             when 'update_check' then a.status = 'pending' and v_op = 'storage.object.move'\n             when 'select' then\n               -- the person's own authenticated download / info of a ready asset, at its pinned version (no sign, list or copy)\n               (p_name = a.object_path and a.status = 'ready' and p_version is not distinct from a.object_version\n                and v_op in ('storage.object.get_authenticated', 'object.get_authenticated_info'))\n               -- the move reads its source and its destination (measured: three SELECT checks, the last on the new row)\n               or (a.status = 'pending' and v_op = 'storage.object.move')";
  const cases: Array<[string, string, string, () => Promise<boolean>]> = [
    ['MB1 object owner', "     where a.bucket_id = p_bucket and a.owner_user_id = v_user\n       and a.workspace_id = 'u_' || pg_catalog.substr(pg_catalog.md5(v_user::text), 1, 24)", '     where a.bucket_id = p_bucket',
      () => reads(B.client, ready.asset.object_path)],
    ['MB2 upload only while pending', "             when 'insert' then p_name = a.staging_path and a.status = 'pending' and a.upload_expires_at > pg_catalog.clock_timestamp()",
      "             when 'insert' then p_name = a.staging_path",
      async () => { const u = await fresh(); await mb.deleteMedia(A.client, u.asset.id); return (await A.client.storage.from(BUCKET).upload(u.upload.object_path, PNG, { contentType: 'image/png' })).error === null; }],
    ['MB3 upload only before expiry', "             when 'insert' then p_name = a.staging_path and a.status = 'pending' and a.upload_expires_at > pg_catalog.clock_timestamp()",
      "             when 'insert' then p_name = a.staging_path and a.status = 'pending'",
      async () => { const u = await fresh(); await sql(SUPER, `update private.postona_media_assets set upload_expires_at = now() - interval '1 second' where id = '${u.asset.id}'`);
        const r = (await A.client.storage.from(BUCKET).upload(u.upload.object_path, PNG, { contentType: 'image/png' })).error === null; await mb.deleteMedia(A.client, u.asset.id); return r; }],
    ['MB4 (F1) no upload onto the final key', "             when 'insert' then p_name = a.staging_path and a.status = 'pending'",
      "             when 'insert' then p_name in (a.staging_path, a.object_path) and a.status = 'pending'",
      async () => { const u = await fresh(); const r = (await A.client.storage.from(BUCKET).upload(u.upload.final_path, PNG, { contentType: 'image/png' })).error === null; await mb.deleteMedia(A.client, u.asset.id); return r; }],
    ['MB5 (F1) reads only at the pinned version', '               (p_name = a.object_path and a.status = \'ready\' and p_version is not distinct from a.object_version\n',
      "               (p_name = a.object_path and a.status = 'ready'\n",
      async () => { const r = await mb.addMedia(A.client, file('v.png', 'image/png', PNG), crypto.randomUUID());
        await service().storage.from(BUCKET).upload(r.asset.object_path, bytes(500, 4), { contentType: 'image/png', upsert: true });
        const x = await reads(A.client, r.asset.object_path); await mb.deleteMedia(A.client, r.asset.id); return x; }],
    ['MB6 (F2) no signed URL', "                and v_op in ('storage.object.get_authenticated', 'object.get_authenticated_info'))",
      "                and v_op in ('storage.object.get_authenticated', 'object.get_authenticated_info', 'storage.object.sign'))",
      async () => (await A.client.storage.from(BUCKET).createSignedUrl(ready.asset.object_path, 31_536_000)).error === null],
    ['MB7 a deleted asset readable only by its removal', "               or (p_name in (a.object_path, a.staging_path) and a.status = 'deleted' and v_op = 'storage.object.delete_many')",
      "               or (p_name in (a.object_path, a.staging_path) and a.status = 'deleted')",
      async () => { const r = await mb.addMedia(A.client, file('d.png', 'image/png', PNG), crypto.randomUUID()); await A.client.rpc('postona_media_delete', { p_asset_id: r.asset.id });
        const x = await reads(A.client, r.asset.object_path); await mb.deleteMedia(A.client, r.asset.id); return x; }],
    // the destination is checked twice (the WITH CHECK of the update and the SELECT of the new row, measured): each alone is masked by the
    // other, so this mutant removes both
    ['MB8 moves only onto the own final key', MOVE_BLOCK, MOVE_BLOCK_ANY,
      async () => { const u = await fresh(); await A.client.storage.from(BUCKET).upload(u.upload.object_path, PNG, { contentType: 'image/png' });
        const target = `${A.ws}/${crypto.randomUUID()}.png`; const r = (await A.client.storage.from(BUCKET).move(u.upload.object_path, target)).error === null;
        if (r) await service().storage.from(BUCKET).remove([target]); await mb.deleteMedia(A.client, u.asset.id); return r; }],
    ['MB9 Storage session gate', "  if private.postona_media_session() is distinct from 'active' then\n    return false;", "  if false then\n    return false;",
      async () => { const old = createClient(API, PUBLISHABLE, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${A.token}` } } });
        const live = newClient(); await live.auth.signInWithPassword({ email: A.email, password: A.password }); await A.client.auth.signOut({ scope: 'local' }); A.client = live;
        A.token = (await live.auth.getSession()).data.session!.access_token; return await reads(old, ready.asset.object_path); }],
    ['MB10 Storage lifecycle state', "  if private.postona_media_reader_state(v_user) is not null then\n    return false;", "  if false then\n    return false;",
      async () => { await sql(SUPER, `update public.common_accounts set status = 'locked' where user_id = '${A.id}'`);
        const x = await reads(A.client, ready.asset.object_path); await sql(SUPER, `update public.common_accounts set status = 'active' where user_id = '${A.id}'`); return x; }],
    ['MB11 writers ask T13', "    perform private.account_lifecycle_assert_active_service_write(v_user, 'x_autopost');", '    perform 1;',
      async () => { await sql(SUPER, `update public.service_entitlements set status = 'ended', ended_at = now() where user_id = '${A.id}' and service_key = 'x_autopost'`);
        const s = ((await begin(A)).data as { status: string }).status;
        await sql(SUPER, `update public.service_entitlements set status = 'active', ended_at = null where user_id = '${A.id}' and service_key = 'x_autopost'`);
        await sql(OWNER, `delete from private.postona_media_assets where owner_user_id = '${A.id}' and status = 'pending'`); return s === 'upload'; }],
    ['MB12 open-upload quota', '  if v_use.assets >= 200 or v_use.open_uploads >= 10 or v_use.bytes + p_size_bytes > 2147483648 then',
      '  if v_use.assets >= 200 or v_use.bytes + p_size_bytes > 2147483648 then',
      async () => { const open = await Promise.all(Array.from({ length: 11 }, () => begin(A, 10)));
        const r = open.every((o) => (o.data as { status: string }).status === 'upload');
        await sql(OWNER, `delete from private.postona_media_assets where owner_user_id = '${A.id}' and status = 'pending'`); return r; }],
    ['MB13 (F3) an expired upload holding an object holds quota', "  select pg_catalog.count(*) filter (where m.status = 'ready' or m.object_bytes is not null or m.window_open),",
      "  select pg_catalog.count(*) filter (where m.status = 'ready' or m.window_open),",
      async () => { const P = await person('mP'); const u = (await begin(P)).data as Begun; await stage(P.client, u, PNG, 'image/png');
        await sql(SUPER, `update private.postona_media_assets set upload_expires_at = now() - interval '1 second' where id = '${u.asset.id}'`); await seed(P, 199, 10);
        return ((await begin(P, 10)).data as { status: string }).status === 'upload'; }],
    ['MB14 (F3) complete re-checks the limits', "  if v_use.assets + 1 > 200 or v_use.bytes + f_size::bigint > 2147483648 then", '  if false then',
      async () => { const P = await person('mQ'); const u = (await begin(P)).data as Begun; await stage(P.client, u, PNG, 'image/png'); await seed(P, 200, 10);
        return await status(P.client, 'postona_media_complete_upload', { p_asset_id: u.asset.id }) === 'ready'; }],
    ['MB15 complete checks the stored size', '     or f_size::bigint is distinct from v_row.declared_bytes or f_version is null then', '     or f_version is null then',
      async () => { const u = await fresh(); await stage(A.client, u, bytes(PNG.byteLength + 5), 'image/png');
        const s = await status(A.client, 'postona_media_complete_upload', { p_asset_id: u.asset.id }); await mb.deleteMedia(A.client, u.asset.id); return s === 'ready'; }],
    ['MB16 list is the caller\'s', "     where a.owner_user_id = v_user and a.workspace_id = v_ws and a.status = 'ready'\n       and exists", "     where a.status = 'ready'\n       and exists",
      async () => ((await mb.listMedia(B.client, 50)) as { items: Array<{ id: string }> }).items.some((x) => x.id === ready.asset.id)],
    ['MB17 delete is the caller\'s', "  select * into v_row from private.postona_media_assets a\n   where a.id = p_asset_id and a.owner_user_id = v_user and a.workspace_id = v_ws for update;\n  if not found then\n    return pg_catalog.jsonb_build_object('status', 'MEDIA_NOT_FOUND');\n  end if;\n  v_already",
      "  select * into v_row from private.postona_media_assets a\n   where a.id = p_asset_id for update;\n  if not found then\n    return pg_catalog.jsonb_build_object('status', 'MEDIA_NOT_FOUND');\n  end if;\n  v_already",
      async () => { const s = await status(B.client, 'postona_media_delete', { p_asset_id: ready.asset.id });
        if (s === 'deleted') await sql(OWNER, `update private.postona_media_assets set status = 'ready', deleted_at = null where id = '${ready.asset.id}'`); return s === 'deleted'; }],
    ['MB18 a retry must ask the same thing', '    if v_row.workspace_id <> v_ws or v_row.content_type <> p_content_type or v_row.declared_bytes <> p_size_bytes or v_row.display_name <> v_name then',
      '    if v_row.workspace_id <> v_ws then',
      async () => { const rid = crypto.randomUUID(); await A.client.rpc('postona_media_begin_upload', { p_request_id: rid, p_file_name: 'a.png', p_content_type: 'image/png', p_size_bytes: 10 });
        const s = await status(A.client, 'postona_media_begin_upload', { p_request_id: rid, p_file_name: 'a.png', p_content_type: 'image/png', p_size_bytes: 11 });
        await sql(OWNER, `delete from private.postona_media_assets where request_id = '${rid}'`); return s === 'upload'; }],
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
  console.log(`G5-02 #6 media mutants killed ${killed.length} / ${cases.length}: ${killed.join(' ')}`);
  assert.equal(killed.length, cases.length);
});
