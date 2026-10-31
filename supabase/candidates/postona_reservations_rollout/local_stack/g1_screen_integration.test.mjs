// G3-02 #13: the user's path on one throw-away runtime. G1's REAL reservations screen and view rules (PR #606, pinned; extracted read-only
// by run.sh into G3LS_G1_DIR; G1's checkout is not edited) over G3's REAL stores (remote-reservation-store / remote-threads-reservation-store
// / reservation-error-actions: the wiring G1's use-reservation-ports.ts will do) and the REAL local GoTrue -> Kong -> Edge -> Postgres.
// Pressed in the order a person presses. What is NOT real here, and so NOT_VERIFIED by this test: React / React Native are the same stubs
// as G1's own harness (no device, no layout, no native input); the composer is not rendered (X rows are saved through the store the composer
// uses); the localtest Edge twins pass the release gates as enabled; 429 cannot be produced by this stack, so it alone is INJECTED at the
// fetch boundary; a "service end" and the Threads binding are SYNTHETIC rows, as in local_test.ts. Fake data; only 127.0.0.1 is reachable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const APP = join(here, '../../../../apps/social-mobile');
const ts = createRequire(join(APP, 'package.json'))('typescript');
const G1 = process.env.G3LS_G1_DIR;
const API = process.env.G3LS_API;
const PUBLISHABLE = process.env.G3LS_PUBLISHABLE;
const DB_PORT = process.env.G3LS_DB_PORT;
const X = 'postona-x-reservations-localtest';
const TH = 'postona-threads-reservations-localtest';

const g1 = (path) => pathToFileURL(join(G1, 'apps/social-mobile/src', path)).href;
const app = (path) => pathToFileURL(join(APP, 'src', path)).href;
const view = await import(g1('features/reservations/reservation-view.ts'));
const ports = await import(g1('features/reservations/reservation-ports.ts'));
const enrollment = await import(g1('domain/service-enrollment.ts'));
const { createFetchTransport, createRemoteReservationStore } = await import(app('features/schedule/remote-reservation-store.ts'));
const { createRemoteThreadsReservationStore } = await import(app('features/schedule/remote-threads-reservation-store.ts'));
const { reservationErrorAction } = await import(app('features/schedule/reservation-error-actions.ts'));

// ---- the database and the world (as local_test.ts builds them) ------------------------------------------------------------------------
const psql = (script, vars = {}) => new Promise((resolve) => {
  const args = ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', DB_PORT, '-U', 'postgres', '-d', 'postgres'];
  for (const [k, v] of Object.entries(vars)) args.push('-v', `${k}=${v}`);
  const child = execFile('psql', args, { env: { ...process.env, PGPASSWORD: 'postgres' } }, (error, stdout, stderr) => {
    resolve(error ? `ERR:${stderr.trim().split('\n')[0]}` : stdout.trim());
  });
  child.stdin.end(script);
});
const CLAIMS = "select set_config('request.jwt.claims', json_build_object('sub', :'u', 'role', 'authenticated', 'session_id', :'s', 'is_anonymous', false)::text, true) \\gset x_\n";
const claimsOf = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
const authCall = async (path, body, token) => {
  const headers = { apikey: PUBLISHABLE, 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${API}/auth/v1/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
};
const rpc = async (fn, token) => {
  const r = await fetch(`${API}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: PUBLISHABLE, authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{}' });
  return { status: r.status, body: await r.json() };
};
async function signUp(label) {
  const email = `g3ls-g1-${label}-${randomUUID().slice(0, 8)}@example.test`;
  const password = randomUUID();
  const r = await authCall('signup', { email, password });
  const j = await r.json();
  assert.equal(r.status, 200, `sign-up ${label}`);
  const c = claimsOf(j.access_token);
  return { token: j.access_token, userId: String(c.sub), sessionId: String(c.session_id), email, password };
}
async function firstRun(p) {
  assert.equal((await rpc('start_x_autopost_service', p.token)).status, 200);
  const w0 = await rpc('postona_ensure_my_personal_workspace', p.token);
  assert.equal(w0.body.status, 'ready', JSON.stringify(w0.body));
  return String(w0.body.workspace_id);
}
async function xConnect(p, label, puid) {
  const out = await psql(`begin;\n${CLAIMS}
select 1 as began from public.begin_social_mobile_x_oauth_connection(md5(:'l') || md5(:'l' || '#'), 'kabumori-social://oauth-callback', now() + interval '10 minutes') \\gset z_
select public.complete_social_mobile_x_oauth_connection((select id from public.social_account_oauth_states where state_hash = md5(:'l') || md5(:'l' || '#')),
  :'puid', '@h_' || :'puid', 'fakeXat_' || :'l', 'fakeXrt_' || :'l')::text as completed \\gset w_
commit;
select sa.id from public.social_accounts sa where sa.platform = 'x' and sa.brand_id = public.social_mobile_account_deletion_workspace(:'u'::uuid);`,
    { u: p.userId, s: p.sessionId, l: `g3ls-g1-${label}-${p.userId}`, puid });
  assert.match(out, /^sa_[0-9a-f]{24}$/u, `X connect ${label}: ${out}`);
  return out;
}
const xDisconnect = (p) => psql(`begin;\n${CLAIMS}select postona_g4_x_oauth.disconnect_x_connection()::text as d \\gset d_\ncommit;\nselect 'done';`, { u: p.userId, s: p.sessionId });
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const at = (days, hours = 0) => new Date(Date.now() + days * 86400e3 + hours * 3600e3).toISOString();
const rowState = (id) => psql("select status || '/' || revision || '/' || consent_state from postona_x_resv.reservations where id = :'i'", { i: id });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- the transport boundary: counts what the screen really sends; only this stack is reachable; 429 alone can be INJECTED --------------
const wire = { inFlight: 0, writes: [], inject: null };
const countingFetch = async (url, init) => {
  assert.ok(String(url).startsWith(`${API}/`), `egress refused: ${url}`);
  const action = (() => { try { return JSON.parse(String(init?.body ?? '{}')).action; } catch { return null; } })();
  if (['create', 'reschedule', 'reconfirm', 'cancel'].includes(action)) wire.writes.push(action);
  wire.inFlight += 1;
  try {
    if (wire.inject) return wire.inject();
    return await fetch(url, init);
  } finally {
    wire.inFlight -= 1;
  }
};
const writes = () => wire.writes.splice(0).join(',');
/** G3's real stores behind the G1 port shape: what use-reservation-ports.ts will wire, with the person's token. */
const realPorts = (getToken, fn = X) => ({
  x: createRemoteReservationStore({ transport: createFetchTransport({ url: `${API}/functions/v1/${fn}`, fetch: countingFetch, apiKey: PUBLISHABLE, allowLoopbackHttpForTests: true }), getAccessToken: () => Promise.resolve(getToken()) }),
  threads: createRemoteThreadsReservationStore({ transport: createFetchTransport({ url: `${API}/functions/v1/${TH}`, fetch: countingFetch, apiKey: PUBLISHABLE, allowLoopbackHttpForTests: true }), getAccessToken: () => Promise.resolve(getToken()) }),
  actionOf: reservationErrorAction,
});

// ---- the harness: G1's real screen source, with the same React / RN stubs as G1's own test ------------------------------------------------
const walk = (node, visit) => {
  if (Array.isArray(node)) { node.forEach((n) => walk(n, visit)); return; }
  if (!node || typeof node !== 'object') return;
  visit(node);
  walk(node.props?.children, visit);
};
const flat = (children) => [children].flat(Infinity).filter((c) => typeof c === 'string' || typeof c === 'number').join('');
const texts = (tree) => { const out = []; walk(tree, (n) => { if (['Text', 'Pill'].includes(n.type)) out.push(flat(n.props.children)); }); return out; };
const has = (tree, fragment) => texts(tree).some((t) => t.includes(fragment));
const button = (tree, label) => { let found; walk(tree, (n) => { if (!found && n.type === 'ActionButton' && n.props.label === label) found = n.props; }); return found; };
const chip = (tree, label) => { let found; walk(tree, (n) => { if (n.type === 'Chip' && n.props.label === label) found = n.props; }); return found; };
const field = (tree, label) => { let found; walk(tree, (n) => { if (n.type === 'TextInput' && n.props.accessibilityLabel === label) found = n.props; }); return found; };
const rowPress = (tree, label) => { let found; walk(tree, (n) => { if (n.type === 'Pressable' && n.props.accessibilityLabel === label) found = n.props; }); return found; };
const screenSource = await readFile(join(G1, 'apps/social-mobile/src/app/reservations/index.tsx'), 'utf8');
const screenJs = ts.transpileModule(screenSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;

function mount({ person, accounts, workspaceId, fn = X, token = person.token }) {
  const slots = []; let cursor = 0; const effects = []; const pendingEffects = [];
  const slot = (init) => { const i = cursor++; if (!(i in slots)) slots[i] = init(); return i; };
  const react = {
    useState: (initial) => { const i = slot(() => (typeof initial === 'function' ? initial() : initial)); return [slots[i], (v) => { slots[i] = typeof v === 'function' ? v(slots[i]) : v; }]; },
    useRef: (initial) => slots[slot(() => ({ current: initial }))],
    useEffect: (effect, deps) => {
      const i = cursor++;
      const previous = effects[i];
      if (!previous || !deps || deps.length !== previous.deps.length || deps.some((d, k) => !Object.is(d, previous.deps[k]))) pendingEffects.push({ i, effect, deps });
    },
  };
  const world = { token, userId: person.userId, accounts, workspace: { kind: 'ready', workspaceId }, pushes: [] };
  world.ports = realPorts(() => world.token, fn);
  const stubs = {
    react,
    'react/jsx-runtime': { jsx: (type, props) => ({ type: typeof type === 'function' ? type.name : type, props }), jsxs: (type, props) => ({ type: typeof type === 'function' ? type.name : type, props }), Fragment: 'Fragment' },
    'react-native': { Pressable: 'Pressable', ScrollView: 'ScrollView', Text: 'Text', TextInput: 'TextInput', View: 'View' },
    'expo-router': { useRouter: () => ({ push: (href) => world.pushes.push(href) }) },
    '@/constants/theme': { colors: { primary: 'p', primarySoft: 'ps', surface: 's', border: 'b', ink: 'i' } },
    '@/components/ui': { ActionButton: 'ActionButton', Card: 'Card', Pill: 'Pill', Screen: 'Screen', SectionTitle: 'SectionTitle', styles: { muted: {} } },
    '@/domain/service-enrollment': enrollment,
    '@/features/personal-workspace/personal-workspace-provider': { usePersonalWorkspace: () => ({ view: world.workspace, retry() {} }) },
    '@/features/reservations/reservation-ports': ports,
    '@/features/reservations/reservation-view': view,
    '@/features/reservations/use-reservation-ports': { useReservationPorts: () => world.ports, newClientRequestId: () => randomUUID(), contentSha256: async (text) => sha256(text) },
    '@/providers/active-account-provider': { useActiveAccount: () => ({ accounts: world.accounts }) },
    '@/providers/auth-provider': { useAuth: () => ({ session: world.token ? { access_token: world.token, user: { id: world.userId } } : null }) },
  };
  const loaded = { exports: {} };
  vm.runInNewContext(screenJs, { module: loaded, exports: loaded.exports, Promise, Date, require: (name) => { assert.ok(Object.hasOwn(stubs, name), `unexpected import ${name}`); return stubs[name]; } });
  const renderOnce = () => {
    cursor = 0;
    const tree = loaded.exports.default();
    while (pendingEffects.length) {
      const { i, effect, deps } = pendingEffects.shift();
      effects[i]?.cleanup?.();
      effects[i] = { deps: deps ?? [], cleanup: effect() };
    }
    return tree;
  };
  /** Renders until the real requests have answered and the screen is quiet. */
  const render = async () => {
    let quiet = 0;
    for (let i = 0; i < 800 && quiet < 4; i += 1) {
      renderOnce();
      await sleep(15);
      quiet = wire.inFlight === 0 ? quiet + 1 : 0;
    }
    assert.equal(wire.inFlight, 0, 'the screen never went quiet');
    return renderOnce();
  };
  return { world, render, renderOnce };
}
const press = async (h, label) => { const b = button(h.renderOnce(), label); assert.ok(b, `button ${label}`); assert.notEqual(b.disabled, true, `${label} is disabled`); b.onPress(); return h.render(); };
const openRow = async (h, iso) => { const p = rowPress(h.renderOnce(), `予約 ${view.formatJst(iso)}`); assert.ok(p, `row ${iso}`); p.onPress(); return h.render(); };
const typeTime = (h, iso) => field(h.renderOnce(), '新しい日時').onChangeText(view.formatJst(iso));
const success = /予約しました|保存しました|投稿しました/u;

// ---- the people -------------------------------------------------------------------------------------------------------------------------
let a; let b; let aAccounts; let bAccounts; let aWs; let bWs; let thAccount;
const xAcc = (p, id, ws) => ({ id, brandId: ws, platform: 'x', connectionStatus: 'connected', profile: { handle: `@${id}`, displayName: id } });
const saved = async (name, days, hours = 0) => {
  const body = `G3-02 #13 ${name}`;
  const made = await realPorts(() => a.token).x.save({ socialAccountId: a.account, clientBatchId: randomUUID(), revision: 1, mode: 'manual_exact', band: null,
    items: [{ draft_id: `g3g1_${name}`, scheduled_at: at(days, hours), body, consent: { confirmed: true, content_sha256: sha256(body) } }] });
  assert.equal(made.kind, 'saved', JSON.stringify(made));
  writes();
  return made.reservations[0];
};
const aScreen = (over = {}) => mount({ person: a, accounts: aAccounts, workspaceId: aWs, ...over });

test.before(async () => {
  a = await signUp('a');
  b = await signUp('b');
  aWs = await firstRun(a);
  bWs = await firstRun(b);
  a.account = await xConnect(a, 'a1', '62101');
  b.account = await xConnect(b, 'b1', '62102');
  thAccount = `th_g3g1_${a.userId.slice(0, 8)}`;
  // SYNTHETIC: a Threads connection in G4's binding_row shape (as local_test.ts L10); U8 keeps publish_enabled false
  const th = await psql(`insert into public.social_accounts (id, brand_id, platform, handle, platform_user_id, publish_enabled, connection_status, verified_at, vault_access_token_secret_id)
values (:'t', public.social_mobile_account_deletion_workspace(:'u'::uuid), 'threads', '@' || :'t', '17841400000062101', false, 'identity_verified', now(), gen_random_uuid());
insert into public.threads_account_credential_custody (social_account_id, vault_secret_id, expires_at, recorded_by)
select :'t', vault_access_token_secret_id, now() + interval '50 days', :'u'::uuid from public.social_accounts where id = :'t';
insert into postona_threads_binding.bindings (social_account_id, brand_id, threads_user_id, bound_by, oauth_state_id, connect_proof, lifecycle_version, bound_at)
select :'t', brand_id, '17841400000062101', :'u'::uuid, gen_random_uuid(), gen_random_uuid(), (select lifecycle_version from public.common_accounts where user_id = :'u'::uuid), now()
from public.social_accounts where id = :'t';`, { t: thAccount, u: a.userId });
  assert.doesNotMatch(th, /^ERR:/u, th);
  aAccounts = [xAcc(a, a.account, aWs), { id: thAccount, brandId: aWs, platform: 'threads', connectionStatus: 'connected', profile: { handle: `@${thAccount}`, displayName: thAccount } }];
  bAccounts = [xAcc(b, b.account, bWs)];
});

test('X, as pressed: the list from the server -> change the time -> 「再確認が必要」 -> reconfirm -> 「予約済み」 -> cancel asked twice', async () => {
  const row = await saved('f1', 30);
  const h = aScreen();
  let tree = await h.render();
  assert.ok(texts(tree).includes('予約済み'), `the saved row reads 予約済み: ${texts(tree).join(' / ')}`);
  tree = await openRow(h, row.scheduledAt);
  assert.ok(has(tree, 'G3-02 #13 f1'), 'the body the server stored');
  const moved = at(31);
  typeTime(h, moved);
  tree = await press(h, '時刻を変更');
  assert.deepEqual(writes(), 'reschedule');
  assert.equal(await rowState(row.reservationId), 'planned/2/needs_reconfirm');
  assert.ok(has(tree, '再確認が必要'));
  assert.ok(!texts(tree).includes('予約済み'), 'needs_reconfirm is never 予約済み');
  tree = await press(h, 'この本文で再確認する');
  assert.deepEqual(writes(), 'reconfirm');
  assert.equal(await rowState(row.reservationId), 'planned/2/confirmed', 'the server accepted the SHA-256 the screen computed');
  assert.ok(texts(tree).includes('予約済み'));
  tree = await press(h, '予約を取り消す');
  assert.deepEqual(writes(), '', 'the first press only asks');
  tree = await press(h, '本当に取り消す');
  assert.deepEqual(writes(), 'cancel');
  assert.match(await rowState(row.reservationId), /^cancelled\//u);
  assert.ok(!texts(tree).includes('予約済み'));
});

test('X 409: another device moved the row -> the stale cancel is refused, re-read once, never sent again; the row is what the server says', async () => {
  const row = await saved('f2', 32);
  const h = aScreen();
  await h.render();
  await openRow(h, row.scheduledAt);
  const moved = await realPorts(() => a.token).x.reschedule(row.reservationId, 1, at(33));
  assert.ok(moved.ok);
  writes();
  await press(h, '予約を取り消す');
  const tree = await press(h, '本当に取り消す');
  assert.deepEqual(writes(), 'cancel', 'one cancel, no second attempt');
  assert.equal(await rowState(row.reservationId), 'planned/2/needs_reconfirm', 'the row was not cancelled');
  assert.ok(has(tree, '再確認が必要'), `re-read: ${texts(tree).join(' / ')}`);
  assert.ok(!texts(tree).some((t) => success.test(t) || t.includes('取り消しました')));
});

test('X 422 / 409 slot: the form stays, the row is unchanged, nothing reads as done', async () => {
  const row = await saved('f3', 34);
  const other = await saved('f3b', 36);
  const h = aScreen();
  await h.render();
  await openRow(h, row.scheduledAt);
  typeTime(h, at(120));   // beyond 90 days: the screen's own check passes it, the server refuses
  let tree = await press(h, '時刻を変更');
  assert.deepEqual(writes(), 'reschedule');
  assert.equal(await rowState(row.reservationId), 'planned/1/confirmed');
  assert.ok(has(tree, view.actionView('fix_input', 'x').message), texts(tree).join(' / '));
  assert.notEqual(field(tree, '新しい日時').value, '', 'the form keeps what was typed');
  typeTime(h, new Date(Date.parse(other.scheduledAt) + 10 * 60e3).toISOString());
  tree = await press(h, '時刻を変更');
  assert.deepEqual(writes(), 'reschedule');
  assert.equal(await rowState(row.reservationId), 'planned/1/confirmed', 'POSTONA_RESV_SLOT_CONFLICT');
  assert.ok(has(tree, view.actionView('fix_input', 'x').message));
  assert.ok(texts(tree).includes('予約済み'), 'the row as it still is');
});

test('401: an expired token (signed with this stack\'s secret) and a signed-out session -> "sign in again", nothing sent; a new login reads again', async () => {
  const b64 = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: a.userId, session_id: a.sessionId, role: 'authenticated', aud: 'authenticated', is_anonymous: false, iat: 1700000000, exp: 1700000600 })}`;
  const expired = `${unsigned}.${createHmac('sha256', process.env.G3LS_JWT_SECRET).update(unsigned).digest('base64url')}`;
  const stale = await aScreen({ token: expired }).render();
  assert.ok(!texts(stale).includes('予約済み'), 'an expired token shows no row');
  assert.ok(has(stale, 'ログイン') || has(stale, 'サインイン'), texts(stale).join(' / '));
  const login = await (await authCall('token?grant_type=password', { email: a.email, password: a.password })).json();
  const out = await authCall('logout?scope=local', {}, login.access_token);
  await out.body?.cancel();
  const h = aScreen({ token: login.access_token });
  let tree = await h.render();
  assert.ok(!texts(tree).includes('予約済み'), 'a refused read shows no row');
  assert.ok(has(tree, 'ログイン') || has(tree, 'サインイン'), texts(tree).join(' / '));
  assert.deepEqual(writes(), '');
  h.world.token = a.token;
  tree = await h.render();
  assert.ok(texts(tree).includes('予約済み'), 'the new token reads');
});

test('another person: B\'s screen shows none of A\'s rows; a spoofed account object is refused by the server; a foreign workspace before any request', async () => {
  await saved('f5', 38);
  let tree = await mount({ person: b, accounts: bAccounts, workspaceId: bWs }).render();
  assert.ok(!has(tree, 'G3-02 #13'), 'B sees nothing of A');
  const spoof = mount({ person: b, accounts: [{ ...xAcc(b, a.account, bWs) }], workspaceId: bWs });
  tree = await spoof.render();
  assert.ok(!texts(tree).includes('予約済み') && !has(tree, 'G3-02 #13'), texts(tree).join(' / '));
  const calls = wire.writes.length;
  tree = await mount({ person: b, accounts: [xAcc(a, a.account, aWs)], workspaceId: bWs }).render();
  assert.ok(has(tree, '個人ワークスペース'), 'A\'s workspace account is refused before any request');
  assert.equal(wire.writes.length, calls);
});

test('service ended (SYNTHETIC) -> the write is refused with the way out; writes stay off; reads stay; a good read after the restart clears it', async () => {
  const row = await saved('f6', 40);
  const h = aScreen();
  await h.render();
  await openRow(h, row.scheduledAt);
  await psql("update public.service_entitlements set status = 'ended', ended_at = now() where user_id = :'u' and service_key = 'x_autopost'", { u: a.userId });
  try {
    typeTime(h, at(41));
    const tree = await press(h, '時刻を変更');
    assert.deepEqual(writes(), 'reschedule');
    assert.equal(await rowState(row.reservationId), 'planned/1/confirmed');
    assert.ok(has(tree, view.actionView('start_service', 'x').message), texts(tree).join(' / '));
    assert.equal(button(tree, '時刻を変更')?.disabled, true, 'writes off');
  } finally {
    await psql("update public.service_entitlements set status = 'active', ended_at = null where user_id = :'u' and service_key = 'x_autopost'", { u: a.userId });
  }
  await press(h, '最新の状態を読み込む');
  typeTime(h, at(41));
  await press(h, '時刻を変更');
  assert.deepEqual(writes(), 'reschedule');
  assert.equal(await rowState(row.reservationId), 'planned/2/needs_reconfirm', 'after the restart the same screen works');
});

test('G4 disconnect (real SQL) -> the write is refused with "reconnect X", then G4 reconnect + a read -> the write works', async () => {
  const row = await saved('f7', 42);
  const h = aScreen();
  await h.render();
  await openRow(h, row.scheduledAt);
  assert.equal(await xDisconnect(a), 'done');
  typeTime(h, at(43));
  const tree = await press(h, '時刻を変更');
  assert.deepEqual(writes(), 'reschedule');
  assert.equal(await rowState(row.reservationId), 'planned/1/confirmed');
  assert.ok(has(tree, view.actionView('reconnect_x', 'x').message), texts(tree).join(' / '));
  assert.equal(await xConnect(a, 'a2', '62101'), a.account);
  await press(h, '最新の状態を読み込む');
  typeTime(h, at(43));
  await press(h, '時刻を変更');
  assert.equal(await rowState(row.reservationId), 'planned/2/needs_reconfirm');
  writes();
});

test('503: the database unreachable -> unknown: "check", the same write never re-sent, nothing reads as done; the gate-OFF real entry -> not available', async () => {
  const row = await saved('f8', 44);
  const h = aScreen();
  await h.render();
  await openRow(h, row.scheduledAt);
  await psql('alter role g3ls_api_login nologin');
  try {
    typeTime(h, at(45));
    const tree = await press(h, '時刻を変更');
    assert.deepEqual(writes(), 'reschedule', 'one attempt');
    assert.ok(has(tree, view.actionView('check', 'x').message), texts(tree).join(' / '));
    assert.ok(!texts(tree).some((t) => success.test(t) || t.includes('時刻を変更しました')));
  } finally {
    await psql('alter role g3ls_api_login login');
  }
  assert.equal(await rowState(row.reservationId), 'planned/1/confirmed');
  const off = await mount({ person: a, accounts: aAccounts, workspaceId: aWs, fn: 'postona-x-reservations' }).render();
  assert.ok(has(off, view.actionView('not_available', 'x').message), texts(off).join(' / '));
  assert.ok(!texts(off).includes('予約済み'));
});

test('429 (INJECTED at the fetch boundary: this stack cannot produce one): nothing changed, nothing re-sent', async () => {
  const row = await saved('f9', 46);
  const h = aScreen();
  await h.render();
  await openRow(h, row.scheduledAt);
  typeTime(h, at(47));
  wire.inject = () => new Response(JSON.stringify({ code: 'RATE_LIMITED', message: 'INJECTED' }), { status: 429, headers: { 'content-type': 'application/json' } });
  let tree;
  try {
    tree = await press(h, '時刻を変更');
  } finally {
    wire.inject = null;
  }
  assert.deepEqual(writes(), 'reschedule');
  assert.ok(has(tree, view.actionView('retry_later', 'x').message), texts(tree).join(' / '));
  assert.equal(await rowState(row.reservationId), 'planned/1/confirmed');
});

test('an uncertain row (SYNTHETIC): "check X", no edit offered; a released send-now row (SYNTHETIC) is listed, and its reschedule is refused as final (measured)', async () => {
  const unsure = await saved('f10', 48);
  await psql("update postona_x_resv.reservations set status = 'uncertain', outcome_code = 'LEASE_EXPIRED' where id = :'i'", { i: unsure.reservationId });
  const sendNow = await saved('f11', 50);
  await psql("update postona_x_resv.reservations set draft_id = 'single:' || replace(id::text, '-', '') where id = :'i'", { i: sendNow.reservationId });
  const h = aScreen();
  await h.render();
  let tree = await openRow(h, unsure.scheduledAt);
  assert.ok(has(tree, 'Xで確認してください'));
  assert.equal(button(tree, '時刻を変更'), undefined, 'no edit on an uncertain row');
  assert.equal(button(tree, '予約を取り消す'), undefined, 'no cancel on an uncertain row');
  tree = await openRow(h, sendNow.scheduledAt);
  assert.ok(has(tree, 'G3-02 #13 f11'), 'list_reservations lists send-now rows (012)');
  typeTime(h, at(51));
  tree = await press(h, '時刻を変更');
  assert.deepEqual(writes(), 'reschedule');
  assert.match(await rowState(sendNow.reservationId), /^planned\/1\//u, 'G3-02 #7: never moved');
  assert.ok(has(tree, view.actionView('final', 'x').message), texts(tree).join(' / '));
});

test('Threads, as pressed: U8 -> "not available", no row, no 予約済み, the create sent once, writes off', async () => {
  const h = aScreen();
  await h.render();
  chip(h.renderOnce(), 'Threads').onPress();
  let tree = await h.render();
  field(tree, 'Threadsの本文').onChangeText('G3-02 #13 Threads');
  field(h.renderOnce(), 'Threadsの日時').onChangeText(view.formatJst(at(5)));
  tree = await press(h, 'Threadsに予約する');
  assert.deepEqual(writes(), 'create');
  assert.ok(has(tree, view.actionView('not_available', 'threads').message), texts(tree).join(' / '));
  assert.ok(!texts(tree).includes('予約済み'));
  assert.equal(await psql("select count(*) from postona_threads_resv.reservations where social_account_id = :'t'", { t: thAccount }), '0');
  assert.equal(button(tree, 'Threadsに予約する')?.disabled, true, 'writes off');
});
