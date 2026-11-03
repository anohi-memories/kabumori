// G6-25 (2026-10-29): POSTONA's AI post assist through its REAL Edge entry handler (postona_post_assist_edge.ts, served by
// supabase/functions/postona-post-assist; NOT deployed) -> G6-21 personal-MVP adapter -> G5-48's R1-MVP on real SQL (PR #563, NOT applied
// anywhere: MVP_INSTALL.sql, then MVP_R1_EXECUTE_GRANT.sql / MVP_R1_EXECUTE_REVOKE.sql run here as G5's lifecycle owner) -> owner-held gateway
// on the real ledger + ai_calls + owner-held SQL -> a fake OpenAI. The fetch plays PostgREST: a fixed fake token -> fixed claims and the
// database role its `role` claim names (no JWT is verified: the Supabase Auth/JWT step is NOT_VERIFIED here). Production NO_GO.
// Run by common_ai_gateway_post_assist_g5_48_pg_run.sh (two throw-away databases on a local socket-only PostgreSQL 17).
import assert from "node:assert/strict";
import { FAKE_OPENAI_KEY, jsonResponse, openAiBody } from "../functions/_shared/ai_provider/test_support.ts";
import { G5_VERDICT_RPC } from "../functions/_shared/ai_gateway/g5_rpc_transport.ts";
import { createPostonaPostAssistEdgeHandler, POST_ASSIST_EDGE_ENV } from "../functions/_shared/ai_gateway/postona_post_assist_edge.ts";

const env = (name: string) => Deno.env.get(name) ?? "";
const [HOST, PORT, SUPER, OWNER, DB_G5, DB_LED, MVP] = ["G6PA_PGHOST", "G6PA_PGPORT", "G6PA_PGSUPER", "G6PA_OWNER", "G6PA_DB_G5", "G6PA_DB_LED", "G6PA_MVP"].map(env);
const enabled = env("G6PA_E2E") === "1" && /^\/(private\/)?tmp\//u.test(HOST) && !!PORT && !!SUPER && !!OWNER && !!DB_G5 && !!DB_LED && !!MVP;
const opts = { ignore: !enabled, sanitizeOps: false, sanitizeResources: false };
const decoder = new TextDecoder();

type Result = { ok: boolean; out: string; error: string };
async function run(db: string, user: string, args: string[]): Promise<Result> {
  const o = await new Deno.Command("psql", {
    args: ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-h", HOST, "-p", PORT, "-U", user, "-d", db, ...args],
    env: { LC_ALL: "C", PGTZ: "UTC" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return { ok: o.success, out: decoder.decode(o.stdout).trim(), error: decoder.decode(o.stderr).trim() };
}
async function sql(db: string, user: string, statement: string): Promise<string> {
  const r = await run(db, user, ["-c", statement]);
  assert.ok(r.ok, `${statement}\n${r.error}`);
  return r.out;
}
const g5 = (statement: string) => sql(DB_G5, OWNER, statement);
const led = (statement: string) => sql(DB_LED, SUPER, statement);
const lit = (v: string) => `'${v.replaceAll("'", "''")}'`;
const runFile = async (name: string) => await run(DB_G5, OWNER, ["-f", `${MVP}/${name}`]);
const R1FN = "public.common_account_authorization_verdict(text,text,text)";
const r1acl = () => g5(`select array_to_string(proacl::text[], ',') from pg_proc where oid = '${R1FN}'::regprocedure`);

// ---- people (G5's world) ---------------------------------------------------------------------------------------------------------------
const id = (n: number) => `00000000-0000-4000-8000-0000000625${String(n).padStart(2, "0")}`;
const [A, B, D] = [id(1), id(2), id(4)];
const [SA, SB, SD] = [id(51), id(52), id(54)];
type Claims = Record<string, unknown>;
const claims = (u: string, s: string, extra: Claims = {}): Claims => ({ sub: u, role: "authenticated", session_id: s, is_anonymous: false, ...extra });
let WA = "";
let WB = "";
let WD = "";
let LV = "";

// ---- the Edge environment (fake, production-SHAPED: https Supabase URL, sb_secret_-shaped key; nothing leaves the process) ---------------
const SUPABASE = "https://abcdefghijklmnopqrst.supabase.co";
const SERVICE_KEY = "sb_secret_" + "FAKE_G6_25_0000000000";
const PUBLISHABLE = "sb_publishable_" + "FAKE_G6_25_NOT_A_SECRET";
const WEB = "https://app.postona.example";
const FEATURE = {
  enabled: true, revision: "g6-25-pg-1", provider: "openai", model: "gpt-6-luna", reasoningEffort: "low", maxOutputTokens: 800, timeoutMs: 20_000,
  maxAttempts: 1, maxCostUsdPerOperation: 0.1, maxInputBytes: 8_000, entitlements: ["postona:x_autopost"],
};
const ENV: Record<string, string> = {
  [POST_ASSIST_EDGE_ENV.supabaseUrl]: SUPABASE,
  [POST_ASSIST_EDGE_ENV.publishableKey]: PUBLISHABLE,
  [POST_ASSIST_EDGE_ENV.serviceKey]: SERVICE_KEY,
  [POST_ASSIST_EDGE_ENV.feature]: JSON.stringify(FEATURE),
  [POST_ASSIST_EDGE_ENV.allowedOrigins]: WEB,
  OPENAI_API_KEY: FAKE_OPENAI_KEY,
};

// ---- PostgREST stand-in: a fake token -> (the database role of its role claim, the claims) ----------------------------------------------
// JWT-shaped strings, not tokens. The service key / the publishable key sent as the person's Bearer are mapped the way Supabase maps them.
const TOKENS: Record<string, { role: string; claims: Claims | string }> = {
  "g6pa-a.session-a.NOTREAL": { role: "authenticated", claims: claims(A, SA) },
  "g6pa-a.anonymous.NOTREAL": { role: "authenticated", claims: claims(A, SA, { is_anonymous: true }) },
  "g6pa-a.no-anonymous-claim.NOTREAL": { role: "authenticated", claims: { sub: A, role: "authenticated", session_id: SA } },
  "g6pa-a.session-of-d.NOTREAL": { role: "authenticated", claims: claims(A, SD) },
  "g6pa-a.unknown-session.NOTREAL": { role: "authenticated", claims: claims(A, id(98)) },
  "g6pa-a.role-anon.NOTREAL": { role: "anon", claims: claims(A, SA, { role: "anon" }) },
  "g6pa-a.role-service.NOTREAL": { role: "service_role", claims: claims(A, SA, { role: "service_role" }) },
  "g6pa-b.session-b.NOTREAL": { role: "authenticated", claims: claims(B, SB) },
  "g6pa-d.session-d.NOTREAL": { role: "authenticated", claims: claims(D, SD) },
  // legacy JWT-shaped API keys sent as the person's Bearer: PostgREST runs them as their role
  "eyLEGACY.service-role-key.NOTREAL": { role: "service_role", claims: { role: "service_role" } },
  "eyLEGACY.anon-key.NOTREAL": { role: "anon", claims: { role: "anon" } },
};
const TOKEN_A = "g6pa-a.session-a.NOTREAL";

type Seen = { url: string; apikey: string | null; authorization: string | null; body: string };
function world(envOverride: Record<string, string | undefined> = {}) {
  const e = { ...ENV, ...envOverride };
  const seen = { g5: [] as Seen[], ledger: [] as Array<Seen & { rpc: string }>, provider: [] as Seen[], other: [] as string[] };
  // per request: statements run in the G5 transaction of the n-th G5 question (0 = the verdict, 1 = the recheck before the send); rolled back
  const g5Script: string[] = [];
  let g5n = 0;
  const replies: unknown[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const h = new Headers(init?.headers);
    const s: Seen = { url, apikey: h.get("apikey"), authorization: h.get("Authorization"), body: String(init?.body ?? "") };
    if (url === `${SUPABASE}/rest/v1/rpc/${G5_VERDICT_RPC}`) {
      seen.g5.push(s);
      if (s.apikey !== PUBLISHABLE) return jsonResponse(401, { code: "PGRST301", message: "No suitable key" });
      const who = TOKENS[s.authorization?.match(/^Bearer (\S+)$/u)?.[1] ?? ""];
      if (!who) return jsonResponse(401, { code: "PGRST301", message: "JWT invalid" });
      const p = JSON.parse(s.body) as Record<string, string | null>;
      const before = g5Script[g5n++] ?? "";
      const text = typeof who.claims === "string" ? who.claims : JSON.stringify(who.claims);
      const call = `select public.common_account_authorization_verdict(${lit(String(p.p_app))}, ${lit(String(p.p_feature))}, ${p.p_brand_id === null ? "null" : lit(String(p.p_brand_id))})::text`;
      const r = await run(DB_G5, OWNER, ["-c", `begin; ${before}`, "-c", `select set_config('request.jwt.claims', ${lit(text)}, true); set local role ${who.role};`, "-c", call, "-c", "rollback;"]);
      if (r.ok) return new Response(r.out.split("\n").pop(), { status: 200, headers: { "Content-Type": "application/json" } });
      if (/permission denied for function/u.test(r.error)) return jsonResponse(403, { code: "42501", message: "permission denied" });
      return jsonResponse(500, { code: "XX000", message: "statement failed" });
    }
    const rpc = url.startsWith(`${SUPABASE}/rest/v1/rpc/`) ? url.slice(`${SUPABASE}/rest/v1/rpc/`.length) : null;
    if (rpc !== null && /^ai_(?:ledger|calls)_[a-z_]+$/u.test(rpc)) {
      seen.ledger.push({ ...s, rpc });
      if (s.apikey !== SERVICE_KEY) return jsonResponse(401, { code: "PGRST301" });
      const payload = JSON.stringify((JSON.parse(s.body) as { p: unknown }).p);
      assert.ok(!payload.includes("$g6pa$"));
      const r = await run(DB_LED, SUPER, ["-c", `set role service_role; select public.${rpc}($g6pa$${payload}$g6pa$::jsonb)`]);
      return r.ok ? new Response(r.out, { status: 200, headers: { "Content-Type": "application/json" } }) : jsonResponse(400, { code: r.error.match(/ERROR:\s+([A-Z0-9_]+)/u)?.[1] ?? "XX000" });
    }
    if (url.startsWith("https://api.openai.com/")) {
      seen.provider.push(s);
      return jsonResponse(200, openAiBody(replies.shift() ?? { candidates: [{ text: "週末限定のいちごタルトです。", hashtags: ["#いちごタルト"] }] }, { model: "gpt-6-luna" }));
    }
    seen.other.push(url);
    return jsonResponse(404, {});
  };
  const handler = createPostonaPostAssistEdgeHandler({
    readEnv: (name) => e[name],
    fetch,
    g5TimeoutMs: 10_000,
    retryTiming: { baseDelayMs: 1, maxDelayMs: 1, maxRetryAfterMs: 10, minAttemptMs: 1 },
    sleep: () => Promise.resolve(),
    random: () => 0,
  });
  type Body = Record<string, unknown> | null;
  const send = async (o: { token?: string | null; key?: string; body?: Record<string, unknown>; g5?: string[]; origin?: string } = {}) => {
    g5Script.length = 0;
    g5Script.push(...(o.g5 ?? []));
    g5n = 0;
    const text = JSON.stringify({ brand_id: WA, mode: "draft", platform: "x", notes: "いちごタルト 週末限定", ...(o.body ?? {}) });
    const headers: Record<string, string> = { "Content-Type": "application/json", "Content-Length": String(new TextEncoder().encode(text).length), "Idempotency-Key": o.key ?? "g6pa-key-0000" };
    if (o.token !== null) headers.Authorization = `Bearer ${o.token ?? TOKEN_A}`;
    if (o.origin) headers.Origin = o.origin;
    const res = await handler(new Request("https://edge.example/functions/v1/postona-post-assist", { method: "POST", body: text, headers }));
    const raw = await res.text();
    return { status: res.status, headers: res.headers, body: (raw ? JSON.parse(raw) : null) as Body };
  };
  return { send, seen, replies };
}

// what reached the ledger / the provider: reservations by status, ai_calls by state, usage cost
const ledgerState = async () =>
  await led(`select (select coalesce(string_agg(status || '=' || n, ',' order by status), '-') from (select status, count(*) n from ai_ledger.reservations group by status) r)
    || ' calls:' || (select coalesce(string_agg(state || '=' || n, ',' order by state), '-') from (select state, count(*) n from ai_calls.consumer_calls group by state) c)
    || ' usage:' || (select count(*) || '/' || coalesce(sum(estimated_cost_usd), 0) from ai_ledger.usage_events)`);
const code = (r: { status: number; body: Record<string, unknown> | null }) => `${r.status} ${String(r.body?.error ?? "ok")}${r.body?.retry_same_key === true ? " retry" : ""}`;
const DENIED = "403 POST_ASSIST_NOT_ENTITLED";
const CANDIDATE_KEYS = "editable,hashtags,length,limit,platform,requiresUserConfirmation,text";
const restart = () => `update public.service_entitlements set status = 'ended', ended_at = now() where user_id = '${A}' and service_key = 'x_autopost';
  select set_config('request.jwt.claims', ${lit(JSON.stringify(claims(A, SA)))}, true); set local role authenticated;
  select public.reactivate_x_autopost_service((select lifecycle_version from public.common_accounts where user_id = '${A}')); reset role;`;

Deno.test({ name: "setup: G5-48's MVP_INSTALL.sql as the lifecycle owner (R1-MVP owner-only, no owner epoch); A and D started POSTONA in their own workspace with a live session; B logged in without POSTONA; the ledger side is empty", ...opts }, async () => {
  const r = await runFile("MVP_INSTALL.sql");
  assert.ok(r.ok, r.error);
  assert.equal(await r1acl(), `${OWNER}=X/${OWNER}`, "as shipped: owner-only");
  await g5(`select public.fixture_user_with_workspace(u, 'g625' || right(u::text, 2)), public.fixture_login(u) from unnest(array['${A}', '${B}', '${D}']::uuid[]) u;
    insert into auth.sessions (id, user_id, not_after) values ('${SA}', '${A}', null), ('${SB}', '${B}', null), ('${SD}', '${D}', null)`);
  for (const [u, s] of [[A, SA], [D, SD]]) {
    const started = await run(DB_G5, OWNER, ["-c", "begin;", "-c", `select set_config('request.jwt.claims', ${lit(JSON.stringify(claims(u, s)))}, true); set local role authenticated;`,
      "-c", "select public.start_x_autopost_service() ->> 'status'", "-c", "commit;"]);
    assert.ok(started.ok && started.out.split("\n").includes("active"), started.error || started.out);
  }
  [WA, WB, WD] = await Promise.all([A, B, D].map((u) => g5(`select 'u_' || substr(md5('${u}'), 1, 24)`)));
  LV = await g5(`select lifecycle_version from public.common_accounts where user_id = '${A}'`);
  assert.equal(await ledgerState(), "- calls:- usage:0/0");
});

Deno.test({ name: "as shipped (no EXECUTE for authenticated): the person's X draft is refused 403 NOT_ENTITLED; G5 answered permission denied once; nothing claimed, reserved or sent", ...opts }, async () => {
  const w = world();
  const r = await w.send({ key: "g6pa-shipped-0001" });
  assert.equal(code(r), DENIED, JSON.stringify(r.body));
  assert.deepEqual([w.seen.g5.length, w.seen.ledger.length, w.seen.provider.length, w.seen.other.length], [1, 0, 0, 0]);
  assert.equal(await ledgerState(), "- calls:- usage:0/0");
});

Deno.test({ name: "MVP_R1_EXECUTE_GRANT.sql as the lifecycle owner: R1-MVP's ACL is exactly owner + authenticated; anon / service_role / PUBLIC cannot execute it", ...opts }, async () => {
  const r = await runFile("MVP_R1_EXECUTE_GRANT.sql");
  assert.ok(r.ok, r.error);
  assert.equal(await r1acl(), `${OWNER}=X/${OWNER},authenticated=X/${OWNER}`);
  assert.equal(await g5(`select string_agg(r || '=' || has_function_privilege(r, '${R1FN}', 'EXECUTE'), ',' order by r) from unnest(array['anon', 'authenticated', 'service_role']) r`),
    "anon=false,authenticated=true,service_role=false");
});

Deno.test({ name: "granted: the person's X and Threads draft -> refine -> hashtags over HTTP: 200, the screen contract (exact keys, editable, to be confirmed, platform limits), no-store; one send and one settled reservation per step; G5 asked twice per step with the person's token, the three named arguments only; keys never cross", ...opts }, async () => {
  const w = world();
  w.replies.push(
    { candidates: [{ text: "週末限定のいちごタルトを始めました。", hashtags: ["#いちごタルト"] }, { text: "いちごの季節です。", hashtags: [] }] },
    { candidates: [{ text: "週末限定、いちごタルトあります。", hashtags: [] }] },
    { candidates: [{ text: "週末限定のいちごタルト、どうぞ。", hashtags: ["#週末限定"] }] },
    { candidates: [{ text: "今日のおすすめはチーズケーキです。", hashtags: ["#チーズケーキ"] }, { text: "チーズケーキとカフェの午後。", hashtags: ["#チーズケーキ", "#カフェ"] }] },
    { candidates: [{ text: "今日のおすすめ、チーズケーキ。", hashtags: [] }] },
    { candidates: [{ text: "今日のおすすめ、チーズケーキ。", hashtags: ["#チーズケーキ"] }] },
  );
  const steps: Array<[string, Record<string, unknown>]> = [
    ["g6pa-x-draft-0001", { mode: "draft", platform: "x", notes: "いちごタルト 週末限定" }],
    ["g6pa-x-refine-0001", { mode: "refine", platform: "x", notes: undefined, draft: "週末限定のいちごタルトを始めました。", instruction: "短く" }],
    ["g6pa-x-tags-0001", { mode: "hashtags", platform: "x", notes: undefined, draft: "週末限定のいちごタルト、どうぞ。" }],
    ["g6pa-th-draft-0001", { mode: "draft", platform: "threads", notes: "チーズケーキ" }],
    ["g6pa-th-refine-0001", { mode: "refine", platform: "threads", notes: undefined, draft: "今日のおすすめはチーズケーキです。", instruction: "やわらかく" }],
    ["g6pa-th-tags-0001", { mode: "hashtags", platform: "threads", notes: undefined, draft: "今日のおすすめ、チーズケーキ。" }],
  ];
  for (const [key, body] of steps) {
    const r = await w.send({ key, body, origin: WEB });
    assert.equal(r.status, 200, `${key} ${JSON.stringify(r.body)}`);
    assert.equal(Object.keys(r.body!).sort().join(","), "candidates,notice", key);
    assert.equal(typeof r.body!.notice, "string");
    const cands = r.body!.candidates as Array<Record<string, unknown>>;
    assert.ok(cands.length > 0, key);
    for (const c of cands) {
      assert.equal(Object.keys(c).sort().join(","), CANDIDATE_KEYS, key);
      assert.deepEqual([c.platform, c.editable, c.requiresUserConfirmation, c.limit], [body.platform, true, true, body.platform === "x" ? 280 : 500], key);
    }
    assert.deepEqual([r.headers.get("Cache-Control"), r.headers.get("X-Content-Type-Options"), r.headers.get("Access-Control-Allow-Origin")], ["no-store", "nosniff", WEB], key);
  }
  assert.equal(w.seen.provider.length, 6);
  assert.match(await ledgerState(), /^settled=6 calls:complete=6 usage:6\/0\.\d*[1-9]\d*$/u, "six settled sends, each charged");
  assert.equal(await led(`select count(distinct user_id) || ':' || min(user_id::text) from ai_ledger.reservations`), `1:${A}`, "the person is the ledger subject");
  assert.equal(w.seen.g5.length, 12, "a verdict and a recheck per step");
  assert.ok(w.seen.g5.every((s) => s.authorization === `Bearer ${TOKEN_A}` && s.apikey === PUBLISHABLE), "G5: the person's token + the publishable key only");
  assert.deepEqual([...new Set(w.seen.g5.map((s) => Object.keys(JSON.parse(s.body)).sort().join(",")))], ["p_app,p_brand_id,p_feature"]);
  assert.deepEqual([...new Set(w.seen.g5.map((s) => s.body))], [JSON.stringify({ p_app: "postona", p_feature: "post_generation", p_brand_id: WA })]);
  assert.ok(w.seen.ledger.every((s) => s.apikey === SERVICE_KEY && !String(s.authorization).includes(TOKEN_A) && !s.body.includes(TOKEN_A)), "ledger: the service key, never the person's token");
  const rpcs = new Set(w.seen.ledger.map((s) => s.rpc));
  assert.ok(rpcs.has("ai_calls_reserve_held") && rpcs.has("ai_calls_mark_sent_held"), [...rpcs].join(","));
  assert.ok(!rpcs.has("ai_ledger_reserve") && !rpcs.has("ai_ledger_mark_sent"), "never the legacy ledger path");
  assert.ok(w.seen.provider.every((s) => s.authorization === `Bearer ${FAKE_OPENAI_KEY}` && !s.body.includes(TOKEN_A) && !s.body.includes(SERVICE_KEY) && !s.body.includes(A)),
    "OpenAI: its key only; no token, service key or user id in the body");
  assert.deepEqual(w.seen.other, []);
  console.log(`G6-25 granted flow: 6 steps 200, sends 6, ${await ledgerState()}, G5 calls ${w.seen.g5.length}, owner_epoch g5pv:${LV}`);
});

Deno.test({ name: "no double charge: the same key and body answers the stored candidates with no new send; the same key with another body is OPERATION_REUSED; two concurrent requests with one new key send at most once", ...opts }, async () => {
  const w = world();
  const before = await ledgerState();
  const again = await w.send({ key: "g6pa-x-draft-0001", body: { mode: "draft", platform: "x", notes: "いちごタルト 週末限定" } });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal((again.body!.candidates as Array<{ text: string }>)[0].text, "週末限定のいちごタルトを始めました。", "the stored answer");
  const reused = await w.send({ key: "g6pa-x-draft-0001", body: { mode: "draft", platform: "x", notes: "別の内容" } });
  assert.equal(code(reused), "409 POST_ASSIST_OPERATION_REUSED");
  assert.deepEqual([w.seen.provider.length, await ledgerState()], [0, before], "no send, nothing new in the ledger");
  const both = await Promise.all([w.send({ key: "g6pa-x-race-0001" }), w.send({ key: "g6pa-x-race-0001" })]);
  const codes = both.map(code).sort();
  assert.ok(codes.every((c) => c === "200 ok" || c === "409 POST_ASSIST_IN_PROGRESS retry"), codes.join(" / "));
  assert.equal(w.seen.provider.length, 1, "one send for one key");
  assert.equal(await led(`select count(*) from ai_ledger.usage_events`), String(Number(before.match(/usage:(\d+)/u)![1]) + 1), "one charge");
  console.log(`G6-25 concurrent same key: ${codes.join(" / ")}, sends 1`);
});

Deno.test({ name: "granted, fail closed: anonymous, missing is_anonymous, another person's or an unknown or an ended session, a role claim of anon / service_role, a legacy service_role / anon key as the Bearer, an unknown token, another workspace, a malformed workspace, a login without POSTONA, an ended or suspended service, a shared workspace -> 403 NOT_ENTITLED; an sb_secret_ / sb_publishable_ key as the Bearer -> 401 (G5 not asked); G5 down -> 503 retry; never a claim, a reservation or a send", ...opts }, async () => {
  const before = await ledgerState();
  const cases: Array<[string, Parameters<ReturnType<typeof world>["send"]>[0], string]> = [
    ["anonymous", { token: "g6pa-a.anonymous.NOTREAL" }, DENIED],
    ["is_anonymous missing", { token: "g6pa-a.no-anonymous-claim.NOTREAL" }, DENIED],
    ["another person's live session id", { token: "g6pa-a.session-of-d.NOTREAL" }, DENIED],
    ["an unknown session", { token: "g6pa-a.unknown-session.NOTREAL" }, DENIED],
    ["an ended session", { g5: [`update auth.sessions set not_after = now() - interval '1 minute' where id = '${SA}';`] }, DENIED],
    ["role claim anon (database role anon)", { token: "g6pa-a.role-anon.NOTREAL" }, DENIED],
    ["role claim service_role (database role service_role)", { token: "g6pa-a.role-service.NOTREAL" }, DENIED],
    ["the sb_secret_ key as the person's Bearer (not a JWT)", { token: SERVICE_KEY }, "401 POST_ASSIST_AUTH_REQUIRED"],
    ["the sb_publishable_ key as the person's Bearer (not a JWT)", { token: PUBLISHABLE }, "401 POST_ASSIST_AUTH_REQUIRED"],
    ["a legacy service_role key as the person's Bearer", { token: "eyLEGACY.service-role-key.NOTREAL" }, DENIED],
    ["a legacy anon key as the person's Bearer", { token: "eyLEGACY.anon-key.NOTREAL" }, DENIED],
    ["an unknown token (PostgREST 401)", { token: "g6pa-x.forged.NOTREAL" }, DENIED],
    ["another person's workspace", { body: { brand_id: WD } }, DENIED],
    ["a workspace id that is not a personal id", { body: { brand_id: "brand_shared" } }, DENIED],
    ["a login without POSTONA (own workspace)", { token: "g6pa-b.session-b.NOTREAL", body: { brand_id: WB } }, DENIED],
    ["the service ended", { g5: [`update public.service_entitlements set status = 'ended', ended_at = now() where user_id = '${A}' and service_key = 'x_autopost';`] }, DENIED],
    ["the service suspended", { g5: [`update public.service_entitlements set status = 'suspended' where user_id = '${A}' and service_key = 'x_autopost';`] }, DENIED],
    ["a shared workspace", { g5: [`insert into public.brand_memberships (brand_id, user_id, role) values ('${WA}', '${B}', 'member');`] }, DENIED],
    ["G5 down (the statement fails)", { g5: ["select 1 / 0;"] }, "503 POST_ASSIST_AUTH_UNAVAILABLE retry"],
  ];
  const got: string[] = [];
  let n = 0;
  for (const [label, o, expected] of cases) {
    const w = world();
    const r = await w.send({ key: `g6pa-deny-${String(++n).padStart(4, "0")}`, ...o });
    got.push(`${label}: ${code(r)}`);
    assert.equal(code(r), expected, label);
    assert.deepEqual([w.seen.g5.length, w.seen.provider.length, w.seen.other.length], [expected.startsWith("401") ? 0 : 1, 0, 0], label);
    assert.equal(w.seen.ledger.length, 0, `${label}: refused before any claim (${w.seen.ledger.map((s) => s.rpc).join(",")})`);
  }
  assert.equal(await ledgerState(), before, "nothing claimed, reserved, sent or charged");
  console.log(`G6-25 deny cases ${cases.length}: ${got.join(" | ")}`);
});

Deno.test({ name: "granted, revoked between the verdict and the send permit: a moved generation (end + restart), a suspension, an ended session or a shared workspace at the recheck -> 403 NOT_ENTITLED; the claim is closed, the reservation released, nothing sent or charged", ...opts }, async () => {
  const usage = await led("select count(*) from ai_ledger.usage_events");
  const cases: Array<[string, string]> = [
    ["generation moved (end + restart)", restart()],
    ["suspended", `update public.service_entitlements set status = 'suspended' where user_id = '${A}' and service_key = 'x_autopost';`],
    ["session ended", `update auth.sessions set not_after = now() - interval '1 minute' where id = '${SA}';`],
    ["shared workspace", `insert into public.brand_memberships (brand_id, user_id, role) values ('${WA}', '${B}', 'member');`],
  ];
  const got: string[] = [];
  let n = 0;
  for (const [label, at] of cases) {
    const w = world();
    const key = `g6pa-recheck-${String(++n).padStart(4, "0")}`;
    const r = await w.send({ key, g5: ["", at] });
    got.push(`${label}: ${code(r)}`);
    assert.equal(code(r), DENIED, label);
    assert.deepEqual([w.seen.g5.length, w.seen.provider.length], [2, 0], label);
    assert.ok(!w.seen.ledger.some((s) => s.rpc === "ai_calls_mark_sent_held"), `${label}: no send permit`);
  }
  assert.equal(await led("select count(*) from ai_ledger.usage_events"), usage, "nothing charged");
  assert.equal(await led(`select count(*) from ai_ledger.reservations where status not in ('settled', 'released')`), "0", "no reservation left open");
  console.log(`G6-25 recheck cases: ${got.join(" | ")}; ${await ledgerState()}`);
});

Deno.test({ name: "MVP_R1_EXECUTE_REVOKE.sql (the stop): ACL back to owner-only; a new request and a replay of a completed key are both refused 403 with nothing sent; granting again restores the person's path", ...opts }, async () => {
  const r = await runFile("MVP_R1_EXECUTE_REVOKE.sql");
  assert.ok(r.ok, r.error);
  assert.equal(await r1acl(), `${OWNER}=X/${OWNER}`);
  const before = await ledgerState();
  const w = world();
  const fresh = await w.send({ key: "g6pa-stopped-0001" });
  const replay = await w.send({ key: "g6pa-x-draft-0001", body: { mode: "draft", platform: "x", notes: "いちごタルト 週末限定" } });
  assert.deepEqual([code(fresh), code(replay)], [DENIED, DENIED], "the stop also hides stored results");
  assert.deepEqual([w.seen.provider.length, w.seen.ledger.length, await ledgerState()], [0, 0, before]);
  const again = await runFile("MVP_R1_EXECUTE_GRANT.sql");
  assert.ok(again.ok, again.error);
  const back = await world().send({ key: "g6pa-x-draft-0001", body: { mode: "draft", platform: "x", notes: "いちごタルト 週末限定" } });
  assert.equal(back.status, 200, "granted again: the stored answer");
  const stop = await runFile("MVP_R1_EXECUTE_REVOKE.sql");
  assert.ok(stop.ok, stop.error);
});

Deno.test({ name: "fail closed on the Edge configuration (real databases behind): a missing or invalid setting answers 503 and nobody is asked; a legacy (non sb_secret_) service key with the https Supabase URL is refused; an origin not on the list is 403", ...opts }, async () => {
  const before = await ledgerState();
  const cases: Array<[string, Record<string, string | undefined>, string?]> = [
    ["no feature", { [POST_ASSIST_EDGE_ENV.feature]: undefined }],
    ["feature with an extra key", { [POST_ASSIST_EDGE_ENV.feature]: JSON.stringify({ ...FEATURE, extra: 1 }) }],
    ["no service key", { [POST_ASSIST_EDGE_ENV.serviceKey]: undefined }],
    ["no publishable key", { [POST_ASSIST_EDGE_ENV.publishableKey]: undefined }],
    ["no Supabase URL", { [POST_ASSIST_EDGE_ENV.supabaseUrl]: undefined }],
    ["a legacy JWT-shaped service key", { [POST_ASSIST_EDGE_ENV.serviceKey]: "eyLEGACY.service.role" }],
    ["an origin list with *", { [POST_ASSIST_EDGE_ENV.allowedOrigins]: "*" }],
  ];
  for (const [label, override] of cases) {
    const w = world(override);
    const r = await w.send({ key: "g6pa-config-0001", origin: WEB });
    assert.equal(r.status, 503, `${label}: ${code(r)}`);
    assert.deepEqual([w.seen.g5.length, w.seen.ledger.length, w.seen.provider.length], [0, 0, 0], label);
  }
  const w = world();
  const foreign = await w.send({ key: "g6pa-config-0002", origin: "https://evil.example" });
  assert.equal(code(foreign), "403 POST_ASSIST_ORIGIN_REFUSED");
  assert.deepEqual([w.seen.g5.length, w.seen.ledger.length, w.seen.provider.length], [0, 0, 0]);
  assert.equal(await ledgerState(), before);
});
