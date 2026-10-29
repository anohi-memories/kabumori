// G4-50 (Issue #319): the Threads connect server chain, end to end, on a disposable local PostgreSQL 17.
//   Real: G4's Edge handler (createThreadsConnectHandler) -> H5's runtime (createThreadsRuntime) + H5's actor verifier
//         -> G4's owner bridge (createG4ThreadsOwnerBridge) -> @db/postgres -> the real SQL (PR #124, G4 binding entry
//         001 + custody proof 002 + G4-42 001 + G4-43 002, H5's claim SQL, G5's S2-3 / S2-2 lines).
//   Fake: GoTrue (getClaims / getUser from the test's own token table), Threads (code / long-lived / profile), the browser.
// Run only by postona_g4_threads_person_session_run.sh with G4T_BRIDGE_FLOW=1. LOCAL FAKE ONLY: no managed DB, no network.
import { Client } from "@db/postgres";
import { createThreadsConnectHandler } from "../functions/_shared/social/threads_connect_edge.ts";
import { createG4ThreadsOwnerBridge, type G4AuthProfile } from "../candidates/postona_g4_threads_personal_auth/owner_bridge.ts";
import { createThreadsRuntime } from "../candidates/postona_threads_auth_runtime/runtime.ts";
import { createOwnerTransport, type OwnerSqlClient } from "../candidates/postona_threads_auth_runtime/owner_transport.ts";
import { createActorVerifier } from "../candidates/postona_threads_auth_runtime/verified_actor.ts";

const host = Deno.env.get("G4B_PGHOST") ?? "", port = Number(Deno.env.get("G4B_PGPORT")), user = Deno.env.get("G4B_PGUSER") ?? "";
const database = Deno.env.get("G4B_DB") ?? "", nobindDb = Deno.env.get("G4B_DB_NOBIND") ?? "";
// G4-02 #3: the G5 profile the database runs ("full" = PR #303 owner epoch, "personal" = G5's MVP / g5pv); the bridge is pinned to it
const profile = (Deno.env.get("G4B_PROFILE") ?? "full") as G4AuthProfile;
if (!/^\/(private\/)?tmp\//.test(host) || !/^kb_tb_owner_\d+$/.test(user) || !/^kabumori_tb_\d+_bridge(mvp)?$/.test(database)) {
  throw new Error("LOCAL_FIXTURE_REQUIRED");
}
const CALLBACK = "https://app.postona.test/oauth/threads/callback";
const check = (ok: unknown, label: string) => {
  if (!ok) throw new Error(`FAIL ${label}`);
};

async function open(db = database): Promise<Client> {
  const c = new Client({ hostname: host, host_type: "socket", port, user, database: db, applicationName: "g4_bridge_flow", connection: { attempts: 1 } });
  await c.connect();
  return c;
}
async function sql<T>(text: string, args: unknown[] = [], db = database): Promise<T[]> {
  const c = await open(db);
  try {
    return (await c.queryObject<T>(text, args)).rows;
  } finally {
    await c.end();
  }
}

// ---- Fake GoTrue: a token is only what this table says it is. ------------------------------------------------
type Who = { sub: string; sid: string; anon: boolean };
const tokens = new Map<string, Who>();
let serial = 0;
function token(who: Who): string {
  const t = `g4b.${++serial}.${crypto.randomUUID()}`;
  tokens.set(t, who);
  return t;
}
const verify = createActorVerifier({
  getClaims(jwt: string) {
    const w = tokens.get(jwt);
    if (!w) return Promise.resolve({ data: null, error: true });
    return Promise.resolve({
      data: { claims: { sub: w.sub, session_id: w.sid, role: "authenticated", aud: "authenticated", is_anonymous: w.anon, exp: Math.floor(Date.now() / 1000) + 3600 } },
      error: null,
    });
  },
  getUser(jwt: string) {
    const w = tokens.get(jwt);
    return Promise.resolve(w ? { data: { user: { id: w.sub, is_anonymous: w.anon } }, error: null } : { data: { user: null }, error: true });
  },
} as Parameters<typeof createActorVerifier>[0]);

// ---- Fake Threads: the code names the Threads user it was issued to (a new code every time, as Threads). ----
let threadsCalls = 0;
const threadsFetch = (input: string, init?: RequestInit): Promise<Response> => {
  threadsCalls++;
  const url = new URL(input);
  const json = (text: string) => Promise.resolve(new Response(text, { status: 200, headers: { "content-type": "application/json" } }));
  if (url.href.startsWith("https://graph.threads.com/oauth/access_token")) {
    const code = new URLSearchParams(String(init?.body)).get("code") ?? "";
    const puid = /^code([0-9]+)x[0-9]+$/.exec(code)?.[1] ?? "";
    return json(`{"access_token":"short${puid}abcdefghijkl","token_type":"bearer","user_id":${puid}}`);
  }
  if (url.href.startsWith("https://graph.threads.net/access_token")) {
    const puid = (url.searchParams.get("access_token") ?? "").replace(/^short|abcdefghijkl$/g, "");
    return json(`{"access_token":"long${puid}abcdefghijklmnop","token_type":"bearer","expires_in":5184000}`);
  }
  if (url.href.startsWith("https://graph.threads.net/v1.0/me")) {
    const puid = (url.searchParams.get("access_token") ?? "").replace(/^long|abcdefghijklmnop$/g, "");
    return json(`{"id":"${puid}","username":"g4b_${puid.slice(-4)}"}`);
  }
  return Promise.resolve(new Response("{}", { status: 404 }));
};

type Bridge = ReturnType<typeof createG4ThreadsOwnerBridge>;
function handlerWith(bridge: Bridge) {
  const runtime = createThreadsRuntime({
    verify,
    bridge: bridge as never,
    settings: { appId: "1234567890", appSecret: "fake_app_secret_0123456789", redirectUri: CALLBACK },
    attestationKey: "fake_attestation_key_0123456789abcdef0123456789abcdef",
    fetch: threadsFetch,
  });
  return createThreadsConnectHandler(runtime, { registeredCallback: CALLBACK });
}
/** The bridge's connection, recording the last SQL error (fixture-only text) so each refusal shows its reason. */
let lastSqlError = "";
async function traced(db = database): Promise<OwnerSqlClient> {
  const c = await open(db);
  return {
    async queryObject<T>(text: string, args?: unknown[]) {
      try {
        return await c.queryObject<T>(text, args) as unknown as { rows: T[] };
      } catch (e) {
        lastSqlError = String((e as Error).message).split("\n")[0].slice(0, 160);
        throw e;
      }
    },
    end: () => c.end(),
  };
}
const g4 = (db = database) => createG4ThreadsOwnerBridge(() => traced(db), Date.now, profile);

async function post(handler: (r: Request) => Promise<Response>, bearer: string, body: Record<string, unknown>) {
  const r = await handler(new Request("http://edge.local/threads-oauth-connect-user", {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  return { status: r.status, body: await r.json() as Record<string, unknown> };
}
/** start -> the browser (fake approval as the Threads user puid) -> callback with `callbackBearer` (default: the same). */
async function connect(handler: (r: Request) => Promise<Response>, bearer: string, puid: string,
  opts: { callbackBearer?: string; between?: () => Promise<void> } = {}) {
  const started = await post(handler, bearer, { action: "start" });
  if (started.status !== 200) return { stage: "start", ...started };
  const state = new URL(String(started.body.authorization_url)).searchParams.get("state");
  await opts.between?.();
  const done = await post(handler, opts.callbackBearer ?? bearer, { action: "callback", callback_url: `${CALLBACK}?code=code${puid}x${++serial}&state=${state}#_` });
  return { stage: "callback", ...done };
}

// ---- People ----------------------------------------------------------------------------------------------------
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sidOf = (n: number, k = 1) => `${String(k).padStart(8, "0")}-0000-4000-9000-${String(n).padStart(12, "0")}`;
async function person(n: number, start: boolean, db = database) {
  const c = await open(db);
  try {
    await c.queryObject("begin");
    await c.queryObject("select public.fixture_login($1::uuid)", [uid(n)]);
    await c.queryObject("insert into auth.sessions(id,user_id) values ($1::uuid,$2::uuid)", [sidOf(n), uid(n)]);
    if (start) {
      await c.queryObject("select set_config('request.jwt.claims',$1,true)", [JSON.stringify({ sub: uid(n), role: "authenticated", session_id: sidOf(n), is_anonymous: false })]);
      await c.queryObject("select public.start_x_autopost_service()");
    }
    await c.queryObject("commit");
  } finally {
    await c.end();
  }
  return token({ sub: uid(n), sid: sidOf(n), anon: false });
}
async function newSession(n: number, k: number) {
  await sql("insert into auth.sessions(id,user_id) values ($1::uuid,$2::uuid)", [sidOf(n, k), uid(n)]);
  return token({ sub: uid(n), sid: sidOf(n, k), anon: false });
}
const binding = async (n: number) =>
  (await sql<{ threads_user_id: string; oauth_state_id: string }>(
    `select b.threads_user_id, b.oauth_state_id::text from postona_threads_binding.bindings b
       join public.social_accounts sa on sa.id=b.social_account_id where sa.brand_id=public.social_mobile_account_deletion_workspace($1::uuid)`,
    [uid(n)],
  ))[0] ?? null;
const states = async (n: number) => Number((await sql<{ n: bigint }>(
  "select count(*) as n from public.social_account_oauth_states where initiated_by_user_id=$1::uuid", [uid(n)]))[0].n);

/** A test-only rewrite of the bridge's SQL, to prove each G4 step is load-bearing (negative controls). */
function rewriting(db: string, rewrite: (text: string, args: unknown[]) => [string, unknown[]] | null) {
  return createG4ThreadsOwnerBridge(async () => {
    const c = await traced(db);
    const proxy: OwnerSqlClient = {
      queryObject<T>(text: string, args?: unknown[]) {
        const r = rewrite(text, args ?? []);
        if (!r) return Promise.resolve({ rows: [] as T[] });
        return c.queryObject<T>(r[0], r[1]) as unknown as Promise<{ rows: T[] }>;
      },
      end: () => c.end(),
    };
    return proxy;
  }, Date.now, profile);
}

/** G4-02 #3: forged SQL claims for the transactions AFTER the person left for Threads (claim + complete); begin is genuine. */
type Forge = { on: boolean; json?: (claims: Record<string, unknown>) => Record<string, unknown>; text?: (t: string) => string; args?: (a: unknown[]) => unknown[] };
function forging(db: string, forge: Forge) {
  return rewriting(db, (t, a) => {
    if (!forge.on) return [t, a];
    if (t.includes("'request.jwt.claims'") && forge.json) return [t, [JSON.stringify(forge.json(JSON.parse(String(a[0]))))]];
    if (t.includes("request.jwt.claim.sub")) return [forge.text ? forge.text(t) : t, forge.args ? forge.args(a) : a];
    return [t, a];
  });
}

Deno.test(`G4-50 / G4-02 #3 Threads connect through G4's owner bridge (PG17, fake GoTrue/Threads, G5 profile ${profile})`, async () => {
  const h = handlerWith(g4());
  const tA = await person(4501, true);

  // 1. Connect.
  const c1 = await connect(h, tA, "17841400000004501");
  check(c1.status === 200 && c1.body.status === "connected" && c1.body.publish_enabled === false, `1 connect ${JSON.stringify(c1)} sql=${lastSqlError}`);
  const b1 = await binding(4501);
  check(b1?.threads_user_id === "17841400000004501", "1 bound to the Threads user");
  check(Number((await sql<{ n: bigint }>("select count(*) as n from postona_threads_binding.state_generations where initiated_by=$1::uuid and attested_at is not null", [uid(4501)]))[0].n) === 1, "1 generation recorded at begin, attested at complete");
  check((await sql<{ s: string }>("select status as s from postona_threads_runtime.attempts where user_id=$1::uuid", [uid(4501)]))[0].s === "complete", "1 attempt complete");
  console.log("ok 1 connect: binding + generation + custody in one transaction");

  // 2. Reconnect (same Threads user): a new state replaces the binding.
  const c2 = await connect(h, tA, "17841400000004501");
  const b2 = await binding(4501);
  check(c2.status === 200 && b2 !== null && b2.oauth_state_id !== b1!.oauth_state_id, `2 reconnect ${JSON.stringify(c2)}`);
  console.log("ok 2 reconnect: binding replaced by the new state");

  // 3. Token refresh in the SAME session (another JWT string) still completes.
  const refreshed = token({ sub: uid(4501), sid: sidOf(4501), anon: false });
  const c3 = await connect(h, tA, "17841400000004501", { callbackBearer: refreshed });
  check(c3.status === 200 && c3.body.status === "connected", `3 refresh ${JSON.stringify(c3)}`);
  console.log("ok 3 same-session token refresh completes");

  // 4. A -> B -> A: the callback arrives in a NEW session of A. Refused before Threads is called; binding unchanged.
  const before4 = await binding(4501);
  lastSqlError = "";
  const tA2 = await newSession(4501, 2);
  const calls4 = threadsCalls;
  const c4 = await connect(h, tA, "17841400000004501", { callbackBearer: tA2 });
  check(c4.status === 409 && c4.body.error === "CALLBACK_REFUSED" && threadsCalls === calls4, `4 session switch ${JSON.stringify(c4)}`);
  check((await binding(4501))?.oauth_state_id === before4?.oauth_state_id, "4 binding unchanged");
  console.log(`ok 4 A->B->A new session refused before the code is spent (sql: ${lastSqlError})`);
  lastSqlError = "";

  // 5. Anonymous: refused at start, nothing written.
  const tAnon = token({ sub: uid(4502), sid: sidOf(4502), anon: true });
  const c5 = await post(h, tAnon, { action: "start" });
  check(c5.status === 409 && c5.body.error === "START_REFUSED" && await states(4502) === 0, `5 anonymous ${JSON.stringify(c5)}`);
  console.log(`ok 5 anonymous refused at start, no state (sql: ${lastSqlError || "none, refused by the actor verifier"})`);
  lastSqlError = "";

  // 6. Signed in but POSTONA not started: refused at start, nothing written.
  const tC = await person(4503, false);
  const c6 = await post(h, tC, { action: "start" });
  check(c6.status === 409 && c6.body.error === "START_REFUSED" && await states(4503) === 0, `6 not started ${JSON.stringify(c6)}`);
  console.log(`ok 6 service not started refused at start, no state (sql: ${lastSqlError})`);
  lastSqlError = "";

  // 7. ABA: the service ended and restarted between start and callback (lifecycle_version moved). Refused; no binding.
  const tF = await person(4506, true);
  const c7 = await connect(h, tF, "17841400000004506", {
    between: async () => { await sql("update public.common_accounts set lifecycle_version = lifecycle_version + 2 where user_id=$1::uuid", [uid(4506)]); }, // SYNTHETIC end + restart
  });
  check(c7.status === 409 && c7.body.error === "COMPLETE_OUTCOME_UNKNOWN" && await binding(4506) === null, `7 ABA ${JSON.stringify(c7)}`);
  check(Number((await sql<{ n: bigint }>("select count(*) as n from public.social_account_oauth_states where initiated_by_user_id=$1::uuid and consumed_at is null", [uid(4506)]))[0].n) === 1, "7 state not consumed (all undone)");
  check(lastSqlError === "THREADS_BINDING_SERVICE_GENERATION_CHANGED", `7 reason ${lastSqlError}`);
  console.log(`ok 7 ABA (service ended + restarted) refused, nothing bound (sql: ${lastSqlError})`);
  lastSqlError = "";

  // 8. Fail-closed where G4's entry is not installed: refused at start, nothing written.
  if (nobindDb) {
    const tN = await person(4508, true, nobindDb);
    const c8 = await post(handlerWith(g4(nobindDb)), tN, { action: "start" });
    const n8 = Number((await sql<{ n: bigint }>("select count(*) as n from public.social_account_oauth_states", [], nobindDb))[0].n);
    check(c8.status === 409 && c8.body.error === "START_REFUSED" && n8 === 0, `8 no entry ${JSON.stringify(c8)}`);
    console.log(`ok 8 without G4's binding entry: start refused (fail-closed; sql: ${lastSqlError || "none, owner check refused"})`);
  }

  // 9. Negative controls: each G4 step is load-bearing. A fresh person per control; each must FAIL to connect.
  const controls: Array<[string, Bridge | ReturnType<typeof createOwnerTransport>]> = [
    ["no_is_anonymous_claim", rewriting(database, (t, a) =>
      t.includes("request.jwt.claims")
        ? [t, [JSON.stringify((({ is_anonymous: _x, ...rest }) => rest)(JSON.parse(String(a[0]))))]]
        : [t.replace(", set_config('request.jwt.claim.is_anonymous','false',true) as verified_anonymous", ""), a])],
    ["skip_record_state_generation", rewriting(database, (t, a) => t.includes("record_state_generation") ? null : [t, a])],
    ["complete_pr124_directly", rewriting(database, (t, a) =>
      [t.replace("postona_threads_binding.complete_and_attest_binding", "public.complete_social_mobile_threads_oauth_connection"), a])],
    ["h5_owner_transport_as_is", createOwnerTransport(() => traced())],
  ];
  let n = 4520;
  for (const [name, bridge] of controls) {
    const t = await person(++n, true);
    lastSqlError = "";
    const r = await connect(handlerWith(bridge as Bridge), t, `178414000000${n}`);
    check(r.status !== 200 && await binding(n) === null, `9 control ${name} connected: ${JSON.stringify(r)}`);
    console.log(`ok 9 control ${name}: refused at ${r.stage} (${r.status} ${r.body.error}; sql: ${lastSqlError})`);
  }

  // 10. G4-02 #3 pre-adoption: the service ends mid-flow; forged claims after the person left for Threads; what an ended
  // service leaves behind. Fresh people; every case must end with nothing bound.
  {
    const t = await person(4541, true);
    lastSqlError = "";
    const r = await connect(handlerWith(g4()), t, "17841400000004541", {
      between: async () => { await sql("update public.service_entitlements set status='ended', ended_at=now() where user_id=$1::uuid and service_key='x_autopost'", [uid(4541)]); }, // SYNTHETIC end
    });
    check(r.status !== 200 && await binding(4541) === null, `10a service ended mid-flow connected: ${JSON.stringify(r)}`);
    // refused before the code exchange (H5's claim runs T13): the code is never spent
    check(r.stage === "callback" && r.body.error === "CALLBACK_REFUSED" && lastSqlError === "SERVICE_NOT_ACTIVE", `10a reason ${JSON.stringify(r)} ${lastSqlError}`);
    console.log(`measured 10a service ended while at Threads: refused at ${r.stage} (${r.status} ${r.body.error}; sql: ${lastSqlError})`);
  }
  await person(4549, true); // a second, started person whose ids are borrowed below
  // measured refusal per profile: [error, sql]; G5's MVP T13 refuses a non-false is_anonymous already in H5's claim
  const forgeries: Array<[string, Omit<Forge, "on">, Record<G4AuthProfile, [string, string]>]> = [
    ["sub_of_another_person", { json: (c) => ({ ...c, sub: uid(4549) }), args: (a) => [uid(4549), a[1]] },
      { full: ["CALLBACK_REFUSED", "H5_ACTOR_INVALID"], personal: ["CALLBACK_REFUSED", "H5_ACTOR_INVALID"] }],
    ["session_of_another_person", { json: (c) => ({ ...c, session_id: sidOf(4549) }), args: (a) => [a[0], sidOf(4549)] },
      { full: ["CALLBACK_REFUSED", "ACCOUNT_LIFECYCLE_AUTH_REQUIRED"], personal: ["CALLBACK_REFUSED", "ACCOUNT_LIFECYCLE_AUTH_REQUIRED"] }],
    ["is_anonymous_true", { json: (c) => ({ ...c, is_anonymous: true }), text: (x) => x.replace("'request.jwt.claim.is_anonymous','false'", "'request.jwt.claim.is_anonymous','true'") },
      { full: ["COMPLETE_OUTCOME_UNKNOWN", "THREADS_SESSION_NOT_ACTIVE"], personal: ["CALLBACK_REFUSED", "ACCOUNT_LIFECYCLE_AUTH_REQUIRED"] }],
    ["role_anon", { json: (c) => ({ ...c, role: "anon" }), text: (x) => x.replace("'request.jwt.claim.role','authenticated'", "'request.jwt.claim.role','anon'") },
      { full: ["CALLBACK_REFUSED", "ACCOUNT_LIFECYCLE_AUTH_REQUIRED"], personal: ["CALLBACK_REFUSED", "ACCOUNT_LIFECYCLE_AUTH_REQUIRED"] }],
  ];
  let m = 4550;
  for (const [name, f, expected] of forgeries) {
    const forge: Forge = { on: false, ...f };
    const t = await person(++m, true);
    lastSqlError = "";
    const r = await connect(handlerWith(forging(database, forge)), t, `178414000000${m}`, { between: () => { forge.on = true; return Promise.resolve(); } });
    check(r.status !== 200 && await binding(m) === null, `10b forged ${name} connected: ${JSON.stringify(r)}`);
    check(r.body.error === expected[profile][0] && lastSqlError === expected[profile][1], `10b ${name} reason ${JSON.stringify(r)} ${lastSqlError}`);
    console.log(`measured 10b forged ${name} after begin: refused at ${r.stage} (${r.status} ${r.body.error}; sql: ${lastSqlError})`);
  }
  {
    // a connected person's service ends: no new connect starts; in the personal profile G5's MV no longer allows the
    // generation the binding was made under (what a G3 consumer must check with its own stored generation)
    const t = await person(4561, true);
    const ok = await connect(handlerWith(g4()), t, "17841400000004561");
    check(ok.status === 200 && await binding(4561) !== null, `10c connect ${JSON.stringify(ok)}`);
    await sql("update public.service_entitlements set status='ended', ended_at=now() where user_id=$1::uuid and service_key='x_autopost'", [uid(4561)]); // SYNTHETIC end
    lastSqlError = "";
    const again = await post(handlerWith(g4()), t, { action: "start" });
    check(again.status === 409 && again.body.error === "START_REFUSED" && lastSqlError === "SERVICE_NOT_ACTIVE", `10c reconnect after end ${JSON.stringify(again)} ${lastSqlError}`);
    let mv = "n/a (full profile: no MV)";
    if (profile === "personal") {
      mv = (await sql<{ v: string }>(
        `select private.postona_personal_worker_verdict(b.bound_by, b.brand_id, 'x_autopost', b.lifecycle_version) as v
           from postona_threads_binding.bindings b where b.bound_by=$1::uuid`, [uid(4561)]))[0].v;
      check(mv === "SERVICE_NOT_ACTIVE", `10c MV for the ended generation: ${mv}`);
    }
    console.log(`measured 10c after the service ended: reconnect start refused (sql: ${lastSqlError}); MV for the binding's generation: ${mv}`);
  }
  console.log("G4B_THREADS_BRIDGE_FLOW_PASS");
});
