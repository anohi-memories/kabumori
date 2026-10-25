// POSTONA X single manual post -- 006 live pre-send fence (M1-F1 / M1-F3) end to end on a disposable LOCAL PostgreSQL
// (run through single_post_live_fence_run.sh only):
//   Request -> postona-x-single-post http.ts -> Auth (fake GoTrue) -> real driver -> postona_resv_api -> 005 + 006 ->
//   generation-bound credential (fake G4) -> preflight -> x_publisher -> fake X -> record -> read-back on a SEPARATE
//   connection; app contract parser on the answer. Every case counts the fake X calls (0 = never sent, 1 = sent once).
// MOCK_ONLY: GoTrue answers, G4's verified predicate (PR #257's TEST DOUBLE), the generation-bound credential source and X
// itself; the refresh-state table is the deletion fixture's production-shaped one. A mock answer is never evidence of a
// real X post.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Client } from "jsr:@db/postgres@0.19.5";
import { createSinglePostHttpHandler } from "../../../functions/postona-x-single-post/http.ts";
import { createDriverConnect } from "../../../functions/_shared/postona_reservations/postgres_driver.ts";
import type { PgConnect } from "../../../functions/_shared/postona_reservations/postgres_db.ts";
import { singlePostRequest, singlePostResultOf } from "../../../functions/_shared/postona_reservations/single_post_contract.ts";
import { generationSourceViolations } from "../../../functions/_shared/postona_reservations/x_credential_generation.ts";

const API_URL = Deno.env.get("RESV_SP_API_URL")!;
const OWNER_URL = Deno.env.get("RESV_SP_OWNER_URL")!;
assert.ok(API_URL && OWNER_URL, "set by single_post_live_fence_run.sh");

const owner = async <T extends unknown[]>(sql: string, args: unknown[] = []) => {
  const c = new Client(OWNER_URL);
  await c.connect();
  try {
    return (await c.queryArray<T>({ text: sql, args })).rows;
  } finally {
    await c.end();
  }
};
const people = new Map((await owner<[number, string, string, string]>("select n, user_id::text, account, brand from t_ids.people")).map(([n, u, a, b]) => [Number(n), { user: u, account: a, brand: b }]));
const P = (n: number) => people.get(n)!;
await owner("update public.social_accounts set publish_enabled = true where id in (select account from t_ids.people where n between 61 and 78)");

// MOCK_ONLY GoTrue.
const b64 = (v: unknown) => btoa(JSON.stringify(v)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
const tokens = new Map<string, string>();
async function signIn(n: number) {
  const session = String((await owner<[string]>("insert into auth.sessions (user_id) values ($1::uuid) returning id::text", [P(n).user]))[0][0]);
  const token = `${b64({ alg: "HS256" })}.${b64({ sub: P(n).user, session_id: session, role: "authenticated" })}.sig`;
  tokens.set(token, P(n).user);
  return { token, session };
}
const fakeAuth = (_url: string, init?: RequestInit) => {
  const id = tokens.get(String(new Headers(init?.headers).get("Authorization")).replace(/^Bearer /u, ""));
  return Promise.resolve(id ? Response.json({ id, aud: "authenticated", role: "authenticated" }) : new Response("{}", { status: 401 }));
};
// MOCK_ONLY X.
type XCall = { token: string; text: string };
const xCalls: XCall[] = [];
let xScript: ((call: XCall) => Response | Promise<Response>) | null = null;
let nextId = 1790000000000000600n;
const fakeX = async (_url: string, init?: RequestInit) => {
  const call = { token: String(new Headers(init?.headers).get("authorization")).replace(/^Bearer /u, ""), text: JSON.parse(String(init?.body)).text as string };
  xCalls.push(call);
  if (xScript) return await xScript(call);
  nextId += 1n;
  return Response.json({ data: { id: String(nextId), text: call.text } }, { status: 201 });
};
// MOCK_ONLY G4 generation-bound source: the fake token + the database's generation read at the same moment; hooks let a
// case change the world right after the token was read (before the last preflight) or answer a stale generation.
const generationOf = async (account: string) => (await owner<[string | null]>("select postona_x_resv.x_credential_generation($1)", [account]))[0][0];
let afterTokenRead: ((account: string) => Promise<unknown>) | null = null;
let staleGeneration = false;
const credentials = {
  available: true,
  credentialFor: async (account: string) => {
    const generation = await generationOf(account);
    if (generation === null) return null;
    const credential = { token: `fake-x-token-${account}`, generation: staleGeneration ? "0".repeat(64) : generation };
    if (afterTokenRead) await afterTokenRead(account);
    return credential;
  },
};
const ENV = { get: (n: string) => ({ SUPABASE_URL: "https://project.example.invalid", SUPABASE_ANON_KEY: "publishable", POSTONA_RESV_DATABASE_URL: "unused" } as Record<string, string>)[n] };
const realConnect = createDriverConnect({ databaseUrl: API_URL, allowInsecureLoopback: true });
const handler = (o: { connect?: PgConnect } = {}) => createSinglePostHttpHandler(ENV, {
  enabled: true, authFetch: fakeAuth, connect: o.connect ?? realConnect, readConnect: realConnect, credentials, xFetch: fakeX,
});
const sha256 = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
async function post(token: string, account: string, text: string, requestId = crypto.randomUUID(), h = handler()) {
  const response = await h(new Request("http://localhost/functions/v1/postona-x-single-post", {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(singlePostRequest({ socialAccountId: account, clientRequestId: requestId, text, contentSha256: sha256(text) })),
  }));
  const body = await response.json();
  return { status: response.status, body, result: singlePostResultOf(response.status, body), requestId };
}
const stored = async (reservationId: string) => (await owner<[string, string | null, string | null, string | null, boolean | null]>(
  `select r.status, r.provider_post_id, r.outcome_code, b.transport, b.after_freeze from postona_x_resv.reservations r
     left join postona_x_resv.single_post_bindings b on b.reservation_id = r.id where r.id = $1::uuid`, [reservationId]))[0];
const singleRows = async () => Number((await owner<[bigint]>("select count(*) from postona_x_resv.reservations where draft_id like 'single:%'"))[0][0]);
/** A connection factory that runs `hook` once, right after the n-th COMMIT on it (counting from 1). */
function afterCommit(n: number, hook: () => Promise<unknown>): PgConnect {
  let commits = 0;
  return async () => {
    const s = await realConnect();
    return { release: s.release, client: { queryArray: async (q: { text: string; args?: unknown[] }) => {
      const out = await s.client.queryArray(q);
      if (q.text === "COMMIT" && ++commits === n) await hook();
      return out;
    } } };
  };
}
const ridOf = (body: unknown) => (body as { reservationId: string }).reservationId;
const codeOf = (body: unknown) => (body as { code?: string }).code;

Deno.test("E0 the fake G4 source meets the G1-G5 contract against the live database generation (MOCK_ONLY)", async () => {
  assert.deepEqual(await generationSourceViolations(credentials, { connected: [P(61).account, P(62).account], notConnected: ["sa_unknown_account"], databaseGeneration: generationOf }), []);
});

Deno.test("E1 happy path: authorized, live fence passed, sent once with the generation-checked token, stored, read back; marks simulated / not after freeze", async () => {
  const { token } = await signIn(61);
  const before = xCalls.length;
  const answer = await post(token, P(61).account, "M1-F1 ライブ確認の投稿");
  assert.equal(answer.result.kind, "sent", JSON.stringify(answer.body));
  if (answer.result.kind !== "sent") return;
  assert.deepEqual(xCalls.slice(before), [{ token: `fake-x-token-${P(61).account}`, text: "M1-F1 ライブ確認の投稿" }]);
  assert.deepEqual([answer.result.simulated, answer.result.afterFreeze], [true, false]);
  assert.deepEqual(await stored(answer.result.reservationId), ["published", answer.result.xPostId, "PUBLISHED", "simulated", false]);
  const again = await post(token, P(61).account, "M1-F1 ライブ確認の投稿", answer.requestId);
  assert.deepEqual(again.result, answer.result, "idempotent: the stored result");
  assert.equal(xCalls.length, before + 1, "never sent twice");
});

Deno.test("E2 refused at begin, nothing recorded, X 0: publish OFF, second workspace owner, refresh in progress, credential degraded, other person / other brand", async () => {
  const before = xCalls.length;
  const rows0 = await singleRows();
  const a = await signIn(62);
  await owner("update public.social_accounts set publish_enabled = false where id = $1", [P(62).account]);
  assert.deepEqual((await post(a.token, P(62).account, "スイッチOFF")).result, { kind: "refused", code: "POSTONA_RESV_PUBLISH_DISABLED", retryable: false });
  const b = await signIn(63);
  await owner("insert into public.brand_memberships (brand_id, user_id, role) values ($1, $2::uuid, 'owner')", [P(63).brand, P(64).user]);
  assert.deepEqual((await post(b.token, P(63).account, "共同所有者")).result, { kind: "refused", code: "POSTONA_RESV_SERVICE_NOT_ACTIVE", retryable: false });
  const c = await signIn(65);
  await owner("insert into public.x_account_refresh_state_v2 (social_account_id, status, generation) values ($1, 'refreshing', 1)", [P(65).account]);
  assert.deepEqual((await post(c.token, P(65).account, "更新中")).result, { kind: "unavailable", code: "POSTONA_RESV_SERVICE_BUSY" }, "503: retry later with the same id");
  await owner("update public.x_account_refresh_state_v2 set status = 'reauth_required' where social_account_id = $1", [P(65).account]);
  assert.deepEqual((await post(c.token, P(65).account, "再認可が必要")).result, { kind: "refused", code: "POSTONA_RESV_CREDENTIAL_DEGRADED", retryable: false });
  const d = await signIn(66);
  assert.deepEqual((await post(d.token, P(67).account, "他人の口座")).result, { kind: "refused", code: "POSTONA_RESV_ACCOUNT_NOT_FOUND", retryable: false });
  assert.equal(xCalls.length, before, "X never called");
  assert.equal(await singleRows(), rows0, "nothing recorded");
});

Deno.test("E3 a change after begin, before the X call: failed (never sent, X 0) -- revoke, publish OFF, owner change, entitlement ended, account deleting, signed out", async () => {
  const cases: [number, string, (n: number, session: string) => Promise<unknown>][] = [
    [68, "revoke", (n) => owner("insert into public.x_account_publish_authority (social_account_id, state, reason_code) values ($1, 'revoked', 'SOCIAL_MOBILE_DELETION')", [P(n).account])],
    [69, "publish OFF", (n) => owner("update public.social_accounts set publish_enabled = false where id = $1", [P(n).account])],
    [70, "second owner", (n) => owner("insert into public.brand_memberships (brand_id, user_id, role) values ($1, $2::uuid, 'owner')", [P(n).brand, P(78).user])],
    [71, "entitlement ended", (n) => owner("update public.service_entitlements set status = 'ended', ended_at = now() where user_id = $1::uuid and service_key = 'x_autopost'", [P(n).user])],
    [72, "account deleting", (n) => owner("update public.common_accounts set status = 'deleting' where user_id = $1::uuid", [P(n).user])],
    [73, "signed out", (_n, session) => owner("delete from auth.sessions where id = $1::uuid", [session])],
  ];
  for (const [n, label, change] of cases) {
    const s = await signIn(n);
    const before = xCalls.length;
    const answer = await post(s.token, P(n).account, `直前の変更 ${label}`, undefined, handler({ connect: afterCommit(1, () => change(n, s.session)) }));
    assert.equal(xCalls.length, before, `${label}: X never called`);
    if (label === "signed out") {
      // G3-34: the person-session gate (S2-2, asked first by caller()) refuses the dead session's check AND read-back before any
      // row is read: the dead session is told nothing, and the row stays claimed until its lease is fenced -- never sent.
      assert.deepEqual([answer.result.kind, codeOf(answer.body)], ["uncertain", "READBACK_UNAVAILABLE"], `${label}: ${JSON.stringify(answer.body)}`);
      assert.deepEqual((await stored(ridOf(answer.body))).slice(0, 3), ["claimed", null, null], label);
      continue;
    }
    assert.deepEqual([answer.result.kind, codeOf(answer.body)], ["failed", "NOT_PUBLISHABLE_AT_SEND"], `${label}: ${JSON.stringify(answer.body)}`);
    assert.deepEqual((await stored(ridOf(answer.body))).slice(0, 3), ["failed", null, "NOT_PUBLISHABLE_AT_SEND"], label);
  }
});

Deno.test("E4 credential generation: changed after the token was read (refresh / Vault swap) -> failed CREDENTIAL_CHANGED; a stale token generation -> failed CREDENTIAL_GENERATION_CHANGED; X 0", async () => {
  const a = await signIn(74);
  const before = xCalls.length;
  await owner("insert into public.x_account_refresh_state_v2 (social_account_id, status, generation) values ($1, 'idle', 1)", [P(74).account]);
  afterTokenRead = (account) => owner("update public.x_account_refresh_state_v2 set generation = generation + 1 where social_account_id = $1", [account]);
  let refreshed;
  try {
    refreshed = await post(a.token, P(74).account, "トークン取得後に更新");
  } finally {
    afterTokenRead = null;
  }
  assert.deepEqual([refreshed.result.kind, codeOf(refreshed.body)], ["failed", "CREDENTIAL_CHANGED"], JSON.stringify(refreshed.body));
  afterTokenRead = (account) => owner("update public.social_accounts set vault_access_token_secret_id = vault_refresh_token_secret_id, vault_refresh_token_secret_id = vault_access_token_secret_id where id = $1", [account]);
  let swapped;
  try {
    swapped = await post(a.token, P(74).account, "トークン取得後に差し替え");
  } finally {
    afterTokenRead = null;
  }
  assert.deepEqual([swapped.result.kind, codeOf(swapped.body)], ["failed", "CREDENTIAL_CHANGED"], JSON.stringify(swapped.body));
  staleGeneration = true;
  let stale;
  try {
    stale = await post(a.token, P(74).account, "古い世代のトークン");
  } finally {
    staleGeneration = false;
  }
  assert.deepEqual([stale.result.kind, codeOf(stale.body)], ["failed", "CREDENTIAL_GENERATION_CHANGED"], JSON.stringify(stale.body));
  assert.deepEqual((await stored(ridOf(stale.body))).slice(0, 4), ["failed", null, "CREDENTIAL_GENERATION_CHANGED", "simulated"]);
  assert.equal(xCalls.length, before, "X never called");
  // The same account sends again once its credential is settled (a new tap = a new request id).
  const settled = await post(a.token, P(74).account, "落ち着いてから");
  assert.equal(settled.result.kind, "sent", JSON.stringify(settled.body));
  assert.equal(xCalls.length, before + 1);
});

Deno.test("E5 frozen while X answers (in flight): recorded as sent, flagged afterFreeze, read back; X 1; a repeat never resends", async () => {
  const a = await signIn(75);
  xScript = async (call) => {
    await owner("update public.service_entitlements set status = 'ended', ended_at = now() where user_id = $1::uuid and service_key = 'x_autopost'", [P(75).user]);
    return Response.json({ data: { id: "1790000000000000999", text: call.text } }, { status: 201 });
  };
  const before = xCalls.length;
  let answer;
  try {
    answer = await post(a.token, P(75).account, "送信中に停止");
  } finally {
    xScript = null;
  }
  assert.equal(answer.result.kind, "sent", JSON.stringify(answer.body));
  if (answer.result.kind !== "sent") return;
  assert.deepEqual([answer.result.xPostId, answer.result.afterFreeze, answer.result.simulated], ["1790000000000000999", true, true]);
  assert.deepEqual(await stored(answer.result.reservationId), ["published", "1790000000000000999", "PUBLISHED", "simulated", true]);
  assert.equal(xCalls.length, before + 1);
  // The person can no longer start a post, and a repeat of this request reads the stored result (no second send).
  assert.equal((await post(a.token, P(75).account, "送信中に停止", answer.requestId)).result.kind, "refused");
  assert.equal(xCalls.length, before + 1);
});

Deno.test("E6 unknown X answer -> uncertain (never resent, X 1); double submit -> one X call", async () => {
  const a = await signIn(76);
  xScript = () => new Response(null, { status: 502 });
  const before = xCalls.length;
  let unknown;
  try {
    unknown = await post(a.token, P(76).account, "結果不明");
  } finally {
    xScript = null;
  }
  assert.equal(unknown.result.kind, "uncertain");
  assert.equal(unknown.result.kind === "uncertain" && unknown.result.afterFreeze, false);
  assert.equal((await post(a.token, P(76).account, "結果不明", unknown.requestId)).result.kind, "uncertain");
  assert.equal(xCalls.length, before + 1, "never resent");
  const b = await signIn(77);
  const id = crypto.randomUUID();
  const [x, y] = await Promise.all([post(b.token, P(77).account, "同時", id), post(b.token, P(77).account, "同時", id)]);
  assert.equal(xCalls.length, before + 2, "exactly one X call for the double submit");
  assert.ok([x.result.kind, y.result.kind].includes("sent"));
});
