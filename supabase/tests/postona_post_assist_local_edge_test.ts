// G6-26 (2026-10-30): POSTONA's AI post assist on the REAL local Supabase runtime. Run by postona_post_assist_local_edge_run.sh only.
// Real here: Kong (verify_jwt), GoTrue (ES256 user JWTs with session_id / is_anonymous), PostgREST, the Edge runtime, Postgres 17.6.1.165
// with the real auth schema, G5's R1-MVP (PR #569 source, run by its lifecycle owner), G6's ledger / ai_calls / owner-held SQL, supabase-js
// 2.115.0 (the app's locked version) and G1's own client file (PR #576). Fake: the provider (a server on this host) and the person's
// personal workspace row (created as G5's fixtures do: no product path creates it yet). Nothing is deployed; production NO_GO.
import assert from "node:assert/strict";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.115.0";
import { openAiBody } from "../functions/_shared/ai_provider/test_support.ts";
import * as reference from "./postona_post_assist_client_reference.ts";

const API = Deno.env.get("G6LE_API") ?? "";
const PUBLISHABLE = Deno.env.get("G6LE_PUBLISHABLE") ?? "";
const DB_PORT = Deno.env.get("G6LE_DB_PORT") ?? "";
const FAKE_PORT = Number(Deno.env.get("G6LE_FAKE_PORT") ?? "0");
const MVP = Deno.env.get("G6LE_MVP") ?? "";
const enabled = API !== "" && PUBLISHABLE !== "" && MVP !== "";
const opts = { ignore: !enabled, sanitizeOps: false, sanitizeResources: false };
const g1: typeof reference = enabled ? await import(`file://${Deno.env.get("G6LE_G1_CLIENT")}`) : reference;

const LOCALTEST = "postona-post-assist-localtest";
const REAL_ENTRY = "postona-post-assist";
const WEB = "http://localhost:8081";

// ---- psql -----------------------------------------------------------------------------------------------------------------------------
async function psql(user: string, args: string[]): Promise<{ ok: boolean; out: string; error: string }> {
  const r = await new Deno.Command("psql", {
    args: ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-p", DB_PORT, "-U", user, "-d", "postgres", ...args],
    stdout: "piped", stderr: "piped",
  }).output();
  return { ok: r.success, out: new TextDecoder().decode(r.stdout).trim(), error: new TextDecoder().decode(r.stderr).trim() };
}
const sql = async (user: string, text: string) => {
  const r = await psql(user, ["-c", text]);
  assert.ok(r.ok, r.error);
  return r.out;
};
const admin = (text: string) => sql("supabase_admin", text);
const ledgerState = () =>
  admin(`select (select coalesce(string_agg(status || '=' || n, ',' order by status), '-') from (select status, count(*) n from ai_ledger.reservations group by status) r)
    || ' calls:' || (select coalesce(string_agg(state || '=' || n, ',' order by state), '-') from (select state, count(*) n from ai_calls.consumer_calls group by state) c)
    || ' usage:' || (select count(*) from ai_ledger.usage_events)`);
const r1acl = () => admin("select coalesce(proacl::text, '-') from pg_proc where oid = 'public.common_account_authorization_verdict(text,text,text)'::regprocedure");

// ---- the fake provider (the only fake on the request path) -------------------------------------------------------------------------
const provider = { calls: [] as string[], replies: [] as unknown[], hold: null as Promise<void> | null };
const server = enabled
  ? Deno.serve({ hostname: "127.0.0.1", port: FAKE_PORT, onListen: () => {} }, async (req) => {
    const body = await req.text();
    provider.calls.push(`${req.headers.get("Authorization")?.startsWith("Bearer test-openai-key-NOT-REAL") ? "fake-key" : "OTHER-KEY"} ${body}`);
    if (provider.hold) await provider.hold;
    const reply = provider.replies.shift() ?? { candidates: [{ text: "週末限定のいちごタルトです。", hashtags: ["#いちごタルト"] }] };
    return new Response(JSON.stringify(openAiBody(reply, { model: "gpt-6-luna" })), { status: 200, headers: { "Content-Type": "application/json" } });
  })
  : null;

// ---- people (real GoTrue sign-ups on the local stack; passwords live only in this process) -----------------------------------------
type Person = { id: string; email: string; password: string; token: string; client: SupabaseClient; workspace: string };
const anonClient = () => createClient(API, PUBLISHABLE, { auth: { persistSession: false, autoRefreshToken: false } });
const people: Record<string, Person> = {};
let anonymousToken = "";

async function signUp(label: string): Promise<Person> {
  const client = anonClient();
  const email = `g6le-${label}-${crypto.randomUUID().slice(0, 8)}@example.test`;
  const password = crypto.randomUUID();
  const r = await client.auth.signUp({ email, password });
  assert.ok(r.data.session && r.data.user, r.error?.message);
  return { id: r.data.user.id, email, password, token: r.data.session.access_token, client, workspace: "" };
}
async function signInAgain(p: Person) {
  const r = await p.client.auth.signInWithPassword({ email: p.email, password: p.password });
  assert.ok(r.data.session, r.error?.message);
  p.token = r.data.session.access_token;
}
const claimsOf = (token: string) => JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(token.split(".")[1].length / 4) * 4, "=")));

// what the app does to learn its workspace (supabase-repository.ts at PR #576: brand_memberships -> brands, with the person's session)
async function appWorkspace(p: Person): Promise<string | null> {
  const m = await p.client.from("brand_memberships").select("brand_id").eq("user_id", p.id);
  assert.equal(m.error, null);
  const ids = (m.data ?? []).map((r) => r.brand_id as string);
  if (ids.length === 0) return null;
  const b = await p.client.from("brands").select("id,display_name,is_active,publish_mode").in("id", ids).limit(50);
  assert.equal(b.error, null);
  return (b.data ?? []).find((r) => ids.includes(r.id))?.id ?? null;
}

// ---- calls ----------------------------------------------------------------------------------------------------------------------------
type Input = Parameters<typeof reference.requestPostAssist>[3];
const functionsClient = (fn: string) => {
  const c = anonClient();
  return { functions: { invoke: (_name: string, o: { body: Record<string, unknown>; headers: Record<string, string> }) => c.functions.invoke(fn, o) } };
};
const viaG1 = (token: string, key: string, input: Input, fn = LOCALTEST) => g1.requestPostAssist(functionsClient(fn), token, key, input);
const viaReference = (token: string, key: string, input: Input, fn = LOCALTEST) => reference.requestPostAssist(functionsClient(fn), token, key, input);
async function raw(fn: string, init: { method?: string; token?: string | null; apikey?: false; key?: string; body?: string; origin?: string; contentType?: string | null }) {
  const headers: Record<string, string> = init.apikey === false ? {} : { apikey: PUBLISHABLE };
  if (init.token !== null) headers.Authorization = `Bearer ${init.token}`;
  if (init.contentType !== null) headers["Content-Type"] = init.contentType ?? "application/json";
  if (init.key) headers["Idempotency-Key"] = init.key;
  if (init.origin) headers.Origin = init.origin;
  const res = await fetch(`${API}/functions/v1/${fn}`, { method: init.method ?? "POST", headers, body: init.body });
  const text = await res.text();
  let body: Record<string, unknown> | null = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, headers: res.headers, body };
}
const xDraft = (brandId: string): Input => ({ brandId, mode: "draft", platform: "x", notes: "いちごタルト 週末限定" });
const key = (label: string) => `g6le-${label}-${crypto.randomUUID().slice(0, 8)}`;
const kinds = (s: { kind: string }) => s.kind;

// ---- tests ----------------------------------------------------------------------------------------------------------------------------
Deno.test({ name: "setup: real GoTrue people; A and B started POSTONA in their own workspace, C has a workspace but no POSTONA; the app's own read path finds exactly G5's personal workspace id; R1-MVP as shipped is owner-only", ...opts }, async () => {
  for (const label of ["A", "B", "C"]) people[label] = await signUp(label);
  const c = claimsOf(people.A.token);
  assert.deepEqual([c.role, c.is_anonymous, typeof c.session_id, c.sub], ["authenticated", false, "string", people.A.id], "a real GoTrue access token");
  for (const label of ["A", "B", "C"]) {
    const p = people[label];
    assert.equal((await p.client.rpc("ensure_my_profile")).error, null, label);
    // no product path creates the personal workspace yet: G5's fixture shape (brand u_<md5(user)[0:24]> + owner membership)
    await admin(`insert into public.brands (id) values ('u_' || substr(md5('${p.id}'), 1, 24)); insert into public.brand_memberships (brand_id, user_id, role) values ('u_' || substr(md5('${p.id}'), 1, 24), '${p.id}', 'owner')`);
    p.workspace = (await appWorkspace(p)) ?? "";
    assert.equal(p.workspace, `u_${(await admin(`select substr(md5('${p.id}'), 1, 24)`))}`, `${label}: the app's workspace id is the personal workspace id`);
  }
  for (const label of ["A", "B"]) {
    const r = await people[label].client.rpc("start_x_autopost_service");
    assert.equal(r.error, null, label);
    assert.equal((r.data as Record<string, unknown>).status, "active", label);
  }
  const anon = await anonClient().auth.signInAnonymously();
  assert.ok(anon.data.session, anon.error?.message);
  anonymousToken = anon.data.session.access_token;
  assert.equal(claimsOf(anonymousToken).is_anonymous, true);
  assert.match(await r1acl(), /^\{g6le_owner=X\/g6le_owner\}$/u);
  assert.equal(await ledgerState(), "- calls:- usage:0");
});

Deno.test({ name: "as shipped (no grant): the person's real request through Kong and the Edge runtime is 'not available'; nothing reserved, nothing sent", ...opts }, async () => {
  const before = provider.calls.length;
  assert.deepEqual(kinds(await viaG1(people.A.token, key("shipped"), xDraft(people.A.workspace))), "not_available");
  assert.equal(provider.calls.length, before);
  assert.equal(await ledgerState(), "- calls:- usage:0");
});

Deno.test({ name: "granted (G5's MVP_R1_EXECUTE_GRANT.sql as its owner): X and Threads draft -> refine -> hashtags with G1's own client over real HTTP: editable candidates to confirm, one provider send and one settled charge each; the provider sees no token, user id or e-mail", ...opts }, async () => {
  const g = await psql("g6le_owner", ["-f", `${MVP}/MVP_R1_EXECUTE_GRANT.sql`]);
  assert.ok(g.ok, g.error);
  assert.match(await r1acl(), /^\{g6le_owner=X\/g6le_owner,authenticated=X\/g6le_owner\}$/u);
  provider.replies.push(
    { candidates: [{ text: "週末限定のいちごタルトを始めました。", hashtags: ["#いちごタルト"] }, { text: "いちごの季節です。", hashtags: [] }] },
    { candidates: [{ text: "週末限定、いちごタルトあります。", hashtags: [] }] },
    { candidates: [{ text: "週末限定のいちごタルト、どうぞ。", hashtags: ["#週末限定"] }] },
    { candidates: [{ text: "今日のおすすめはチーズケーキです。", hashtags: ["#チーズケーキ"] }] },
    { candidates: [{ text: "今日のおすすめ、チーズケーキ。", hashtags: [] }] },
    { candidates: [{ text: "今日のおすすめ、チーズケーキ。", hashtags: ["#チーズケーキ"] }] },
  );
  const w = people.A.workspace;
  const steps: Input[] = [
    { brandId: w, mode: "draft", platform: "x", notes: "いちごタルト 週末限定" },
    { brandId: w, mode: "refine", platform: "x", draft: "週末限定のいちごタルトを始めました。", instruction: "短く" },
    { brandId: w, mode: "hashtags", platform: "x", draft: "週末限定のいちごタルト、どうぞ。" },
    { brandId: w, mode: "draft", platform: "threads", notes: "チーズケーキ" },
    { brandId: w, mode: "refine", platform: "threads", draft: "今日のおすすめはチーズケーキです。", instruction: "やわらかく" },
    { brandId: w, mode: "hashtags", platform: "threads", draft: "今日のおすすめ、チーズケーキ。" },
  ];
  const before = provider.calls.length;
  for (const input of steps) {
    const s = await viaG1(people.A.token, key(`${input.platform}-${input.mode}`), input);
    assert.equal(s.kind, "candidates", `${input.platform} ${input.mode}: ${JSON.stringify(s)}`);
    if (s.kind !== "candidates") continue;
    for (const c of s.candidates) {
      assert.deepEqual([c.platform, c.editable, c.requiresUserConfirmation, c.limit], [input.platform, true, true, input.platform === "x" ? 280 : 500]);
    }
  }
  const sent = provider.calls.slice(before);
  assert.equal(sent.length, 6);
  for (const s of sent) {
    assert.ok(s.startsWith("fake-key "), "the provider gets the provider key only");
    for (const secret of [people.A.token, people.A.id, people.A.email, PUBLISHABLE]) assert.ok(!s.includes(secret), "no token / user id / e-mail / Supabase key to the provider");
  }
  assert.equal(await ledgerState(), "settled=6 calls:complete=6 usage:6");
  assert.equal(await admin("select count(distinct user_id) || ':' || min(user_id::text) from ai_ledger.reservations"), `1:${people.A.id}`, "the ledger subject is the JWT's person");
});

Deno.test({ name: "through the gateway: no-store / nosniff reach the app; an allowed browser Origin is served, any other Origin is refused before anything is asked", ...opts }, async () => {
  const before = provider.calls.length;
  const k = key("origin");
  const ok = await raw(LOCALTEST, { token: people.A.token, key: k, origin: WEB, body: JSON.stringify({ brand_id: people.A.workspace, mode: "draft", platform: "x", notes: "いちごタルト" }) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.headers.get("Cache-Control"), ok.headers.get("X-Content-Type-Options")], ["no-store", "nosniff"]);
  // the local gateway answers CORS itself and replaces the function's Access-Control-Allow-Origin (recorded; hosted: NOT_VERIFIED)
  console.log(`G6LE_FACT allowed_origin_acao=${ok.headers.get("Access-Control-Allow-Origin")}`);
  const bad = await raw(LOCALTEST, { token: people.A.token, key: key("origin-bad"), origin: "https://evil.example", body: JSON.stringify({ brand_id: people.A.workspace, mode: "draft", platform: "x", notes: "x" }) });
  assert.deepEqual([bad.status, bad.body?.error], [403, "POST_ASSIST_ORIGIN_REFUSED"]);
  assert.equal(provider.calls.length, before + 1);
});

Deno.test({ name: "no double charge on the real stack: same key + same input = the stored candidates (no send); same key + other input = new key needed; the same key twice at once = one send, the other waits with the same key", ...opts }, async () => {
  const before = provider.calls.length;
  const ledger0 = await ledgerState();
  const k = key("idem");
  const input = xDraft(people.A.workspace);
  assert.equal(kinds(await viaG1(people.A.token, k, input)), "candidates");
  assert.equal(kinds(await viaG1(people.A.token, k, input)), "candidates");
  assert.deepEqual(await viaG1(people.A.token, k, { ...input, notes: "別の内容" } as Input), { kind: "new_key_needed", code: "POST_ASSIST_OPERATION_REUSED" });
  assert.equal(provider.calls.length, before + 1);
  let release = () => {};
  provider.hold = new Promise((r) => release = r);
  const k2 = key("concurrent");
  const first = viaG1(people.A.token, k2, input);
  while (provider.calls.length < before + 2) await new Promise((r) => setTimeout(r, 50));
  assert.equal(kinds(await viaG1(people.A.token, k2, input)), "retry_same_key");
  provider.hold = null;
  release();
  assert.equal(kinds(await first), "candidates");
  assert.equal(provider.calls.length, before + 2);
  assert.notEqual(await ledgerState(), ledger0);
  assert.match(await ledgerState(), /^settled=\d+ calls:complete=\d+ usage:\d+$/u);
});

Deno.test({ name: "refused with real JWTs (granted): another person's workspace, a person without POSTONA, an anonymous sign-in, a shared workspace, a signed-out session, a timed-out session: 'not available', nothing reserved or sent", ...opts }, async () => {
  const A = people.A, B = people.B, C = people.C;
  const before = provider.calls.length;
  const reservations = () => admin("select count(*) from ai_ledger.reservations");
  const r0 = await reservations();
  const cases: Array<[string, () => Promise<{ kind: string }>]> = [
    ["A asks for B's workspace", () => viaG1(A.token, key("other"), xDraft(B.workspace))],
    ["C has not started POSTONA", () => viaG1(C.token, key("nostart"), xDraft(C.workspace))],
    ["anonymous sign-in", () => viaG1(anonymousToken, key("anon"), xDraft(A.workspace))],
  ];
  for (const [label, run] of cases) assert.equal(kinds(await run()), "not_available", label);
  await admin(`insert into public.brand_memberships (brand_id, user_id, role) values ('${A.workspace}', '${B.id}', 'member')`);
  assert.equal(kinds(await viaG1(A.token, key("shared"), xDraft(A.workspace))), "not_available", "a shared workspace is not a personal one");
  await admin(`delete from public.brand_memberships where brand_id = '${A.workspace}' and user_id = '${B.id}'`);
  assert.equal(kinds(await viaG1(A.token, key("unshared"), xDraft(A.workspace))), "candidates", "unshared again");
  // signed out: GoTrue deletes the session; the access token itself stays valid until it expires, so Kong lets it through and G5 refuses
  const oldToken = A.token;
  assert.equal((await A.client.auth.signOut({ scope: "local" })).error, null);
  assert.equal(kinds(await viaG1(oldToken, key("signedout"), xDraft(A.workspace))), "not_available", "a signed-out session");
  await signInAgain(A);
  assert.equal(kinds(await viaG1(A.token, key("signedin"), xDraft(A.workspace))), "candidates", "a new session works");
  // a session past its not_after (GoTrue's timebox / inactivity end)
  await admin(`update auth.sessions set not_after = now() - interval '1 second' where id = '${claimsOf(A.token).session_id}'`);
  assert.equal(kinds(await viaG1(A.token, key("timedout"), xDraft(A.workspace))), "not_available", "a timed-out session");
  await signInAgain(A);
  assert.equal(provider.calls.length, before + 2, "only the two allowed requests were sent");
  assert.equal(Number(await reservations()), Number(r0) + 2, "refusals reserve nothing");
});

Deno.test({ name: "the auth answers the app sees: Kong's own 401 for a broken / missing JWT, G6's 401 for a non-JWT Bearer; G1's PR #576 copy shows Kong's 401 as 'unavailable' (known gap), G6's reference (this PR) as 'relogin'", ...opts }, async () => {
  const A = people.A;
  const tampered = A.token.slice(0, -4) + (A.token.endsWith("AAAA") ? "BBBB" : "AAAA");
  const kong = await raw(LOCALTEST, { token: tampered, key: key("tampered"), body: JSON.stringify({ brand_id: A.workspace, mode: "draft", platform: "x", notes: "x" }) });
  assert.equal(kong.status, 401);
  assert.equal(Object.keys(kong.body ?? {}).sort().join(","), "code,message,msg", "Kong's body, not the endpoint's");
  const none = await raw(LOCALTEST, { token: null, key: key("none"), body: "{}" });
  assert.deepEqual([none.status, none.body?.error], [401, "POST_ASSIST_AUTH_REQUIRED"], "only the publishable apikey: the gateway lets it in, G6 asks for a sign-in");
  const bare = await raw(LOCALTEST, { token: null, apikey: false, key: key("bare"), body: "{}" });
  assert.deepEqual([bare.status, bare.body?.code], [401, "UNAUTHORIZED_NO_AUTH_HEADER"], "no key at all: the gateway's own 401");
  assert.equal(kinds(await viaG1(tampered, key("t1"), xDraft(A.workspace))), "unavailable", "G1 PR #576 copy: Kong's 401 -> unavailable (sign-in again is never offered)");
  assert.equal(kinds(await viaReference(tampered, key("t2"), xDraft(A.workspace))), "relogin", "G6 reference: any 401 -> sign in again");
  for (const client of [viaG1, viaReference]) assert.equal(kinds(await client(PUBLISHABLE, key("pk"), xDraft(A.workspace))), "relogin", "a publishable key as Bearer: G6's own 401");
});

Deno.test({ name: "revoke (G5's MVP_R1_EXECUTE_REVOKE.sql): refused again, nothing sent; granted again: the stored candidates come back without a send", ...opts }, async () => {
  const k = key("before-revoke");
  const input = xDraft(people.A.workspace);
  assert.equal(kinds(await viaG1(people.A.token, k, input)), "candidates");
  const before = provider.calls.length;
  const rv = await psql("g6le_owner", ["-f", `${MVP}/MVP_R1_EXECUTE_REVOKE.sql`]);
  assert.ok(rv.ok, rv.error);
  assert.match(await r1acl(), /^\{g6le_owner=X\/g6le_owner\}$/u);
  assert.equal(kinds(await viaG1(people.A.token, key("revoked"), input)), "not_available");
  assert.equal(kinds(await viaG1(people.A.token, k, input)), "not_available", "a completed key is not replayed while revoked");
  const g = await psql("g6le_owner", ["-f", `${MVP}/MVP_R1_EXECUTE_GRANT.sql`]);
  assert.ok(g.ok, g.error);
  assert.equal(kinds(await viaG1(people.A.token, k, input)), "candidates");
  assert.equal(provider.calls.length, before);
});

Deno.test({ name: "the REAL entry (postona-post-assist/index.ts, unchanged) on the local runtime: loads and answers; under `supabase functions serve` it is handed SUPABASE_URL=http://kong:8000, which the gateway refuses by design -> 503 for a real person, nothing asked or sent", ...opts }, async () => {
  const before = provider.calls.length;
  const r0 = await admin("select count(*) from ai_ledger.reservations");
  const real = await raw(REAL_ENTRY, { token: people.A.token, key: key("real"), body: JSON.stringify({ brand_id: people.A.workspace, mode: "draft", platform: "x", notes: "x" }) });
  assert.deepEqual([real.status, real.body?.error, real.body?.retry_same_key], [503, "POST_ASSIST_UNAVAILABLE", false]);
  assert.equal(kinds(await viaG1(people.A.token, key("real-g1"), xDraft(people.A.workspace), REAL_ENTRY)), "unavailable");
  const pk = await raw(REAL_ENTRY, { token: PUBLISHABLE, key: key("real-pk"), body: "{}" });
  assert.deepEqual([pk.status, pk.body?.error], [401, "POST_ASSIST_AUTH_REQUIRED"]);
  const ct = await raw(REAL_ENTRY, { token: people.A.token, key: key("real-ct"), body: "x", contentType: "text/plain" });
  assert.deepEqual([ct.status, ct.body?.error], [415, "POST_ASSIST_REQUEST_INVALID"]);
  assert.equal(provider.calls.length, before);
  assert.equal(await admin("select count(*) from ai_ledger.reservations"), r0);
});

Deno.test({ name: "transport facts on the real runtime (recorded, not chosen): a body sent without Content-Length (chunked) and a browser preflight without Authorization", ...opts }, async () => {
  const before = provider.calls.length;
  const body = new TextEncoder().encode(JSON.stringify({ brand_id: people.A.workspace, mode: "draft", platform: "x", notes: "いちごタルト" }));
  const stream = new ReadableStream({ start(c) { c.enqueue(body); c.close(); } });
  const res = await fetch(`${API}/functions/v1/${LOCALTEST}`, {
    method: "POST", body: stream,
    headers: { apikey: PUBLISHABLE, Authorization: `Bearer ${people.A.token}`, "Content-Type": "application/json", "Idempotency-Key": key("chunked") },
  });
  const chunked = `${res.status} ${(await res.json().catch(() => ({})) as Record<string, unknown>).error ?? "ok"}`;
  const pre = await fetch(`${API}/functions/v1/${LOCALTEST}`, { method: "OPTIONS", headers: { Origin: WEB, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type,idempotency-key,apikey" } });
  await pre.body?.cancel();
  console.log(`G6LE_FACT chunked_body=${chunked} preflight=${pre.status} acao=${pre.headers.get("Access-Control-Allow-Origin")}`);
  assert.ok(["400 POST_ASSIST_REQUEST_INVALID", "200 ok"].includes(chunked), chunked);
  assert.equal(provider.calls.length, before + (chunked === "200 ok" ? 1 : 0));
});

Deno.test({ name: "teardown: stop the fake provider", ...opts }, async () => {
  await server?.shutdown();
});
