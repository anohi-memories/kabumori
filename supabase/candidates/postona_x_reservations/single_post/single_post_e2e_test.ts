// POSTONA X single manual post (M1) end to end on a disposable LOCAL PostgreSQL (run through single_post_run.sh only):
//   Request -> postona-x-single-post http.ts -> Auth (fake GoTrue) -> real driver -> postona_resv_api (claims with the
//   session id) -> 005 + 006: T13 + owner / G5 / G4 / authority / publish switch / F5 live workspace state -> the
//   generation-bound credential -> preflight -> x_publisher -> fake X -> record -> read-back on a SEPARATE connection;
//   app contract parser on the answer.
// MOCK_ONLY: GoTrue answers, G4's verified predicate (PR #257's TEST DOUBLE over what the guarded onboarding recorded), the
// X credential source and X itself. Real Supabase Auth, G4, tokens and X are NOT proven here; a mock answer is never
// evidence of a real X post.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Client } from "jsr:@db/postgres@0.19.5";
import { createSinglePostHttpHandler } from "../../../functions/postona-x-single-post/http.ts";
import { createDriverConnect } from "../../../functions/_shared/postona_reservations/postgres_driver.ts";
import type { PgConnect } from "../../../functions/_shared/postona_reservations/postgres_db.ts";
import { singlePostRequest, singlePostResultOf } from "../../../functions/_shared/postona_reservations/single_post_contract.ts";

const API_URL = Deno.env.get("RESV_SP_API_URL")!;
const OWNER_URL = Deno.env.get("RESV_SP_OWNER_URL")!;
assert.ok(API_URL && OWNER_URL, "set by single_post_run.sh");

const owner = async <T extends unknown[]>(sql: string, args: unknown[] = []) => {
  const c = new Client(OWNER_URL);
  await c.connect();
  try {
    return (await c.queryArray<T>({ text: sql, args })).rows;
  } finally {
    await c.end();
  }
};
const people = new Map((await owner<[number, string, string]>("select n, user_id::text, account from t_ids.people")).map(([n, u, a]) => [Number(n), { user: u, account: a }]));
const P = (n: number) => people.get(n)!;

// MOCK_ONLY GoTrue: a token is "<user>.<session>"-shaped JWT; revoked tokens answer 401.
const b64 = (v: unknown) => btoa(JSON.stringify(v)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
const tokens = new Map<string, string>();
const revoked = new Set<string>();
async function signIn(n: number) {
  const session = String((await owner<[string]>("insert into auth.sessions (user_id) values ($1::uuid) returning id::text", [P(n).user]))[0][0]);
  const token = `${b64({ alg: "HS256" })}.${b64({ sub: P(n).user, session_id: session, role: "authenticated" })}.sig`;
  tokens.set(token, P(n).user);
  return { token, session };
}
const fakeAuth = (_url: string, init?: RequestInit) => {
  const token = String(new Headers(init?.headers).get("Authorization")).replace(/^Bearer /u, "");
  const id = tokens.get(token);
  return Promise.resolve(id && !revoked.has(token) ? Response.json({ id, aud: "authenticated", role: "authenticated" }) : new Response("{}", { status: 401 }));
};
// MOCK_ONLY X + credential source.
type XCall = { token: string; text: string };
const xCalls: XCall[] = [];
let xScript: ((call: XCall) => Response | Promise<Response>) | null = null;
let nextId = 1790000000000000500n;
const fakeX = async (_url: string, init?: RequestInit) => {
  const call = { token: String(new Headers(init?.headers).get("authorization")).replace(/^Bearer /u, ""), text: JSON.parse(String(init?.body)).text as string };
  xCalls.push(call);
  if (xScript) return await xScript(call);
  nextId += 1n;
  return Response.json({ data: { id: String(nextId), text: call.text } }, { status: 201 });
};
let credentialOverride: ((account: string) => string | null) | null = null;
// MOCK_ONLY G4 source: the fake token plus the database's generation read at the same moment (the G3 contract).
const credentials = {
  available: true,
  credentialFor: async (account: string) => {
    const token = credentialOverride ? credentialOverride(account) : `fake-x-token-${account}`;
    if (token === null) return null;
    const generation = String((await owner<[string]>("select postona_x_resv.x_credential_generation($1)", [account]))[0][0]);
    return { token, generation };
  },
};
const ENV = { get: (n: string) => ({ SUPABASE_URL: "https://project.example.invalid", SUPABASE_ANON_KEY: "publishable", POSTONA_RESV_DATABASE_URL: "unused" } as Record<string, string>)[n] };
const realConnect = createDriverConnect({ databaseUrl: API_URL, allowInsecureLoopback: true });
const handler = (o: { connect?: PgConnect; readConnect?: PgConnect } = {}) => createSinglePostHttpHandler(ENV, {
  enabled: true, authFetch: fakeAuth, connect: o.connect ?? realConnect, readConnect: o.readConnect ?? realConnect, credentials, xFetch: fakeX,
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
const row = async (reservationId: string) => (await owner<[string, string | null, string | null]>(
  "select status, provider_post_id, outcome_code from postona_x_resv.reservations where id = $1::uuid", [reservationId]))[0];
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

Deno.test("M1: one synthetic text post -- authorized, sent once with the account's own token, stored, read back on another connection", async () => {
  const { token } = await signIn(61);
  const before = xCalls.length;
  const answer = await post(token, P(61).account, "はじめての手入力投稿 #POSTONA");
  assert.equal(answer.result.kind, "sent", JSON.stringify(answer.body));
  if (answer.result.kind !== "sent") return;
  assert.deepEqual(xCalls.slice(before), [{ token: `fake-x-token-${P(61).account}`, text: "はじめての手入力投稿 #POSTONA" }]);
  assert.deepEqual(await row(answer.result.reservationId), ["published", answer.result.xPostId, "PUBLISHED"]);
  assert.deepEqual([answer.result.simulated, answer.result.afterFreeze], [true, false], "a fake X result is marked simulated");
  // The same request again: the stored result, no second send.
  const again = await post(token, P(61).account, "はじめての手入力投稿 #POSTONA", answer.requestId);
  assert.deepEqual(again.result, answer.result);
  assert.equal(xCalls.length, before + 1);
});

Deno.test("double submit at the same moment: exactly one X call; the other is pending (in progress) or the same sent result", async () => {
  const { token } = await signIn(62);
  const id = crypto.randomUUID();
  const before = xCalls.length;
  const [a, b] = await Promise.all([post(token, P(62).account, "連打", id), post(token, P(62).account, "連打", id)]);
  assert.equal(xCalls.length, before + 1);
  assert.deepEqual([a.result.kind, b.result.kind].sort().join(","), a.result.kind === b.result.kind ? "sent,sent" : "pending,sent");
});

Deno.test("X answers unknown / network error -> uncertain, never resent; X refuses -> failed", async () => {
  const { token } = await signIn(63);
  for (const [script, kind] of [[() => new Response(null, { status: 503 }), "uncertain"], [() => Promise.reject(new TypeError("reset")), "uncertain"], [() => Response.json({}, { status: 403 }), "failed"]] as const) {
    xScript = script as () => Response | Promise<Response>;
    const before = xCalls.length;
    let first;
    try {
      first = await post(token, P(63).account, `結果 ${kind} ${xCalls.length}`);
    } finally {
      xScript = null;
    }
    assert.equal(first.result.kind, kind, JSON.stringify(first.body));
    const repeat = await post(token, P(63).account, `結果 ${kind} ${before}`, first.requestId);
    assert.equal(repeat.result.kind, kind);
    assert.equal(xCalls.length, before + 1, "sent once, never again");
  }
});

Deno.test("X said published but the result could not be recorded (COMMIT lost): uncertain; repeats are pending, then uncertain; never resent", async () => {
  const { token } = await signIn(64);
  let commits = 0;
  const lossy: PgConnect = async () => {
    const s = await realConnect();
    return { release: s.release, client: { queryArray: async (q: { text: string; args?: unknown[] }) => {
      if (q.text === "COMMIT" && ++commits === 3) { await s.client.queryArray({ text: "ROLLBACK" }); throw new Error("connection reset at COMMIT"); }
      return await s.client.queryArray(q);
    } } };
  };
  const before = xCalls.length;
  const first = await post(token, P(64).account, "記録できない成功", undefined, handler({ connect: lossy }));
  assert.equal(first.result.kind, "uncertain");
  assert.equal((first.body as { code: string }).code, "RESULT_NOT_RECORDED");
  assert.equal(xCalls.length, before + 1);
  const rid = (first.body as { reservationId: string }).reservationId;
  assert.equal((await row(rid))[0], "claimed", "nothing recorded as published");
  assert.equal((await post(token, P(64).account, "記録できない成功", first.requestId)).result.kind, "pending");
  await owner("update postona_x_resv.reservations set lease_expires_at = now() - interval '1 second' where id = $1::uuid", [rid]);
  assert.equal((await post(token, P(64).account, "記録できない成功", first.requestId)).result.kind, "uncertain");
  assert.equal(xCalls.length, before + 1, "never resent");
});

Deno.test("the read-back differs from what X answered: uncertain (never reported as sent)", async () => {
  const { token } = await signIn(65);
  let rid = "";
  const tampering: PgConnect = async () => {
    const s = await realConnect();
    return { release: s.release, client: { queryArray: async (q: { text: string; args?: unknown[] }) => {
      if (q.text.includes("post_now_readback")) await owner("update postona_x_resv.reservations set provider_post_id = '1790000000000000001' where id = $1::uuid", [rid = String(q.args?.[0])]);
      return await s.client.queryArray(q);
    } } };
  };
  const answer = await post(token, P(65).account, "照合", undefined, handler({ readConnect: tampering }));
  assert.equal(answer.result.kind, "uncertain");
  assert.equal((answer.body as { code: string }).code, "READBACK_MISMATCH");
  assert.ok(rid);
});

Deno.test("refused before anything is recorded or sent: service ended, signed out, other person, not verified, authority revoked, no token", async () => {
  const before = xCalls.length;
  const count = async () => Number((await owner<[bigint]>("select count(*) from postona_x_resv.reservations where draft_id like 'single:%'"))[0][0]);
  const rows0 = await count();
  const a = await signIn(66);
  await owner("update public.service_entitlements set status = 'ended', ended_at = now() where user_id = $1::uuid and service_key = 'x_autopost'", [P(66).user]);
  assert.deepEqual((await post(a.token, P(66).account, "終了後")).result, { kind: "refused", code: "POSTONA_RESV_SERVICE_NOT_ACTIVE", retryable: false });
  const b = await signIn(67);
  await owner("delete from auth.sessions where id = $1::uuid", [b.session]);
  assert.deepEqual((await post(b.token, P(67).account, "サインアウト後")).result, { kind: "refused", code: "POSTONA_RESV_AUTH_REQUIRED", retryable: true });
  const c = await signIn(68);
  assert.deepEqual((await post(c.token, P(69).account, "他人の口座")).result, { kind: "refused", code: "POSTONA_RESV_ACCOUNT_NOT_FOUND", retryable: false });
  await owner("update public.social_accounts set last_connection_error_code = 'X_ACCOUNT_ALREADY_CONNECTED' where id = $1", [P(68).account]);
  assert.deepEqual((await post(c.token, P(68).account, "未確認")).result, { kind: "refused", code: "POSTONA_RESV_X_ACCOUNT_NOT_VERIFIED", retryable: false });
  const d = await signIn(69);
  await owner("insert into public.x_account_publish_authority (social_account_id, state, reason_code) values ($1, 'revoked', 'SOCIAL_MOBILE_DELETION')", [P(69).account]);
  assert.deepEqual((await post(d.token, P(69).account, "停止後")).result, { kind: "refused", code: "POSTONA_RESV_PUBLISH_AUTHORITY_REVOKED", retryable: false });
  revoked.add(d.token);
  assert.deepEqual((await post(d.token, P(69).account, "期限切れトークン")).result, { kind: "refused", code: "AUTH_REQUIRED", retryable: true });
  assert.equal(xCalls.length, before, "X never called");
  assert.equal(await count(), rows0, "nothing recorded");
});

Deno.test("the service ends between begin and the X call: failed (not sent); the lease runs out before the call: pending, a repeat sends once", async () => {
  const a = await signIn(70);
  const before = xCalls.length;
  const ended = await post(a.token, P(70).account, "直前に終了", undefined, handler({ connect: afterCommit(1, () =>
    owner("update public.service_entitlements set status = 'ended', ended_at = now() where user_id = $1::uuid and service_key = 'x_autopost'", [P(70).user])) }));
  assert.equal(ended.result.kind, "failed", JSON.stringify(ended.body));
  assert.equal((ended.body as { code: string }).code, "NOT_PUBLISHABLE_AT_SEND");
  assert.equal(xCalls.length, before);
  // ... and the person signs out between begin and the X call: refused at the check (T13 re-checks the session), not sent.
  const s = await signIn(75);
  const signedOut = await post(s.token, P(75).account, "直前にサインアウト", undefined, handler({ connect: afterCommit(1, () =>
    owner("delete from auth.sessions where id = $1::uuid", [s.session])) }));
  assert.equal(signedOut.result.kind, "failed", JSON.stringify(signedOut.body));
  assert.equal(xCalls.length, before);
  const b = await signIn(71);
  let rid = "";
  const lapse = afterCommit(1, async () => {
    rid = String((await owner<[string]>("select id::text from postona_x_resv.reservations where user_id = $1::uuid and status = 'claimed' order by created_at desc limit 1", [P(71).user]))[0][0]);
    await owner("update postona_x_resv.reservations set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1::uuid", [rid]);
  });
  const lapsed = await post(b.token, P(71).account, "期限切れ", undefined, handler({ connect: lapse }));
  assert.equal(lapsed.result.kind, "pending", JSON.stringify(lapsed.body));
  assert.equal(xCalls.length, before, "not sent");
  const retry = await post(b.token, P(71).account, "期限切れ", lapsed.requestId);
  assert.equal(retry.result.kind, "sent");
  assert.equal(xCalls.length, before + 1);
});

Deno.test("the lease runs out while X answers: uncertain (lease_lost), never resent; the token is missing: failed, never sent", async () => {
  const a = await signIn(72);
  let rid = "";
  xScript = async (call) => {
    rid = String((await owner<[string]>("select id::text from postona_x_resv.reservations where user_id = $1::uuid and status = 'claimed'", [P(72).user]))[0][0]);
    await owner("update postona_x_resv.reservations set lease_expires_at = clock_timestamp() - interval '1 second' where id = $1::uuid", [rid]);
    return Response.json({ data: { id: "1790000000000000777", text: call.text } }, { status: 201 });
  };
  let late;
  try {
    late = await post(a.token, P(72).account, "遅い応答");
  } finally {
    xScript = null;
  }
  assert.equal(late.result.kind, "uncertain");
  assert.equal((await row(rid))[0], "uncertain");
  const b = await signIn(73);
  credentialOverride = () => null;
  const before = xCalls.length;
  let noToken;
  try {
    noToken = await post(b.token, P(73).account, "トークンなし");
  } finally {
    credentialOverride = null;
  }
  assert.deepEqual([noToken.result.kind, (noToken.body as { code: string }).code], ["failed", "X_CREDENTIALS_UNAVAILABLE"]);
  assert.equal(xCalls.length, before);
});

Deno.test("nothing is logged; the answer holds no token and no text; the delivery worker / old queues are not used", async () => {
  const { token } = await signIn(74);
  const original = { log: console.log, error: console.error, warn: console.warn, info: console.info, debug: console.debug };
  let writes = 0;
  for (const key of Object.keys(original) as (keyof typeof original)[]) console[key] = () => { writes += 1; };
  let answer;
  try {
    answer = await post(token, P(74).account, "ログに残らない本文");
  } finally {
    Object.assign(console, original);
  }
  assert.equal(writes, 0);
  assert.ok(!JSON.stringify(answer.body).includes(token) && !JSON.stringify(answer.body).includes("ログに残らない本文"));
  for (const file of ["../../../functions/_shared/postona_reservations/single_post.ts", "../../../functions/_shared/postona_reservations/single_post_db.ts", "../../../functions/postona-x-single-post/http.ts"]) {
    const source = await Deno.readTextFile(new URL(file, import.meta.url));
    for (const banned of ["scheduled_posts", "claim_due_post", "claim_due(", "x-test-post", "brand_posts"]) assert.ok(!source.includes(banned), `${file}: ${banned}`);
  }
});
