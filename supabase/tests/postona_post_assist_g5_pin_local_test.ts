// G6-27 (2026-10-30): what G1's real calls get from POSTONA's AI post assist while G5's and G6's SQL are adopted step by step, on the REAL
// local Supabase runtime. Run by postona_post_assist_g5_pin_local_run.sh only (it builds the stack; without it every test is ignored).
// Real here: Kong (verify_jwt), GoTrue (ES256 user JWTs), PostgREST, the Edge runtime, Postgres 17.6.1.165 with the real auth schema,
// G5's PR #590 candidates (W0 + R1-MVP, adopted by the test as `postgres`), G6's ledger / ai_calls / owner-held SQL, supabase-js 2.115.0
// and G1's PR #592 files (the W0 first run, the composer's request / outcome, the client). Fake: the provider (a server on this host).
// "before" = the same twin on G6-26's _shared (PR #582); "after" = this tree. Nothing is deployed; production NO_GO.
import assert from "node:assert/strict";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.115.0";
import { openAiBody } from "../functions/_shared/ai_provider/test_support.ts";

const API = Deno.env.get("G6PP_API") ?? "";
const PUBLISHABLE = Deno.env.get("G6PP_PUBLISHABLE") ?? "";
const DB_PORT = Deno.env.get("G6PP_DB_PORT") ?? "";
const FAKE_PORT = Number(Deno.env.get("G6PP_FAKE_PORT") ?? "0");
const MVP = Deno.env.get("G6PP_MVP") ?? "";
const G6SQL = Deno.env.get("G6PP_G6SQL") ?? "";
const G1 = Deno.env.get("G6PP_G1") ?? "";
const enabled = API !== "" && PUBLISHABLE !== "" && MVP !== "" && G6SQL !== "" && G1 !== "";
const opts = { ignore: !enabled, sanitizeOps: false, sanitizeResources: false };
// G1's own files (PR #592, blob-checked by the runner)
const assist = enabled ? await import(`file://${G1}/features/schedule/post-assist.ts`) : null;
const client = enabled ? await import(`file://${G1}/data/post-assist-client.ts`) : null;
const firstRunOf = enabled ? await import(`file://${G1}/domain/personal-workspace.ts`) : null;

const AFTER = "postona-post-assist-localtest";
const BEFORE = "postona-post-assist-before";
const OWNER = "postgres"; // G5's lifecycle owner on this image (G5 PR #590) and the role G6's SQL runs as
const SUPER = "supabase_admin";

// ---- psql -----------------------------------------------------------------------------------------------------------------------------
async function psql(user: string, args: string[]): Promise<{ ok: boolean; out: string; error: string }> {
  const r = await new Deno.Command("psql", {
    args: ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-h", "127.0.0.1", "-p", DB_PORT, "-U", user, "-d", "postgres", ...args],
    env: { LC_ALL: "C" }, stdout: "piped", stderr: "piped",
  }).output();
  return { ok: r.success, out: new TextDecoder().decode(r.stdout).trim(), error: new TextDecoder().decode(r.stderr).trim() };
}
const sql = async (user: string, text: string) => {
  const r = await psql(user, ["-c", text]);
  assert.ok(r.ok, `${text}\n${r.error}`);
  return r.out;
};
const adopt = async (path: string) => {
  const r = await psql(OWNER, ["-f", path]);
  assert.ok(r.ok, `${path}\n${r.error}`);
};
const derived = (u: string) => sql(SUPER, `select 'u_' || substr(md5('${u}'), 1, 24)`);
// <reservations by status> calls:<consumer calls by state> usage:<usage events>, or "absent" before G6's SQL is adopted
const ledger = async () =>
  await sql(SUPER, "select to_regclass('ai_calls.consumer_calls') is null") === "t" ? "absent" : await sql(SUPER,
    `select (select coalesce(string_agg(status || '=' || n, ',' order by status), '-') from (select status, count(*) n from ai_ledger.reservations group by status) r)
    || ' calls:' || (select coalesce(string_agg(state || '=' || n, ',' order by state), '-') from (select state, count(*) n from ai_calls.consumer_calls group by state) c)
    || ' usage:' || (select count(*) from ai_ledger.usage_events)`);
const lifecycle = (u: string) => sql(SUPER, `select lifecycle_version from public.common_accounts where user_id = '${u}'`);

// ---- the fake provider (the only fake on the request path) -------------------------------------------------------------------------
const provider = { calls: 0, next: null as null | (() => Promise<Response>) };
const server = enabled
  ? Deno.serve({ hostname: "127.0.0.1", port: FAKE_PORT, onListen: () => {} }, async (req) => {
    await req.text();
    provider.calls++;
    const hook = provider.next;
    provider.next = null;
    if (hook) return await hook();
    const reply = { candidates: [{ text: "週末限定のいちごタルトです。", hashtags: ["#いちごタルト"] }] };
    return new Response(JSON.stringify(openAiBody(reply, { model: "gpt-6-luna" })), { status: 200, headers: { "Content-Type": "application/json" } });
  })
  : null;

// ---- people (real GoTrue sign-ups; passwords live only in this process) ---------------------------------------------------------------
type Person = { id: string; token: string; client: SupabaseClient; workspace: string };
const newClient = () => createClient(API, PUBLISHABLE, { auth: { persistSession: false, autoRefreshToken: false } });
const people: Record<string, Person> = {};
async function signUp(label: string, start = true): Promise<Person> {
  const c = newClient();
  const r = await c.auth.signUp({ email: `g6pp-${label.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}@example.test`, password: crypto.randomUUID() });
  assert.ok(r.data.session && r.data.user, r.error?.message);
  if (start) assert.equal(((await c.rpc("start_x_autopost_service")).data as { status: string }).status, "active", `${label} starts POSTONA`);
  return { id: r.data.user.id, token: r.data.session.access_token, client: c, workspace: await derived(r.data.user.id) };
}

// what the app learns from its snapshot (supabase-repository.ts: brand_memberships -> brands, with the person's own session)
async function appWorkspace(p: Person): Promise<string | null> {
  const m = await p.client.from("brand_memberships").select("brand_id").eq("user_id", p.id);
  assert.equal(m.error, null);
  const ids = (m.data ?? []).map((r) => r.brand_id as string);
  if (ids.length === 0) return null;
  const b = await p.client.from("brands").select("id,display_name,is_active,publish_mode").in("id", ids).limit(50);
  assert.equal(b.error, null);
  return (b.data ?? []).find((r) => ids.includes(r.id))?.id ?? null;
}

// ---- G1's calls -----------------------------------------------------------------------------------------------------------------------
/** G1's W0 first run (domain/personal-workspace.ts), exactly as the app's provider calls it. */
const firstRun = async (p: Person): Promise<{ kind: string; workspaceId?: string; created?: boolean }> =>
  await firstRunOf.ensurePersonalWorkspace(firstRunOf.createPersonalWorkspaceCall({ url: API, apiKey: PUBLISHABLE, accessToken: p.token }), new AbortController().signal);
const functionsClient = (fn: string) => {
  const c = newClient();
  return { functions: { invoke: (_name: string, o: { body: Record<string, unknown>; headers: Record<string, string> }) => c.functions.invoke(fn, o) } };
};
type Setup = "ready" | "off" | "unavailable" | "service_inactive" | "not_available" | "support";
const composerEnv = (p: Person, fn: string, workspaceId: string | null, setup: Setup, o: { brandId?: string; token?: string } = {}) => ({
  client: functionsClient(fn), accessToken: o.token ?? p.token, userId: p.id, brandId: o.brandId ?? workspaceId, workspaceId,
  platform: "x", preview: false, loginRefused: false, workspaceSetup: setup, retryWorkspaceSetup: null,
});
/** One press of 「AIで下書き」 in G1's composer (features/schedule/post-assist.ts): gate -> new request -> send -> the screen's view. */
async function press(env: ReturnType<typeof composerEnv>, again?: unknown) {
  const request = again ?? assist.newAssistRequest(env, () => crypto.randomUUID(), "row-1", "draft", "", { notes: "いちごタルト 週末限定", instruction: "" });
  if (request === null) return { shown: `blocked:${assist.assistBlock(env)}`, retry: null, request: null };
  const state = await assist.sendAssist(env, request);
  assert.ok(state !== null, "the composer sent nothing although it built a request");
  const view = assist.assistOutcomeView(state);
  return { shown: String(state.kind), retry: view ? view.retry : null, request };
}
/** G1's client called directly (another build of the app, or a stale screen): G6 must refuse on its own. */
const direct = async (fn: string, token: string, brandId: string, k = key()) =>
  String((await client.requestPostAssist(functionsClient(fn), token, k, { brandId, mode: "draft", platform: "x", notes: "いちごタルト 週末限定" })).kind);
/** The raw HTTP answer of the endpoint. */
async function raw(fn: string, token: string, brandId: string, k = key()) {
  const res = await fetch(`${API}/functions/v1/${fn}`, {
    method: "POST",
    headers: { apikey: PUBLISHABLE, Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Idempotency-Key": k },
    body: JSON.stringify({ brand_id: brandId, mode: "draft", platform: "x", notes: "いちごタルト 週末限定" }),
  });
  const body = await res.json().catch(() => null) as Record<string, unknown> | null;
  return `${res.status} ${body?.error ?? "-"} retry_same_key=${body?.retry_same_key ?? "-"}`;
}
/** PostgREST's own answer to the person's call of G5's R1 verdict RPC. */
async function verdict(p: Person, brand: string) {
  const res = await fetch(`${API}/rest/v1/rpc/common_account_authorization_verdict`, {
    method: "POST",
    headers: { apikey: PUBLISHABLE, Authorization: `Bearer ${p.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_app: "postona", p_feature: "post_generation", p_brand_id: brand }),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}
/**
 * Right after DDL, PostgREST still answers 404 PGRST202 until its schema cache reloads (the image's DDL event trigger notifies it): wait
 * until the person's call of `fn` (with `args`) gets any other answer, and record how long the RPC was "not adopted" over HTTP.
 */
async function untilVisible(label: string, token: string | null, fn: string, args: Record<string, unknown>) {
  const t0 = Date.now();
  const headers: Record<string, string> = { apikey: PUBLISHABLE, "Content-Type": "application/json" };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  for (let i = 0; i < 200; i++) {
    const res = await fetch(`${API}/rest/v1/rpc/${fn}`, { method: "POST", headers, body: JSON.stringify(args) });
    const body = await res.json().catch(() => null) as Record<string, unknown> | null;
    if (!(res.status === 404 && body?.code === "PGRST202")) {
      fact(`${label}: PGRST202 after the adoption`, `${i} polls, ${Date.now() - t0} ms; then HTTP ${res.status}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`${label}: still PGRST202 after 200 polls`);
}
const key = () => `g6pp-${crypto.randomUUID()}`;
const fact = (label: string, value: unknown) => console.log(`G6PP_FACT ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);

// ---- stage 0: neither G5's candidates nor G6's SQL are adopted ------------------------------------------------------------------------
Deno.test({ name: "stage 0 (G5's R1-MVP / W0 not adopted: PostgREST 404 PGRST202): G1's first run says off and the composer sends nothing; a direct call is 'not available' after (before: 'retry with the same key'); nothing sent", ...opts }, async () => {
  const A = people.A = await signUp("A");
  assert.equal(await sql(SUPER, "select to_regprocedure('public.common_account_authorization_verdict(text,text,text)') is null and to_regprocedure('public.postona_ensure_my_personal_workspace()') is null"), "t");
  const r1 = await verdict(A, A.workspace);
  assert.deepEqual([r1.status, r1.body.code], [404, "PGRST202"], "the real PostgREST answer for an RPC that is not adopted");
  assert.deepEqual(await firstRun(A), { kind: "off" }, "G1's W0 first run: not installed -> the feature is off");
  assert.equal((await press(composerEnv(A, AFTER, null, "off"))).shown, "blocked:workspace_off");

  const before = { shown: await direct(BEFORE, A.token, A.workspace), http: await raw(BEFORE, A.token, A.workspace) };
  const after = { shown: await direct(AFTER, A.token, A.workspace), http: await raw(AFTER, A.token, A.workspace) };
  fact("stage0 PGRST202 before", before);
  fact("stage0 PGRST202 after", after);
  assert.deepEqual(before, { shown: "retry_same_key", http: "503 POST_ASSIST_AUTH_UNAVAILABLE retry_same_key=true" }, "G6-26: G5 not adopted looked transient");
  assert.deepEqual(after, { shown: "not_available", http: "403 POST_ASSIST_NOT_ENTITLED retry_same_key=false" });
  assert.equal(assist.assistOutcomeView({ kind: after.shown }).retry, "new_key", "G1 offers no same-key retry");
  const same = key();
  assert.equal(await direct(AFTER, A.token, A.workspace, same), "not_available");
  assert.equal(await direct(AFTER, A.token, A.workspace, same), "not_available", "the same key again: the same refusal");
  assert.deepEqual([provider.calls, await ledger()], [0, "absent"]);
});

// ---- stage 1: G5 adopted (PR #590), G6's SQL not yet ------------------------------------------------------------------------------------
Deno.test({ name: "stage 1 (G5 PR #590 adopted as postgres; G6's ai_calls not adopted: claim 404 PGRST202): W0 creates the workspace the snapshot shows and G5 allows with a g5pv token; G1's composer is told 'unavailable' after (before: 'retry with the same key'); nothing sent", ...opts }, async () => {
  for (const f of ["MVP_INSTALL.sql", "MVP_W0_INSTALL.sql", "MVP_R1_EXECUTE_GRANT.sql", "MVP_W0_EXECUTE_GRANT.sql"]) await adopt(`${MVP}/${f}`);
  const A = people.A;
  await untilVisible("G5 W0", null, "postona_ensure_my_personal_workspace", {}); // no person: W0 writes for whoever calls it
  await untilVisible("G5 R1", A.token, "common_account_authorization_verdict", { p_app: "postona", p_feature: "post_generation", p_brand_id: A.workspace });
  assert.deepEqual(await firstRun(A), { kind: "ready", workspaceId: A.workspace, created: true }, "G1's first run: W0 created the personal workspace");
  assert.deepEqual(await firstRun(A), { kind: "ready", workspaceId: A.workspace, created: false });
  assert.equal(await appWorkspace(A), A.workspace, "the snapshot shows exactly W0's workspace (brand id = workspace id)");
  assert.equal(await sql(SUPER, `select count(*) || '/' || string_agg(role, ',') from public.brand_memberships where user_id = '${A.id}'`), "1/owner");
  const v = await verdict(A, A.workspace);
  assert.equal(v.status, 200);
  assert.deepEqual([v.body.decision, (v.body.scope as Record<string, unknown>).brand_slug, (v.body.subject as Record<string, unknown>).user_id], ["allow", A.workspace, A.id]);
  assert.match(String(v.body.owner_epoch), /^g5pv:[1-9][0-9]*$/u, "the personal-MVP token G6's adapter pins");
  assert.deepEqual(v.body.entitlements, ["postona:x_autopost"]);
  assert.equal(typeof (v.body.session as Record<string, unknown>).ref, "string");
  assert.equal(await sql(SUPER, "select to_regprocedure('public.ai_calls_claim(jsonb)') is null"), "t", "G6's SQL is not adopted yet");

  const before = await press(composerEnv(A, BEFORE, A.workspace, "ready"));
  const after = await press(composerEnv(A, AFTER, A.workspace, "ready"));
  const http = { before: await raw(BEFORE, A.token, A.workspace), after: await raw(AFTER, A.token, A.workspace) };
  fact("stage1 claim PGRST202 before", { shown: before.shown, retry: before.retry, http: http.before });
  fact("stage1 claim PGRST202 after", { shown: after.shown, retry: after.retry, http: http.after });
  assert.deepEqual([before.shown, before.retry, http.before], ["retry_same_key", "same_key", "503 POST_ASSIST_UNAVAILABLE retry_same_key=true"], "G6-26");
  assert.deepEqual([after.shown, after.retry, http.after], ["unavailable", "new_key", "503 POST_ASSIST_NOT_SENT retry_same_key=false"]);
  assert.deepEqual([provider.calls, await ledger()], [0, "absent"]);
});

// ---- stage 2: everything adopted --------------------------------------------------------------------------------------------------------
let firstRequest: unknown = null;
Deno.test({ name: "stage 2 (G6's ledger / ai_calls / owner-held SQL adopted): G1's composer gets editable candidates for its W0 workspace with one send and one settled charge; the same request again is the stored answer (no send)", ...opts }, async () => {
  for (const f of ["20261010050613_ai_provider_budget_ledger.sql", "20261017120000_ai_consumer_call_store.sql", "20261017150000_ai_ledger_user_erasure.sql",
    "20261020154536_ai_calls_owner_held_rc_guard.sql", "001_ai_calls_owner_held_ledger.sql"]) await adopt(`${G6SQL}/${f}`);
  await sql(OWNER, `insert into ai_ledger.budget_policies
    (policy_key, scope_provider, scope_model, scope_application, scope_feature, scope_subject_kind, per_user, period, max_calls, max_estimated_usd, max_usd_per_call)
    values ('g6pp.postona.post', 'openai', 'gpt-6-luna', 'postona', 'post_generation', 'user', true, 'day', 200, 5, 0.2)`);
  const A = people.A;
  await untilVisible("G6 ai_calls_claim", A.token, "ai_calls_claim", { p: {} });
  await untilVisible("G6 ai_calls_release_held", A.token, "ai_calls_release_held", { p: {} });
  const env = composerEnv(A, AFTER, A.workspace, "ready");
  const first = await press(env);
  assert.deepEqual([first.shown, first.retry, provider.calls, await ledger()], ["candidates", null, 1, "settled=1 calls:complete=1 usage:1"]);
  firstRequest = first.request;
  const again = await press(env, first.request);
  assert.deepEqual([again.shown, provider.calls, await ledger()], ["candidates", 1, "settled=1 calls:complete=1 usage:1"], "replayed, not sent again");
});

Deno.test({ name: "workspace and session refusals with real JWTs: another person's W0 workspace, an id nobody has, a person who did not start POSTONA (W0: service inactive), a signed-out session -> 'not available'; G1's composer itself never sends for another workspace; nothing sent or claimed", ...opts }, async () => {
  const A = people.A;
  const B = people.B = await signUp("B");
  assert.deepEqual(await firstRun(B), { kind: "ready", workspaceId: B.workspace, created: true });
  const calls = provider.calls, state = await ledger();
  assert.equal((await press(composerEnv(A, AFTER, A.workspace, "ready", { brandId: B.workspace }))).shown, "blocked:other_workspace");
  assert.equal(await direct(AFTER, A.token, B.workspace), "not_available", "A asks for B's workspace");
  assert.equal(await direct(AFTER, A.token, "u_000000000000000000000000"), "not_available", "a well-formed id nobody has");
  const C = await signUp("C", false);
  assert.deepEqual(await firstRun(C), { kind: "service_inactive" });
  assert.equal(await direct(AFTER, C.token, C.workspace), "not_available", "no POSTONA, no workspace");
  const D = await signUp("D");
  assert.equal((await firstRun(D)).kind, "ready");
  const old = D.token;
  assert.equal((await D.client.auth.signOut()).error, null);
  assert.equal(await raw(AFTER, old, D.workspace), "403 POST_ASSIST_NOT_ENTITLED retry_same_key=false", "the JWT is still in date (Kong lets it through); G5 refuses the ended session");
  assert.equal((await press(composerEnv(D, AFTER, D.workspace, "ready", { token: old }))).shown, "not_available");
  assert.deepEqual([provider.calls, await ledger()], [calls, state]);
});

Deno.test({ name: "the service ended and started again: 'not available' while ended (G1's first run: service inactive); a new g5pv generation after; the earlier request replays its stored candidates (no send), a new one sends once", ...opts }, async () => {
  const A = people.A;
  const g1 = String((await verdict(A, A.workspace)).body.owner_epoch);
  await sql(SUPER, `update public.service_entitlements set status = 'ended', ended_at = now() where user_id = '${A.id}' and service_key = 'x_autopost'`);
  const calls = provider.calls;
  assert.deepEqual(await firstRun(A), { kind: "service_inactive" });
  assert.equal((await press(composerEnv(A, AFTER, A.workspace, "ready"), firstRequest)).shown, "not_available", "even the stored key is refused while ended");
  assert.equal((await press(composerEnv(A, AFTER, A.workspace, "ready"))).shown, "not_available");
  const re = await A.client.rpc("reactivate_x_autopost_service", { p_expected_lifecycle_version: Number(await lifecycle(A.id)) });
  assert.equal((re.data as { status: string } | null)?.status, "active", JSON.stringify(re.error));
  const g2 = String((await verdict(A, A.workspace)).body.owner_epoch);
  assert.ok(g1 !== g2 && g2.startsWith("g5pv:"), `${g1} -> ${g2}`);
  assert.deepEqual(await firstRun(A), { kind: "ready", workspaceId: A.workspace, created: false });
  assert.equal((await press(composerEnv(A, AFTER, A.workspace, "ready"), firstRequest)).shown, "candidates");
  assert.equal(provider.calls, calls, "the stored candidates: no send");
  assert.equal((await press(composerEnv(A, AFTER, A.workspace, "ready"))).shown, "candidates");
  assert.deepEqual([provider.calls, await ledger()], [calls + 1, "settled=2 calls:complete=2 usage:2"]);
});

Deno.test({ name: "the generation moves between the verdict and the send (A-B-A: the service ended and started again while the provider answers 429): the recheck before the next attempt refuses -> 'not available'; one attempt reached the provider and nothing was charged; the same request replays the stored NOT_SENT ('unavailable', new key only), a new one sends once", ...opts }, async () => {
  const A = people.A;
  const calls = provider.calls;
  const g1 = String((await verdict(A, A.workspace)).body.owner_epoch);
  let g2 = "";
  provider.next = async () => {
    await sql(SUPER, `update public.service_entitlements set status = 'ended', ended_at = now() where user_id = '${A.id}' and service_key = 'x_autopost'`);
    const re = await A.client.rpc("reactivate_x_autopost_service", { p_expected_lifecycle_version: Number(await lifecycle(A.id)) });
    assert.equal((re.data as { status: string } | null)?.status, "active", JSON.stringify(re.error));
    g2 = String((await verdict(A, A.workspace)).body.owner_epoch);
    return new Response(JSON.stringify({ error: { message: "rate limited", type: "requests", code: "rate_limit_exceeded" } }),
      { status: 429, headers: { "Content-Type": "application/json", "retry-after": "1" } });
  };
  const env = composerEnv(A, AFTER, A.workspace, "ready");
  const r = await press(env);
  fact("in-flight generation", { from: g1, to: g2, shown: r.shown, retry: r.retry, provider_attempts: provider.calls - calls, ledger: await ledger() });
  assert.ok(g2 !== "" && g2 !== g1, `${g1} -> ${g2}`);
  assert.deepEqual([r.shown, r.retry, provider.calls - calls], ["not_available", "new_key", 1]);
  // the 429 attempt is recorded as failed at no cost; the next attempt's reservation was released before anything was sent
  assert.equal(await sql(SUPER, `select outcome || ' ' || error_code || ' ' || http_status || ' ' || (estimated_cost_usd = 0) from ai_ledger.usage_events order by id desc limit 1`),
    "failed RATE_LIMITED 429 true");
  assert.equal(await ledger(), "released=1,settled=3 calls:complete=3 usage:3");
  assert.equal(await sql(SUPER, "select count(*) from ai_ledger.usage_events where estimated_cost_usd > 0 and outcome = 'succeeded'"), "2", "charged: the two earlier requests only");
  // the same key replays what was stored for it (NOT_SENT: 503 without a same-key retry), not sent again
  const replay = await press(env, r.request);
  assert.deepEqual([replay.shown, replay.retry], ["unavailable", "new_key"], "the same request is not sent again");
  assert.equal(provider.calls - calls, 1);
  assert.equal((await press(env)).shown, "candidates", "a new request on the new generation");
  assert.deepEqual([provider.calls - calls, await ledger()], [2, "released=1,settled=4 calls:complete=4 usage:4"]);
});

Deno.test({ name: "teardown: stop the fake provider", ...opts }, async () => {
  await server?.shutdown();
});
