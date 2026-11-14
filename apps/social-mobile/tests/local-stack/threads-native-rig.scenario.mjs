
// ---- G1 TASK 49 (Issue #316): the native rig. Appended to G4's threads-connect-product-flow.e2e.mjs by
// tests/local-stack/run-threads-native-rig.sh in a THROW-AWAY tree with G4 PR #664 merged locally (never pushed). It reuses G4's
// world and fakes -- the REAL connect Edge (G4 composition -> H5 runtime -> G4 owner bridge), the REAL publish Edge over HTTP, the
// REAL disconnect handler, the attested SQL on disposable PostgreSQL 17, the fake GoTrue keys and the fake Threads API -- and puts a
// loopback gateway in front of them so that a real app build on the iOS Simulator can sign in and tap through Threads:
//   http://127.0.0.1:${G1T49_RIG_PORT}/auth/v1/...       fake GoTrue: password / refresh grants for two rig people, user, logout
//   .../rest/v1/rpc/<name>                               the e2e's psql bridge as the person (role authenticated, the JWT's claims)
//   .../rest/v1/<table> (GET)                            the five tables the app reads, scoped to the person's memberships
//   .../functions/v1/<threads functions>                 G4's Edges, exactly as the e2e routes them
//   .../rig/fake-threads/authorize                       a LOCAL page standing in for Threads' consent screen (labelled so)
//   .../rig/control/{plan,expire,state}                  the operator's switches (lost answer, expired credential) and evidence
// Nothing here reaches a real provider: the Edges' only network is the e2e's (denied list), and the gateway binds 127.0.0.1 only.
// The rig people's password is generated at run time and written only to ${G1T49_RIG_DIR}/seed.json (never committed or reported).
test('37. G1 TASK 49: native rig for the iOS Simulator (held until the operator is done)', { timeout: 6 * 3600 * 1000 }, async (t) => {
  const dir = process.env.G1T49_RIG_DIR;
  if (!dir) { t.skip('G1T49_RIG_DIR not set (only run-threads-native-rig.sh holds the rig)'); return; }
  const fs = await import('node:fs');
  const http = await import('node:http');
  if (fs.existsSync(`${dir}/used`)) { t.skip('the rig was held once in this run'); return; }
  fs.writeFileSync(`${dir}/used`, '');
  const port = Number(process.env.G1T49_RIG_PORT ?? '56990');
  const gateway = `http://127.0.0.1:${port}`;
  const MAIN = 4721, OTHER = 4722;
  const PUIDS = { [MAIN]: '17841400000004721', [OTHER]: '17841400000004722' };
  person(MAIN, true);
  person(OTHER, true);
  // SYNTHETIC (labelled): each rig person's personal workspace, as G5's W0 creates it on sign-in (this world has no W0 RPC); the app's
  // snapshot needs a membership to show the accounts screen. G4's connect then binds the Threads account into it.
  for (const n of [MAIN, OTHER]) {
    owner(`begin; select set_config('request.jwt.claims', ${lit(JSON.stringify({ sub: uid(n), role: 'authenticated', session_id: sid(n), is_anonymous: false }))}, true) is null;`
      + ` select private.social_mobile_ensure_personal_workspace(${lit(uid(n))}::uuid); commit;`);
    // SYNTHETIC (labelled): the app's onboarding asks for a verified X account before any other screen; X is not under test here,
    // so a verified X row (no credential, no token) stands in for it. Threads is connected for real through G4's Edge below.
    owner(`insert into public.social_accounts (id, brand_id, platform, handle, connection_status, verified_at)
      values (${lit(`g1t49_x_${n}`)}, ${workspace(n)}, 'x', ${lit(`g1t49_x_${n}`)}, 'identity_verified', now())`);
  }
  const password = randomBytes(12).toString('base64url');
  const people = { 'g1t49-main@example.test': MAIN, 'g1t49-other@example.test': OTHER };
  const refresh = new Map();
  let loginSeq = 20;
  let codeSeq = 0;
  const log = (line) => fs.appendFileSync(`${dir}/requests.log`, `${new Date().toISOString()} ${line}\n`);
  const userJson = (n, email) => ({ id: uid(n), aud: 'authenticated', role: 'authenticated', email, email_confirmed_at: '2026-11-13T00:00:00Z',
    app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, identities: [], created_at: '2026-11-13T00:00:00Z', is_anonymous: false });
  const emailOf = (n) => Object.keys(people).find((e) => people[e] === n);
  const sessionJson = (n, k) => {
    const token = randomBytes(24).toString('base64url');
    refresh.set(token, { n, k });
    const access = jwt({ sub: uid(n), session_id: sid(n, k), is_anonymous: false, email: emailOf(n) });
    return { access_token: access, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: token, user: userJson(n, emailOf(n)) };
  };
  const send = (res, status, body, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
  const asPerson = (claims, sql) => psql(`begin; select set_config('request.jwt.claims', ${lit(JSON.stringify(claims))}, true) is null; set local role authenticated; ${sql}; commit;`);
  // The five tables the app reads (supabase-repository.ts, onboarding-repository.ts), scoped as their RLS scopes them: the person's
  // own memberships, and rows of the brands those memberships name. Read as the owner (this world has no PostgREST), projected to the
  // requested columns; a table this world does not have answers an empty list.
  const TABLES = {
    brand_memberships: (u) => `user_id = ${lit(u)}::uuid`,
    brands: (u) => `id in (select brand_id from public.brand_memberships where user_id = ${lit(u)}::uuid)`,
    social_accounts: (u) => `brand_id in (select brand_id from public.brand_memberships where user_id = ${lit(u)}::uuid)`,
    scheduled_posts: (u) => `brand_id in (select brand_id from public.brand_memberships where user_id = ${lit(u)}::uuid)`,
    social_mobile_content_settings: (u) => `brand_id in (select brand_id from public.brand_memberships where user_id = ${lit(u)}::uuid)`,
  };
  const readTable = (table, query, claims) => {
    if (owner(`select to_regclass(${lit(`public.${table}`)}) is not null`) !== 't') return [];
    const filters = [TABLES[table](claims.sub)];
    for (const [key, value] of query) {
      if (['select', 'limit', 'order', 'offset'].includes(key)) continue;
      if (!/^[a-z_]+$/u.test(key)) throw new Error('bad filter');
      if (value.startsWith('eq.')) filters.push(`${key}::text = ${lit(value.slice(3))}`);
      else if (value.startsWith('in.(') && value.endsWith(')')) filters.push(`${key}::text in (${value.slice(4, -1).split(',').map((v) => lit(v.replace(/^"|"$/gu, ''))).join(', ')})`);
      else throw new Error(`unsupported filter ${key}`);
    }
    const limit = Math.min(Number(query.get('limit') ?? 100) || 100, 200);
    const rows = JSON.parse(owner(`select coalesce(json_agg(to_jsonb(t)), '[]') from (select * from public.${table} where ${filters.join(' and ')} limit ${limit}) t`));
    const columns = (query.get('select') ?? '*').split(',').map((c) => c.trim());
    return columns.includes('*') ? rows : rows.map((row) => Object.fromEntries(columns.map((c) => [c, row[c] ?? null])));
  };
  const accountOf = (n) => threadsAccount(n)?.id ?? null;
  const evidence = (n) => {
    const acc = accountOf(n);
    const attempts = acc ? owner(`select coalesce(string_agg(status || '|' || coalesce(error_code, '-') || '|' || (provider_post_id is not null) || '|' || coalesce(permalink, '-'), ',' order by created_at), '') from public.threads_manual_publish_attempts where social_account_id = ${lit(acc)}`) : '';
    return { account: threadsAccount(n), attempts, publishes: writes(PUIDS[n], 'publish'), containers: writes(PUIDS[n], 'container'), sent: sent.length, denied: denied.length };
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, gateway);
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString();
    const auth = req.headers.authorization ?? '';
    const claims = claimsOf(auth);
    let status = 500;
    try {
      if (url.pathname === '/auth/v1/token') {
        const input = body ? JSON.parse(body) : {};
        const grant = url.searchParams.get('grant_type');
        if (grant === 'password' && Object.hasOwn(people, input.email) && input.password === password) {
          const n = people[input.email];
          const k = ++loginSeq;
          newSession(n, k);
          status = 200; send(res, 200, sessionJson(n, k));
        } else if (grant === 'refresh_token' && refresh.has(input.refresh_token)) {
          const { n, k } = refresh.get(input.refresh_token);
          refresh.delete(input.refresh_token);
          status = 200; send(res, 200, sessionJson(n, k));
        } else {
          status = 400; send(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials', code: 'invalid_credentials' });
        }
      } else if (url.pathname === '/auth/v1/user') {
        const r = gotrueUser(auth);
        status = r.status;
        if (r.status === 200) send(res, 200, userJson(Number(claims.sub.slice(-12)), claims.email ?? null));
        else send(res, r.status, await r.text());
      } else if (url.pathname === '/auth/v1/logout') {
        status = 204; res.writeHead(204); res.end();
      } else if (url.pathname.startsWith('/functions/v1/') || (url.pathname.startsWith('/rest/v1/rpc/') && POSTGREST_RPCS.has(url.pathname.slice(13)))) {
        // exactly as the e2e routes the app's requests (G4's Edges, the e2e's PostgREST bridge)
        const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => ['authorization', 'apikey', 'content-type', 'x-client-info'].includes(k)));
        const r = await globalThis.fetch(`${SUPABASE_URL}${url.pathname}`, { method: req.method, headers, body: body || undefined });
        status = r.status; send(res, r.status, await r.text(), r.headers.get('content-type') ?? 'application/json');
      } else if (url.pathname.startsWith('/rest/v1/rpc/')) {
        const name = url.pathname.slice(13);
        if (!/^[a-z_]+$/u.test(name) || !claims || expired(claims)) { status = 401; send(res, 401, { code: 'PGRST301', message: 'JWT required' }); }
        else if (owner(`select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = ${lit(name)}`) === '0') {
          status = 404; send(res, 404, { code: 'PGRST202', message: 'not in this world' });
        } else {
          const args = body ? JSON.parse(body) : {};
          const call = `public.${name}(${Object.entries(args).map(([k, v]) => `${k} => ${lit(typeof v === 'object' ? JSON.stringify(v) : v)}`).join(', ')})`;
          const r = asPerson(claims, `select coalesce(to_json(${call})::text, 'null')`);
          status = r.ok ? 200 : 400;
          send(res, status, r.ok ? r.out.split('\n').pop() : { code: 'P0001', message: r.message });
        }
      } else if (url.pathname.startsWith('/rest/v1/') && req.method === 'GET') {
        const table = url.pathname.slice(9);
        if (!Object.hasOwn(TABLES, table)) { status = 404; send(res, 404, { code: '42P01', message: 'not in this rig' }); }
        else if (!claims || expired(claims)) { status = 401; send(res, 401, { code: 'PGRST301', message: 'JWT expired' }); }
        else {
          const rows = readTable(table, url.searchParams, claims);
          const single = String(req.headers.accept ?? '').includes('vnd.pgrst.object');
          status = 200; send(res, 200, single ? (rows[0] ?? null) : rows);
        }
      } else if (url.pathname === '/rig/fake-threads/authorize') {
        // A LOCAL stand-in for Threads' consent screen. The code names the rig person's Threads user (G4's fake token exchange).
        const state = url.searchParams.get('state') ?? '';
        const back = (code) => `kabumori-social://threads-rig-callback?code=${code}&state=${encodeURIComponent(state)}`;
        const choices = Object.entries(PUIDS).map(([n, puid]) => `<p><a class="b" href="${back(`code${puid}x${++codeSeq}`)}">許可する（ローカル検証用 Threads ユーザー ${n === String(MAIN) ? 'メイン' : 'その他'} …${puid.slice(-4)}）</a></p>`).join('');
        status = 200;
        send(res, 200, `<!doctype html><html lang="ja"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>ローカル検証用の偽Threads</title>
<style>body{font-family:-apple-system;padding:20px}.w{background:#fff3cd;padding:12px;border-radius:8px}.b{display:block;padding:14px;background:#111;color:#fff;border-radius:10px;text-align:center;text-decoration:none;margin:8px 0}</style></head>
<body><p class="w"><b>これは本物のThreadsではありません。</b>G1 TASK 49 のローカル検証用の画面です。ここで許可しても、本物のThreadsには何も送られません。</p>
${choices}<p><a class="b" style="background:#888" href="kabumori-social://threads-rig-callback?error=access_denied&state=${encodeURIComponent(state)}">許可しない</a></p></body></html>`, 'text/html; charset=utf-8');
      } else if (url.pathname === '/rig/control/plan' && req.method === 'POST') {
        const input = JSON.parse(body);
        threadsApi.plan[PUIDS[input.person === 'other' ? OTHER : MAIN]] = input.plan ?? {};
        status = 200; send(res, 200, { plan: threadsApi.plan });
      } else if (url.pathname === '/rig/control/expire' && req.method === 'POST') {
        const acc = accountOf(MAIN);
        if (acc) expireCredential(acc);
        status = 200; send(res, 200, { expired: acc !== null });
      } else if (url.pathname === '/rig/control/state') {
        status = 200; send(res, 200, { main: evidence(MAIN), other: evidence(OTHER) });
      } else {
        status = 404; send(res, 404, { message: 'not in this rig' });
      }
    } catch (error) {
      status = 500;
      send(res, 500, { message: 'rig error' });
      log(`ERROR ${String(error?.message ?? error).slice(0, 200)}`);
    }
    // what crossed the gateway: method, path, status, and the action for the Threads functions (never a token, code or body)
    const action = url.pathname.startsWith('/functions/v1/') && body ? (() => { try { return JSON.parse(body).action ?? '-'; } catch { return '-'; } })() : '';
    log(`${req.method} ${url.pathname} ${status}${action ? ` action=${action}` : ''}${claims?.sub ? ` sub=…${claims.sub.slice(-4)}` : ''}`);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  fs.writeFileSync(`${dir}/seed.json`, JSON.stringify({ api: gateway, publishable: ANON_KEY, callback: CALLBACK, password, people: Object.keys(people) }), { mode: 0o600 });
  console.log(`G1T49_RIG_READY ${gateway}`);
  try {
    while (!fs.existsSync(`${dir}/done`)) await new Promise((resolve) => setTimeout(resolve, 1000));
  } finally {
    const final = { main: evidence(MAIN), other: evidence(OTHER), connectGraphWrites: graphWritesFromConnect.length };
    fs.writeFileSync(`${dir}/final.json`, JSON.stringify(final, null, 1));
    console.log(`measured 37 (G1 TASK 49 rig): ${JSON.stringify(final)}`);
    server.closeAllConnections?.();
    server.close();
  }
  assert.deepEqual(denied, [], 'no request left this process');
});
