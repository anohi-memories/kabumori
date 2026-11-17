# POSTONA Threads manual publish on the REAL local Supabase runtime — release readiness evidence (G4-02 #18, 2026-11-17)

task_id: `postona-g4-gen2-18-threads-launch-auth-manual-post-preflight-20261117` (Issue #561).
What this records: the first run of Threads **manual publish** through the real local Supabase runtime — app (supabase-js with a
real GoTrue session) → **Kong** (verify_jwt) → **Edge runtime** → the REAL publish handler (`handleThreadsPublish` +
`createGetUser` / `createStore`) → real **GoTrue** (caller) + real **PostgREST** (attested release / record RPCs) → real
**PostgreSQL 17.6** holding G4's whole personal stack **including manual publish 001 / 002** (generation pin, send fence,
read-before-rebind recovery); connect through the REAL connect entry twin (G4 composition → H5 runtime → G4 owner bridge).
Only Threads is fake (its state in the local db so both twins share it). Nothing deployed; no real provider; production NO_GO.

Why it is recorded here, not committed as a test: G4-02 #18 restricts the editable paths; the existing real-stack harness
(`supabase/tests/postona_g4_oauth_local_stack/`, `apps/social-mobile/tests/oauth-local-stack.e2e.mjs`) is outside them. The
harness was run from a scratch copy; its complete content is below so anyone can re-run it, and it can be moved into
`supabase/tests/postona_g4_oauth_local_stack/` by a TASK that allows that path. Gap it closes: the committed real-stack world
stops before `postona_g4_threads_manual_publish_verdict/001 / 002`, and serves no publish twin.

## Result (2026-11-17, supabase CLI 2.116.0, podman images postgres 17.6.1.165 / gotrue v2.196.0 / postgrest v16.1 / kong 2.8.1 / edge-runtime v1.74.3)

`G4LSP_PUBLISH_LOCAL_STACK_ALL_PASS`, exit 0, **8/8**; the stack and the scratch test file were removed at exit. Measured:

```
measured publish-local-stack: {"p0Closed":"503:THREADS_PUBLISH_DISABLED","p0NoApikey":401,"p0Tampered":401,"p1Connect":"verifying","p1Consent":"200:-","p1":"200:published|id","p1Writes":[1,1],"p2":"200:published,200:creating_container,200:published","p2Attempts":"1","p2Publishes":1,"p3":"200:uncertain","p3Resume":"200:uncertain","p3Reconcile":"200:published_unidentified","p3Row":"published_unidentified|PUBLISHED_POST_NOT_FOUND|-","p3Publishes":1,"p4BConnect":"verifying","p4":"404:ATTEMPT_NOT_FOUND,404:ATTEMPT_NOT_FOUND,404:ACCOUNT_NOT_FOUND,404:ACCOUNT_NOT_FOUND,401","p4BWrites":0,"p5Forged":"refused:ATTESTATION_INVALID","p5Table":403,"p5Recovery":404,"p6Reconcile":"409:CREDENTIALS_EXPIRED","p6Reconnect":"verifying","p6Row":"published_unidentified|PUBLISHED_POST_NOT_FOUND|-","p6Moved":true,"p6Delta":[0,0,1],"p6Next":"200:published","p7":"403:SERVICE_NOT_ACTIVE","p7Writes":0}
```

| Case | Result |
| --- | --- |
| P0 the real publish entry as in source | 503 `THREADS_PUBLISH_DISABLED` through Kong; no apikey / a tampered JWT → 401 at the gateway |
| P1 connect → consent → one post | `verifying`; permission 200; `published` with the provider's id; 1 container + 1 publish request |
| P2 the same tap twice at once + a replay | 1 attempt, **1** publish request |
| P3 lost answer | `uncertain`; resume never resends; reconcile → `published_unidentified` / PUBLISHED_POST_NOT_FOUND, no id |
| P4 A / B | B: status / reconcile on A's attempt → 404 ATTEMPT_NOT_FOUND; post / permission on A's account → 404 ACCOUNT_NOT_FOUND; no JWT → 401; B's provider writes 0 |
| P5 direct PostgREST | forged attestation → `refused:ATTESTATION_INVALID`; the generation table → 403; the recovery function → 404 (not exposed). (The test's title also names a replayed nonce; only the forged attestation was exercised here — nonce replay is covered by the PG17 e2e) |
| P6 unknown + expired credential | reconcile 409 `CREDENTIALS_EXPIRED`; the reconnect (real twin) read the container once (GET), settled `published_unidentified`, generation moved, 0 writes; next post `published` |
| P7 service ended | 403 `SERVICE_NOT_ACTIVE` before Threads; 0 provider writes |

Also run on the committed harness, unchanged (same date): `G4LS_OAUTH_LOCAL_STACK_ALL_PASS`, **32/32** (Threads / X connect,
real token refresh, sessions A→B→A, anonymous / signed-out, generation move / service end, replay, disconnect, X fence, X refresh
writer).

## The harness (scratch copy of `supabase/tests/postona_g4_oauth_local_stack/`; run as `bash run.sh` from the copy)

### run.sh — the differences from the committed `run.sh`

```diff
@@ -13,7 +13,7 @@
 set -euo pipefail
 export LC_ALL=C PGOPTIONS='-c client_min_messages=warning'
 here="$(cd "$(dirname "$0")" && pwd)"
-REPO="$(git -C "$here" rev-parse --show-toplevel)"
+REPO=/Users/yuya/Developer/kabumori-g4-integ   # SCRATCH (G4-02 #18): this harness lives outside the tree
 PR178=83334a091ded5571cf595fd99d7a035627564735   # G5 write guard chain, as G4's runners overlay it
 G5MVP=9846c0f062626db1dd4d9e8c10d5b1573e7f4982   # G5 MVP_INSTALL (blob eebaabf2)
 G5CHAIN=21a5cad4b71de63265db8517da93c6efc60cdde8 # G5 lifecycle chain (MVP P1)
@@ -30,9 +30,11 @@
 [ -d "$REPO/apps/social-mobile/node_modules/@supabase/supabase-js" ] || { echo "G4LS_APP_DEPS: run npm ci --ignore-scripts in apps/social-mobile"; exit 2; }
 if lsof -nP -iTCP:"$API_PORT" -iTCP:"$DB_PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo "G4LS_PORTS_BUSY: $API_PORT / $DB_PORT"; exit 2; fi
 
-WORK="$(mktemp -d /private/tmp/g4ls.XXXXXX)"
+WORK="$(mktemp -d /private/tmp/g4lsp.XXXXXX)"
+cp "$here/zz-g4ls-publish.e2e.mjs" "$REPO/apps/social-mobile/tests/zz-g4ls-publish.e2e.mjs"
 SERVE_PID=""
 cleanup() {
+  rm -f "$REPO/apps/social-mobile/tests/zz-g4ls-publish.e2e.mjs"
   [ -n "$SERVE_PID" ] && kill "$SERVE_PID" >/dev/null 2>&1 || true
   (cd "$WORK/p" && supabase stop --no-backup >/dev/null 2>&1) || true
   rm -rf "$WORK"
@@ -69,7 +71,7 @@
 s, n = re.subn(r"enable_anonymous_sign_ins = false", "enable_anonymous_sign_ins = true", s, count=1); assert n == 1
 s, n = re.subn(r'# jwt_issuer = ""', f'jwt_issuer = "{origin}/auth/v1"', s, count=1); assert n == 1
 s, n = re.subn(r"sign_in_sign_ups = \d+", "sign_in_sign_ups = 1000", s, count=1); assert n == 1
-for fn in ["threads-oauth-connect-user", "x-oauth-connect-user", "social-mobile-threads-disconnect", "g4ls-threads-connect", "g4ls-x-connect", "g4ls-threads-disconnect"]:
+for fn in ["threads-oauth-connect-user", "x-oauth-connect-user", "social-mobile-threads-disconnect", "g4ls-threads-connect", "g4ls-x-connect", "g4ls-threads-disconnect", "g4ls-threads-publish"]:
     s += f'\n[functions.{fn}]\nverify_jwt = true\n'
 open(p, "w").write(s)
 PY
@@ -79,7 +81,7 @@
 for d in threads-oauth-connect-user x-oauth-connect-user social-mobile-threads-disconnect social-mobile-threads-publish; do cp -R "$src/functions/$d" "$fns/"; done
 for d in postona_g4_threads_personal_auth postona_threads_auth_runtime; do cp -R "$src/candidates/$d" "$dst/candidates/"; done
 cp "$here/lib.ts" "$fns/_shared_g4ls/"
-for d in g4ls-threads-connect g4ls-x-connect g4ls-threads-disconnect; do
+for d in g4ls-threads-connect g4ls-x-connect g4ls-threads-disconnect g4ls-threads-publish; do
   mkdir -p "$fns/$d"; cp "$here/$d/index.ts" "$fns/$d/"; cp "$src/functions/threads-oauth-connect-user/deno.json" "$fns/$d/"
 done
 
@@ -128,7 +130,18 @@
          "$c/postona_g4_x_oauth_personal_mvp/005_x_connect_lifecycle_t13_g5pv.sql" "$c/postona_g4_x_oauth_personal_mvp/006_x_connect_profile_fence.sql" "$c/postona_g4_credential_verdict/002_x_publish_credential_verdict.sql" "$c/postona_g4_x_oauth_personal_mvp/007_x_refresh_precheck.sql"; do
   need "$f"
 done
-echo "OK world: G4's personal world on the real local schema (as postgres)"
+# SCRATCH (G4-02 #18): G4's manual publish verdict 001 + 002 (generation pin, send fence, read-before-rebind recovery) on the real schema
+need "$c/postona_g4_threads_manual_publish_verdict/001_manual_publish_requires_credential_verdict.sql"
+need "$c/postona_g4_threads_manual_publish_verdict/002_manual_publish_attempt_credential_generation.sql"
+own >/dev/null <<'SQL'
+create schema g4ls_fake;
+create table g4ls_fake.containers (id bigint generated always as identity (start with 18000000000000100) primary key, puid text not null, text text, status text not null);
+create table g4ls_fake.posts (id bigint generated always as identity (start with 18000000000900100) primary key, puid text not null, text text);
+create table g4ls_fake.writes (kind text not null, puid text not null, at timestamptz not null default clock_timestamp());
+create table g4ls_fake.plan (puid text primary key, mode text not null);
+revoke all on schema g4ls_fake from public, anon, authenticated, service_role;
+SQL
+echo "OK world: G4's personal world on the real local schema (as postgres) + G4 manual publish 001 / 002 + the fake's state"
 # G4-02 #8: the REAL X refresh core (main 20260925140000) instead of the deletion fixture's stand-in table, as G4-40's runner tests it
 own -c "drop trigger social_accounts_x_refresh_reset_on_reconnect on public.social_accounts; drop function public.x_account_refresh_reset_on_reconnect(); drop table public.x_account_refresh_state_v2 cascade" >/dev/null
 need "$m/20260925140000_x_account_credential_refresh_core.sql"
@@ -142,12 +155,18 @@
 delete from vault.secrets where name = 'postona_threads_connect_attestation_v1';
 select vault.create_secret(:'k', 'postona_threads_connect_attestation_v1');
 SQL
+PUBLISH_KEY="$(openssl rand -hex 32)"
+own -v k="$PUBLISH_KEY" >/dev/null <<'SQL'
+delete from vault.secrets where name = 'postona_threads_publish_attestation_v1';
+select vault.create_secret(:'k', 'postona_threads_publish_attestation_v1');
+SQL
 own -c "select postona_g4_x_oauth.set_x_disconnect_enabled(true)" >/dev/null
 
 ENV_FILE="$WORK/functions.env"
 (umask 077; {
   printf 'X_CLIENT_ID=g4ls-x-client\nX_CLIENT_SECRET=g4ls-x-secret\nPOSTONA_X_AUTH_PROFILE=personal\nG4LS_DB_PASSWORD=postgres\n'
   printf 'G4LS_ATTESTATION_KEY=%s\n' "$ATTESTATION"
+  printf 'G4LS_PUBLISH_KEY=%s\n' "$PUBLISH_KEY"
 } > "$ENV_FILE")
 (cd "$WORK/p" && exec supabase functions serve --env-file "$ENV_FILE" >"$WORK/serve.log" 2>&1) &
 SERVE_PID=$!
@@ -159,17 +178,17 @@
 done
 [ -n "$ready" ] || { tail -20 "$WORK/serve.log"; fail "functions serve not ready: $answer"; }
 # Each function's first request loads its dependencies (a cold start, not what is tested): warm them first, answers ignored.
-for fn in g4ls-threads-connect/default g4ls-x-connect/__x_calls g4ls-threads-disconnect social-mobile-threads-disconnect x-oauth-connect-user; do
+for fn in g4ls-threads-connect/default g4ls-x-connect/__x_calls g4ls-threads-disconnect social-mobile-threads-disconnect x-oauth-connect-user g4ls-threads-publish g4ls-threads-connect; do
   curl -s -o /dev/null --max-time 150 -X POST "http://127.0.0.1:$API_PORT/functions/v1/$fn" -H "apikey: $PUBLISHABLE" -H 'Content-Type: application/json' -d '{}' || true
 done
 echo "OK functions served and warmed"
 
 t0=$SECONDS
 if out="$(cd "$REPO/apps/social-mobile" && env FLOW_DEBUG="${FLOW_DEBUG:-}" LS_API="http://127.0.0.1:$API_PORT" LS_PUBLISHABLE="$PUBLISHABLE" LS_SERVICE_KEY="$SERVICE_KEY" LS_DB_PORT="$DB_PORT" \
-    node --experimental-transform-types --test --test-reporter=tap tests/oauth-local-stack.e2e.mjs 2>&1)"; then
+    node --experimental-transform-types --test --test-reporter=tap tests/zz-g4ls-publish.e2e.mjs 2>&1)"; then
   grep -E '^(ok|not ok|# (pass|fail|tests|measured))' <<<"$out"
   echo "node exited by itself with status 0 after $((SECONDS - t0)) s"
-  echo "G4LS_OAUTH_LOCAL_STACK_ALL_PASS"
+  echo "G4LSP_PUBLISH_LOCAL_STACK_ALL_PASS"
 else
   echo "$out"
   [ -n "${FLOW_DEBUG:-}" ] && tail -40 "$WORK/serve.log"
```

### lib.ts — the differences from the committed `lib.ts` (the db-backed Threads publish fake)

```diff
@@ -38,12 +38,59 @@
   return null;
 }
 
+// ---- SCRATCH (G4-02 #18, not committed): Threads' publish API, its state in the local db (schema g4ls_fake), shared by the twins -------
+async function rows<T>(text: string, args: unknown[] = []): Promise<T[]> {
+  const c = await ownerConnect() as unknown as Client;
+  try { return (await c.queryObject<T>(text, args)).rows; } finally { await c.end(); }
+}
+const graphError = (code: number, status = 400) => json({ error: { message: "fake refusal", type: "OAuthException", code } }, status);
+async function graph(url: URL, init?: RequestInit): Promise<Response | null> {
+  if (url.origin !== "https://graph.threads.net" || !url.pathname.startsWith("/v1.0/") || url.pathname === "/v1.0/me") return null;
+  const method = (init?.method ?? "GET").toUpperCase();
+  const params = method === "POST" ? new URLSearchParams(String(init?.body ?? "")) : url.searchParams;
+  const who = /^long([1-9][0-9]{0,31})abcdefghijklmnop$/.exec(params.get("access_token") ?? "")?.[1];
+  if (!who) return graphError(190);
+  const m = /^\/v1\.0\/([1-9][0-9]*)(?:\/(threads|threads_publish))?$/.exec(url.pathname);
+  if (!m) return graphError(100);
+  const [, id, edge] = m;
+  const plan = (await rows<{ mode: string }>("select mode from g4ls_fake.plan where puid = $1", [who]))[0]?.mode ?? "";
+  if (method === "POST" && edge === "threads") {
+    await rows("insert into g4ls_fake.writes (kind, puid) values ('container', $1)", [who]);
+    if (id !== who) return graphError(10);
+    const r = await rows<{ id: string }>("insert into g4ls_fake.containers (puid, text, status) values ($1, $2, 'FINISHED') returning id::text", [who, params.get("text") ?? ""]);
+    return json({ id: r[0].id });
+  }
+  if (method === "POST" && edge === "threads_publish") {
+    await rows("insert into g4ls_fake.writes (kind, puid) values ('publish', $1)", [who]);
+    const c = (await rows<{ puid: string; text: string; status: string }>("select puid, text, status from g4ls_fake.containers where id::text = $1", [params.get("creation_id") ?? ""]))[0];
+    if (id !== who || !c || c.puid !== who || c.status === "PUBLISHED") return graphError(100);
+    const post = await rows<{ id: string }>("insert into g4ls_fake.posts (puid, text) values ($1, $2) returning id::text", [who, c.text]);
+    await rows("update g4ls_fake.containers set status = 'PUBLISHED' where id::text = $1", [params.get("creation_id")]);
+    if (plan === "lost") return new Response("upstream timeout", { status: 503 });
+    return json({ id: post[0].id });
+  }
+  if (method === "GET" && !edge) {
+    if (plan === "read-fail") return new Response("upstream timeout", { status: 503 });
+    const c = (await rows<{ puid: string; status: string }>("select puid, status from g4ls_fake.containers where id::text = $1", [id]))[0];
+    if (c && c.puid === who) {
+      await rows("insert into g4ls_fake.writes (kind, puid) values ('read', $1)", [who]);
+      return json({ id, status: c.status, error_message: null });
+    }
+    const p = (await rows<{ puid: string }>("select puid from g4ls_fake.posts where id::text = $1", [id]))[0];
+    if (p && p.puid === who) {
+      return json({ id, permalink: `https://www.threads.net/@ls_${who.slice(-4)}/post/C${id}`, owner: { id: who }, username: `ls_${who.slice(-4)}`, timestamp: new Date().toISOString() });
+    }
+  }
+  return graphError(100);
+}
+
 /** H5's strict config needs a managed-shaped project URL: this port sends that origin to the local Kong, Threads to the fake. */
-export const localFetch: typeof fetch = (input, init) => {
+export const localFetch: typeof fetch = async (input, init) => {
   const url = urlOf(input as string | URL | Request);
   if (url.origin === new URL(fakeConfig.projectUrl).origin) return realFetch(KONG + url.pathname + url.search, init);
-  const answer = threads(url, init);
-  return answer ? Promise.resolve(answer) : refuse();
+  if (url.href.startsWith(`${KONG}/`)) return realFetch(input as RequestInfo, init);
+  const answer = threads(url, init) ?? await graph(url, init);
+  return answer ?? refuse();
 };
 
 /** X's two calls. The code names the X user (x<id>x<n>); xfail = X refuses the code. Everything else may only reach the local Kong. */
```

### g4ls-threads-publish/index.ts (new twin; `deno.json` = `threads-oauth-connect-user/deno.json`)

```ts
// SCRATCH, TEST ONLY (G4-02 #18, not committed). The REAL manual publish handler (social-mobile-threads-publish/logic.ts
// handleThreadsPublish with http.ts createGetUser / createStore: real GoTrue for the caller, real PostgREST for the attested release /
// record RPCs, real SQL) behind the real Kong on the real Edge runtime. Test-only differences: the static gate is passed over (this
// twin calls the inner handler, as createHandler would once THREADS_MANUAL_PUBLISH_PREREQUISITES_MET is lifted) and Threads is the
// db-backed fake (lib.ts). Anything else is refused.
import { handleThreadsPublish } from "../social-mobile-threads-publish/logic.ts";
import { createGetUser, createStore } from "../social-mobile-threads-publish/http.ts";
import { localFetch } from "../_shared_g4ls/lib.ts";

const supabaseUrl = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/u, "");
const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const attestationKey = Deno.env.get("G4LS_PUBLISH_KEY") ?? "";

Deno.serve((request) => handleThreadsPublish(request, {
  getUser: createGetUser({ supabaseUrl, anonKey }, localFetch),
  store: createStore({ supabaseUrl, anonKey, attestationKey }, localFetch),
  fetch: localFetch,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 50))),
  now: () => new Date(),
}));
```

### zz-g4ls-publish.e2e.mjs (copied into `apps/social-mobile/tests/` for module resolution, removed at exit)

```js
// SCRATCH, TEST ONLY (G4-02 #18, not committed): Threads manual publish on the REAL local Supabase runtime -- app (supabase-js with a
// real GoTrue session) -> Kong (verify_jwt) -> Edge runtime -> the REAL publish handler -> real GoTrue (caller) + real PostgREST
// (attested release / record RPCs) -> real PG 17.6 with G4's whole personal stack incl. manual publish 001 / 002; connect through the
// REAL connect entry twin (G4 composition -> H5 runtime -> G4 owner bridge, incl. the read-before-rebind recovery). Only Threads is
// fake (lib.ts: its state in the local db, shared by both twins). Run by the scratch runner; it must exit by itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID, createHmac, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import ts from 'typescript';
import { createClient } from '@supabase/supabase-js';
import * as threadsDomain from '../src/domain/threads-connect.ts';
import * as disconnectDomain from '../src/domain/threads-disconnect.ts';
import * as recoveryBinding from '../src/domain/recovery-binding.ts';

const env = (k) => { const v = process.env[k]; if (!v) throw new Error(`${k} missing`); return v; };
const API = env('LS_API');
const PUBLISHABLE = env('LS_PUBLISHABLE');
const CALLBACK = 'https://postona.example/callback';
const T = { timeout: 90000 };
const lit = (v) => (v === null || v === undefined ? 'null' : `'${String(v).replaceAll("'", "''")}'`);
const owner = (sql) => execFileSync('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', env('LS_DB_PORT'), '-U', 'postgres', '-d', 'postgres', '-c', sql],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const routes = { current: '' };
const routed = (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  return fetch(url.replace('/functions/v1/threads-oauth-connect-user', `/functions/v1/g4ls-threads-connect${routes.current}`)
    .replace('/functions/v1/social-mobile-threads-disconnect', '/functions/v1/g4ls-threads-disconnect'), init);
};
const memory = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); }, removeItem: (k) => { m.delete(k); } }; };
const newClient = () => createClient(API, PUBLISHABLE, { auth: { persistSession: true, autoRefreshToken: false, detectSessionInUrl: false, storage: memory() }, global: { fetch: routed } });
const password = `g4lsp-${randomUUID()}`;
const claimsOf = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
async function person(label) {
  const client = newClient();
  const { data, error } = await client.auth.signUp({ email: `${label}-${randomUUID().slice(0, 8)}@g4lsp.test`, password });
  assert.equal(error, null, `sign-up ${label}`);
  const userId = data.user.id;
  const claims = claimsOf(data.session.access_token);
  const json = JSON.stringify({ sub: userId, role: 'authenticated', session_id: claims.session_id, is_anonymous: false });
  owner(`begin; select set_config('request.jwt.claims', ${lit(json)}, true); select public.start_x_autopost_service();
    update public.brands set code_profile_key = 'social_mobile_user_v1' where id = public.social_mobile_account_deletion_workspace(${lit(userId)}::uuid); commit;`);
  return { label, client, userId, session: data.session, sessionId: claims.session_id };
}
const workspace = (p) => `public.social_mobile_account_deletion_workspace(${lit(p.userId)}::uuid)`;
const accountOf = (p) => owner(`select coalesce((select id from public.social_accounts where brand_id = ${workspace(p)} and platform = 'threads'), '')`);
const generationOf = (p) => owner(`select coalesce((select 'g4t1:' || b.oauth_state_id::text from postona_threads_binding.bindings b join public.social_accounts sa on sa.id = b.social_account_id where sa.brand_id = ${workspace(p)}), 'none')`);
const writes = (puid, kind) => Number(owner(`select count(*) from g4ls_fake.writes where puid = ${lit(puid)} and kind = ${lit(kind)}`));
const attempt = (id) => owner(`select status || '|' || coalesce(error_code, '-') || '|' || coalesce(provider_post_id, '-') from public.threads_manual_publish_attempts where id = ${lit(id)}::uuid`);
const plan = (puid, mode) => owner(mode ? `insert into g4ls_fake.plan values (${lit(puid)}, ${lit(mode)}) on conflict (puid) do update set mode = excluded.mode` : `delete from g4ls_fake.plan where puid = ${lit(puid)}`);

// the REAL connect hooks (TypeScript transpiled; module edges stubbed), as oauth-local-stack.e2e.mjs
const transpiled = new Map();
async function loadTs(rel, modules) {
  if (!transpiled.has(rel)) {
    const source = await readFile(new URL(`../src/${rel}`, import.meta.url), 'utf8');
    transpiled.set(rel, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText);
  }
  const mod = { exports: {} };
  vm.runInNewContext(transpiled.get(rel), { module: mod, exports: mod.exports, URL, Response, setTimeout, clearTimeout, Promise,
    require: (n) => { assert.ok(Object.hasOwn(modules, n), `unexpected import ${n} in ${rel}`); return modules[n]; } }, { filename: rel });
  return mod.exports;
}
const hookRuntime = (slots, cursor) => ({
  useState(initial) { const i = cursor.n++; if (!(i in slots)) slots[i] = initial; return [slots[i], (v) => { slots[i] = v; }]; },
  useRef(initial) { const i = cursor.n++; return slots[i] ??= { current: initial }; },
  useCallback: (cb) => cb,
  useLayoutEffect: (effect) => effect(),
});
async function connect(p, puid) {
  const auth = { session: p.session };
  const slots = [], cursor = { n: 0 };
  const react = hookRuntime(slots, cursor);
  let served = 0;
  const host = new URL(CALLBACK).hostname;
  const expoConfig = { extra: { threadsConnectCallbackUrl: CALLBACK }, ios: { associatedDomains: [`applinks:${host}`] } };
  const base = { '@/lib/supabase': { supabase: p.client }, '@/providers/auth-provider': { useAuth: () => ({ session: auth.session }) } };
  const starter = await loadTs('features/threads-connect/threads-connect-starter.ts', { '@/domain/threads-connect': threadsDomain, '@/domain/recovery-binding': recoveryBinding });
  const runtime = await loadTs('features/threads-connect/threads-connect-runtime.ts', {
    'expo-constants': { __esModule: true, default: { expoConfig } },
    'expo-linking': { addEventListener: () => ({ remove() {} }) },
    'expo-web-browser': {
      openAuthSessionAsync: async (authorizationUrl, redirect) => {
        served += 1;
        const state = new URL(authorizationUrl).searchParams.get('state');
        return { type: 'success', url: `${redirect}?code=code${puid}x${served}${Date.now() % 100000}&state=${encodeURIComponent(state)}#_` };
      },
      dismissAuthSession() {},
    },
    'react-native': { Platform: { OS: 'ios', Version: '18.0' } },
    '@/domain/threads-connect': threadsDomain,
    '@/features/threads-connect/threads-connect-starter': starter,
    ...base,
  });
  const hook = await loadTs('features/threads-connect/use-threads-connect.ts', {
    react, '@/features/threads-connect/threads-connect-runtime': runtime, '@/features/threads-connect/threads-connect-starter': starter, ...base,
  });
  const render = () => { cursor.n = 0; return hook.useThreadsConnect({ accounts: [], reload: () => {}, releaseEnabled: true }); };
  await render().connect();
  const st = render().state;
  return st.kind === 'done' ? `${st.result.kind}:${st.result.code ?? '-'}` : st.kind;
}
const call = async (fn, body, token, extra = {}) => {
  const r = await fetch(`${API}/functions/v1/${fn}`, {
    method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
    headers: { 'content-type': 'application/json', ...(extra.noApikey ? {} : { apikey: PUBLISHABLE }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: r.status, json, text };
};
const publish = (p, body) => call('g4ls-threads-publish', body, p.session.access_token);
const summary = (r) => `${r.status}:${r.json?.error ?? r.json?.attempt?.status ?? '-'}`;

const A_PUID = '17841400000018001';
const B_PUID = '17841400000018002';
let A, B, accountA, accountB;
const results = {};
test.after(() => console.log(`measured publish-local-stack: ${JSON.stringify(results)}`));

test('P0. the real publish entry as in source is closed (503) through Kong; the gateway refuses no apikey and a tampered JWT (401)', T, async () => {
  A = await person('a');
  results.p0Closed = summary(await call('social-mobile-threads-publish', { action: 'status', attempt_id: randomUUID() }, A.session.access_token));
  results.p0NoApikey = (await call('g4ls-threads-publish', { action: 'status', attempt_id: randomUUID() }, null, { noApikey: true })).status;
  const [h, c, s] = A.session.access_token.split('.');
  const tampered = `${h}.${Buffer.from(JSON.stringify({ ...claimsOf(A.session.access_token), sub: randomUUID() })).toString('base64url')}.${s}`;
  results.p0Tampered = (await call('g4ls-threads-publish', { action: 'status', attempt_id: randomUUID() }, tampered)).status;
  void c;
  assert.equal(results.p0Closed, '503:THREADS_PUBLISH_DISABLED');
  assert.deepEqual([results.p0NoApikey, results.p0Tampered], [401, 401]);
});

test('P1. connect (real entry twin) -> consent -> ONE post through Kong / real PostgREST / real SQL: published, read back', T, async () => {
  results.p1Connect = await connect(A, A_PUID);
  accountA = accountOf(A);
  results.p1Consent = summary(await publish(A, { action: 'set_permission', social_account_id: accountA, desired_enabled: true, expected_current_enabled: false }));
  const r = await publish(A, { action: 'publish', social_account_id: accountA, idempotency_key: randomUUID(), text: '実スタックの最初の投稿' });
  results.p1 = `${summary(r)}|${r.json?.attempt?.provider_post_id ? 'id' : '-'}`;
  results.p1Writes = [writes(A_PUID, 'container'), writes(A_PUID, 'publish')];
  assert.deepEqual([results.p1Connect, results.p1Consent.split(':')[0], results.p1, results.p1Writes], ['verifying', '200', '200:published|id', [1, 1]]);
});

test('P2. the same tap twice at once and a replay: one attempt, ONE publish request', T, async () => {
  const key = randomUUID();
  const body = { action: 'publish', social_account_id: accountA, idempotency_key: key, text: '二回タップの投稿' };
  const p0 = writes(A_PUID, 'publish');
  const both = await Promise.all([publish(A, body), publish(A, body)]);
  const replay = await publish(A, body);
  results.p2 = [...both.map(summary), summary(replay)].join(',');
  results.p2Attempts = owner(`select count(*) from public.threads_manual_publish_attempts where social_account_id = ${lit(accountA)} and idempotency_key = ${lit(key)}::uuid`);
  results.p2Publishes = writes(A_PUID, 'publish') - p0;
  assert.equal(results.p2Attempts, '1');
  assert.equal(results.p2Publishes, 1, results.p2);
});

test('P3. the publish answer is lost: uncertain; resume never resends; reconcile settles read-only (published_unidentified)', T, async () => {
  plan(A_PUID, 'lost');
  const p0 = writes(A_PUID, 'publish');
  const r = await publish(A, { action: 'publish', social_account_id: accountA, idempotency_key: randomUUID(), text: '応答が失われる実スタック投稿' });
  plan(A_PUID, null);
  const id = r.json?.attempt?.id;
  results.p3 = summary(r);
  results.p3Resume = summary(await publish(A, { action: 'resume', attempt_id: id }));
  results.p3Reconcile = summary(await publish(A, { action: 'reconcile', attempt_id: id }));
  results.p3Row = attempt(id);
  results.p3Publishes = writes(A_PUID, 'publish') - p0;
  assert.deepEqual([results.p3, results.p3Resume, results.p3Reconcile, results.p3Row, results.p3Publishes],
    ['200:uncertain', '200:uncertain', '200:published_unidentified', 'published_unidentified|PUBLISHED_POST_NOT_FOUND|-', 1]);
});

test('P4. A / B: B cannot read, reconcile or post on A\'s account; no JWT -> 401', T, async () => {
  B = await person('b');
  results.p4BConnect = await connect(B, B_PUID);
  accountB = accountOf(B);
  const aAttempt = owner(`select id from public.threads_manual_publish_attempts where social_account_id = ${lit(accountA)} order by created_at desc limit 1`);
  results.p4 = [
    summary(await publish(B, { action: 'status', attempt_id: aAttempt })),
    summary(await publish(B, { action: 'reconcile', attempt_id: aAttempt })),
    summary(await publish(B, { action: 'publish', social_account_id: accountA, idempotency_key: randomUUID(), text: '他人のアカウント' })),
    summary(await publish(B, { action: 'set_permission', social_account_id: accountA, desired_enabled: true, expected_current_enabled: true })),
    (await call('g4ls-threads-publish', { action: 'status', attempt_id: aAttempt }, null)).status,
  ].join(',');
  results.p4BWrites = writes(B_PUID, 'publish') + writes(B_PUID, 'container');
  assert.equal(results.p4BConnect, 'verifying');
  const [s1, s2, s3, s4, s5] = results.p4.split(',');
  for (const s of [s1, s2, s3, s4]) assert.match(s, /^(404|403):/u, results.p4);
  assert.equal(s5, '401');
  assert.equal(results.p4BWrites, 0);
});

test('P5. direct RPC through real PostgREST: a forged attestation and a replayed nonce are refused; the generation table is unreachable', T, async () => {
  const id = owner(`select id from public.threads_manual_publish_attempts where social_account_id = ${lit(accountA)} order by created_at desc limit 1`);
  const rpc = (name, args) => fetch(`${API}/rest/v1/rpc/${name}`, { method: 'POST', headers: { apikey: PUBLISHABLE, authorization: `Bearer ${A.session.access_token}`, 'content-type': 'application/json' }, body: JSON.stringify(args) });
  const forged = await (await rpc('release_threads_manual_publish_step', { p_attempt_id: id, p_step: 'publish', p_issued_at: Math.floor(Date.now() / 1000), p_nonce: randomBytes(32).toString('hex'), p_attestation: randomBytes(32).toString('hex') })).json();
  results.p5Forged = `${forged.status}:${forged.code}`;
  const table = await fetch(`${API}/rest/v1/threads_manual_publish_attempt_generations?select=*`, { headers: { apikey: PUBLISHABLE, authorization: `Bearer ${A.session.access_token}` } });
  results.p5Table = table.status;
  const recovery = await rpc('settle_attempt_before_rebind', {});
  results.p5Recovery = recovery.status;
  assert.equal(results.p5Forged, 'refused:ATTESTATION_INVALID');
  assert.ok([401, 403, 404].includes(results.p5Table), `generation table ${results.p5Table}`);
  assert.ok([401, 403, 404].includes(results.p5Recovery), `recovery RPC not exposed ${results.p5Recovery}`);
});

test('P6. unknown outcome + expired credential: reconcile 409; the reconnect (real twin) reads the container first and settles; nothing sent', T, async () => {
  plan(A_PUID, 'lost');
  const r = await publish(A, { action: 'publish', social_account_id: accountA, idempotency_key: randomUUID(), text: '失効する実スタック投稿' });
  plan(A_PUID, null);
  const id = r.json?.attempt?.id;
  owner(`update public.threads_account_credential_custody set expires_at = now() - interval '1 hour' where social_account_id = ${lit(accountA)}`);
  const gen0 = generationOf(A);
  const w0 = [writes(A_PUID, 'publish'), writes(A_PUID, 'container'), writes(A_PUID, 'read')];
  results.p6Reconcile = summary(await publish(A, { action: 'reconcile', attempt_id: id }));
  results.p6Reconnect = await connect(A, A_PUID);
  results.p6Row = attempt(id);
  results.p6Moved = generationOf(A) !== gen0;
  results.p6Delta = [writes(A_PUID, 'publish') - w0[0], writes(A_PUID, 'container') - w0[1], writes(A_PUID, 'read') - w0[2]];
  const next = await publish(A, { action: 'publish', social_account_id: accountA, idempotency_key: randomUUID(), text: '復旧後の実スタック投稿' });
  results.p6Next = summary(next);
  assert.deepEqual([results.p6Reconcile, results.p6Reconnect, results.p6Row, results.p6Moved], ['409:CREDENTIALS_EXPIRED', 'verifying', 'published_unidentified|PUBLISHED_POST_NOT_FOUND|-', true]);
  assert.deepEqual(results.p6Delta, [0, 0, 1], 'one GET of the container, no write');
  assert.equal(results.p6Next, '200:published');
});

test('P7. the service ends: a new post is refused before Threads; nothing sent', T, async () => {
  owner(`update public.service_entitlements set status = 'ended', ended_at = now() where user_id = ${lit(A.userId)}::uuid and service_key = 'x_autopost'`);
  const w0 = writes(A_PUID, 'container') + writes(A_PUID, 'publish');
  results.p7 = summary(await publish(A, { action: 'publish', social_account_id: accountA, idempotency_key: randomUUID(), text: 'サービス終了後' }));
  results.p7Writes = writes(A_PUID, 'container') + writes(A_PUID, 'publish') - w0;
  assert.match(results.p7, /^(403|409):/u);
  assert.equal(results.p7Writes, 0);
});
```
