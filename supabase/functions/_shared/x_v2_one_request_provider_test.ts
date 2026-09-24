import assert from "node:assert/strict";
import test from "node:test";
import { XAccountCredential, type XClaimCredentialReader, type XV2Claim } from "./x_v2_claim_credentials.ts";
import {
  createXTextPostOnceV2,
  publishClaimedXTextPostV2,
  verifyXCredentialIdentityPreX,
} from "./x_v2_one_request_provider.ts";

const SECRET = "tok_SECRET_value";
const ME = "https://api.x.com/2/users/me";
const CREATE = "https://api.x.com/2/tweets";
const TOKEN_ENDPOINT = "https://api.x.com/2/oauth2/token";

function credential(platformUserId = "x_a2"): XAccountCredential {
  return new XAccountCredential({ socialAccountId: "acct_a2", brandId: "brand_a", platformUserId }, SECRET);
}

type Step = Response | Error;

/** Scripted X: counts every request by URL and fails on anything unexpected. */
function scriptedX(script: { me?: Step; create?: Step }) {
  const calls: Array<{ url: string; method: string; auth: string | null; redirect: RequestRedirect | undefined }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, method: init?.method ?? "GET", auth: headers.get("Authorization"), redirect: init?.redirect });
    const step = url === ME ? script.me : url === CREATE ? script.create : undefined;
    if (!step) throw new Error(`unexpected request ${url}`);
    if (step instanceof Error) throw step;
    return step.clone();
  };
  const count = (url: string) => calls.filter((c) => c.url === url).length;
  return { fetchImpl, calls, count };
}

const meOk = () => Response.json({ data: { id: "x_a2", username: "a2" } });

function starter() {
  const state = { marks: 0, order: [] as string[] };
  return {
    state,
    markProviderStarted: async () => { state.marks += 1; state.order.push("mark"); },
  };
}

test("success: identity check, durable start mark, then exactly one create", async () => {
  const x = scriptedX({ me: meOk(), create: Response.json({ data: { id: "1800", text: "hi" } }, { status: 201 }) });
  const s = starter();
  const wrapped: typeof fetch = async (input, init) => { s.state.order.push(String(input)); return x.fetchImpl(input, init); };
  const outcome = await createXTextPostOnceV2({ credential: credential(), text: "hi", markProviderStarted: s.markProviderStarted }, { fetchImpl: wrapped });
  assert.deepEqual(outcome, { kind: "x_created", xPostId: "1800", httpStatus: 201, createRequests: 1 });
  assert.equal(x.count(CREATE), 1);
  assert.deepEqual(s.state.order, [ME, "mark", CREATE]);
  assert.ok(x.calls.every((c) => c.auth === `Bearer ${SECRET}`));
  assert.ok(x.calls.every((c) => c.redirect === "manual"));
});

test("redirect responses cannot trigger an automatic second X create", async () => {
  const x = scriptedX({ me: meOk(), create: new Response(null, { status: 307, headers: { Location: "https://example.invalid/2/tweets" } }) });
  const outcome = await createXTextPostOnceV2({ credential: credential(), text: "hi", markProviderStarted: async () => {} }, { fetchImpl: x.fetchImpl });
  assert.deepEqual(outcome, { kind: "x_outcome_uncertain", code: "X_CREATE_HTTP_307", httpStatus: 307, createRequests: 1 });
  assert.equal(x.count(CREATE), 1);
  assert.equal(x.calls.find((call) => call.url === CREATE)?.redirect, "manual");
});

test("401 after provider start is a rejection with no refresh and no second create", async () => {
  const x = scriptedX({ me: meOk(), create: Response.json({ title: "Unauthorized" }, { status: 401 }) });
  const s = starter();
  const outcome = await createXTextPostOnceV2({ credential: credential(), text: "hi", markProviderStarted: s.markProviderStarted }, { fetchImpl: x.fetchImpl });
  assert.deepEqual(outcome, { kind: "x_rejected", code: "X_CREATE_REJECTED_401", httpStatus: 401, createRequests: 1 });
  assert.equal(x.count(CREATE), 1);
  assert.equal(x.count(TOKEN_ENDPOINT), 0);
  assert.equal(s.state.marks, 1);
});

test("expired token before start returns a pre-X outcome: no mark, no refresh, no create", async () => {
  const x = scriptedX({ me: Response.json({}, { status: 401 }), create: Response.json({ data: { id: "never" } }, { status: 201 }) });
  const s = starter();
  const outcome = await createXTextPostOnceV2({ credential: credential(), text: "hi", markProviderStarted: s.markProviderStarted }, { fetchImpl: x.fetchImpl });
  assert.deepEqual(outcome, { kind: "pre_x_retryable", code: "X_ACCESS_TOKEN_REFRESH_REQUIRED_PRE_X", createRequests: 0 });
  assert.equal(x.count(CREATE), 0);
  assert.equal(x.count(TOKEN_ENDPOINT), 0);
  assert.equal(s.state.marks, 0);
});

test("a token belonging to another X identity is rejected before start", async () => {
  const x = scriptedX({ me: Response.json({ data: { id: "x_a1" } }), create: Response.json({ data: { id: "never" } }, { status: 201 }) });
  const s = starter();
  const outcome = await createXTextPostOnceV2({ credential: credential("x_a2"), text: "hi", markProviderStarted: s.markProviderStarted }, { fetchImpl: x.fetchImpl });
  assert.deepEqual(outcome, { kind: "pre_x_terminal", code: "X_CREDENTIAL_IDENTITY_MISMATCH", createRequests: 0 });
  assert.equal(x.count(CREATE), 0);
  assert.equal(s.state.marks, 0);
});

test("identity-check outages are pre-X retryable and 403 is pre-X terminal", async () => {
  for (const [me, kind, code] of [
    [new TypeError("offline"), "pre_x_retryable", "X_IDENTITY_CHECK_UNAVAILABLE"],
    [Response.json({}, { status: 503 }), "pre_x_retryable", "X_IDENTITY_CHECK_UNAVAILABLE"],
    [Response.json({}, { status: 429 }), "pre_x_retryable", "X_IDENTITY_CHECK_UNAVAILABLE"],
    [Response.json({}, { status: 403 }), "pre_x_terminal", "X_IDENTITY_CHECK_FORBIDDEN"],
  ] as const) {
    const x = scriptedX({ me, create: Response.json({ data: { id: "never" } }, { status: 201 }) });
    const outcome = await verifyXCredentialIdentityPreX(credential(), { fetchImpl: x.fetchImpl });
    assert.deepEqual(outcome, { kind, code, createRequests: 0 });
    assert.equal(x.count(CREATE), 0);
  }
});

test("failure to record provider start sends nothing", async () => {
  const x = scriptedX({ me: meOk(), create: Response.json({ data: { id: "never" } }, { status: 201 }) });
  const outcome = await createXTextPostOnceV2({
    credential: credential(), text: "hi",
    markProviderStarted: async () => { throw new Error("ATTEMPT_NOT_PRE_X"); },
  }, { fetchImpl: x.fetchImpl });
  assert.deepEqual(outcome, { kind: "pre_x_retryable", code: "X_PROVIDER_START_NOT_RECORDED", createRequests: 0 });
  assert.equal(x.count(CREATE), 0);
});

test("uncertain outcomes are distinct from confirmed rejection", async () => {
  const cases: Array<[Step, string, string, number | null]> = [
    [new TypeError("socket hang up"), "x_outcome_uncertain", "X_CREATE_NETWORK_UNCERTAIN", null],
    [new DOMException("timed out", "TimeoutError"), "x_outcome_uncertain", "X_CREATE_NETWORK_UNCERTAIN", null],
    [Response.json({}, { status: 500 }), "x_outcome_uncertain", "X_CREATE_HTTP_500", 500],
    [Response.json({}, { status: 503 }), "x_outcome_uncertain", "X_CREATE_HTTP_503", 503],
    [Response.json({}, { status: 408 }), "x_outcome_uncertain", "X_CREATE_HTTP_408", 408],
    [new Response("<html>ok</html>", { status: 200 }), "x_outcome_uncertain", "X_CREATE_RESPONSE_MISSING_POST_ID", 200],
    [Response.json({ data: {} }, { status: 201 }), "x_outcome_uncertain", "X_CREATE_RESPONSE_MISSING_POST_ID", 201],
    [Response.json({ detail: "duplicate" }, { status: 403 }), "x_rejected", "X_CREATE_REJECTED_403", 403],
    [Response.json({}, { status: 400 }), "x_rejected", "X_CREATE_REJECTED_400", 400],
    [Response.json({}, { status: 429 }), "x_rejected", "X_CREATE_REJECTED_429", 429],
  ];
  for (const [create, kind, code, httpStatus] of cases) {
    const x = scriptedX({ me: meOk(), create });
    const outcome = await createXTextPostOnceV2({ credential: credential(), text: "hi", markProviderStarted: async () => {} }, { fetchImpl: x.fetchImpl });
    assert.deepEqual(outcome, { kind, code, httpStatus, createRequests: 1 }, code);
    assert.equal(x.count(CREATE), 1, code);
  }
});

test("empty text is rejected before any request", async () => {
  const x = scriptedX({});
  const outcome = await createXTextPostOnceV2({ credential: credential(), text: "  ", markProviderStarted: async () => {} }, { fetchImpl: x.fetchImpl });
  assert.deepEqual(outcome, { kind: "pre_x_terminal", code: "X_CREATE_TEXT_EMPTY", createRequests: 0 });
  assert.equal(x.calls.length, 0);
});

const claim: XV2Claim = { attemptId: "a", claimToken: "t", socialAccountId: "acct_a2", brandId: "brand_a" };

test("no provider call occurs when resolver validation fails", async () => {
  for (const [message, kind] of [
    ["X_ACCOUNT_PUBLISH_DISABLED", "pre_x_terminal"],
    ["X_CLAIM_ACCOUNT_MISMATCH", "pre_x_terminal"],
    ["X_CREDENTIAL_NOT_CONFIGURED", "pre_x_terminal"],
  ] as const) {
    const x = scriptedX({ me: meOk(), create: Response.json({ data: { id: "never" } }, { status: 201 }) });
    const { createXClaimCredentialRpcReader } = await import("./x_v2_claim_credentials.ts");
    const reader = createXClaimCredentialRpcReader({
      supabaseUrl: "https://example.supabase.co", serviceRoleKey: "srk",
      fetchImpl: async () => Response.json({ message }, { status: 400 }),
    });
    const s = starter();
    const outcome = await publishClaimedXTextPostV2({ claim, text: "hi", reader, markProviderStarted: s.markProviderStarted }, { fetchImpl: x.fetchImpl });
    assert.deepEqual(outcome, { kind, code: message, createRequests: 0 });
    assert.equal(x.calls.length, 0);
    assert.equal(s.state.marks, 0);
  }
  const x = scriptedX({});
  const wrongAccount: XClaimCredentialReader = {
    readForClaim: async () => [{ social_account_id: "acct_a1", brand_id: "brand_a", platform_user_id: "x_a1", access_token: "tok_a1" }],
  };
  const outcome = await publishClaimedXTextPostV2({ claim, text: "hi", reader: wrongAccount, markProviderStarted: async () => {} }, { fetchImpl: x.fetchImpl });
  assert.deepEqual(outcome, { kind: "pre_x_terminal", code: "X_CLAIM_ACCOUNT_MISMATCH", createRequests: 0 });
  assert.equal(x.calls.length, 0);
});

test("end to end: the exact claimed account's token is the only token sent", async () => {
  const x = scriptedX({ me: meOk(), create: Response.json({ data: { id: "1801" } }, { status: 201 }) });
  const reader: XClaimCredentialReader = {
    readForClaim: async (c) => {
      assert.deepEqual(c, claim);
      return [{ social_account_id: "acct_a2", brand_id: "brand_a", platform_user_id: "x_a2", access_token: SECRET }];
    },
  };
  const outcome = await publishClaimedXTextPostV2({ claim, text: "hi", reader, markProviderStarted: async () => {} }, { fetchImpl: x.fetchImpl });
  assert.deepEqual(outcome, { kind: "x_created", xPostId: "1801", httpStatus: 201, createRequests: 1 });
  assert.deepEqual(x.calls.map((c) => c.auth), [`Bearer ${SECRET}`, `Bearer ${SECRET}`]);
});

test("outcomes, codes and console output never contain the token or response bodies", async () => {
  const logged: string[] = [];
  const original = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const key of Object.keys(original) as Array<keyof typeof original>) {
    console[key] = (...args: unknown[]) => { logged.push(args.map((a) => Deno.inspect(a)).join(" ")); };
  }
  const outcomes: unknown[] = [];
  try {
    for (const create of [
      Response.json({ error: SECRET }, { status: 401 }),
      Response.json({ error: SECRET }, { status: 500 }),
      Response.json({ data: { id: "9" }, echo: SECRET }, { status: 201 }),
    ]) {
      const x = scriptedX({ me: meOk(), create });
      outcomes.push(await createXTextPostOnceV2({ credential: credential(), text: "hi", markProviderStarted: async () => {} }, { fetchImpl: x.fetchImpl }));
    }
  } finally {
    Object.assign(console, original);
  }
  assert.ok(!JSON.stringify(outcomes).includes(SECRET));
  assert.equal(logged.length, 0);
});

test("seam source has no refresh, token store, retry loop or legacy helper", async () => {
  const source = (await Deno.readTextFile(new URL("./x_v2_one_request_provider.ts", import.meta.url)))
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gmu, "");
  assert.doesNotMatch(source, /oauth2\/token|refresh|oauth_token_store|requestXWithAuthRefresh|postToX|Deno\.env|console\./u);
  assert.doesNotMatch(source, /\bfor\s*\(|\bwhile\s*\(/u);
  assert.equal((source.match(/X_CREATE_POST_URL, \{/gu) ?? []).length, 1);
});
