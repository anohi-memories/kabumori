import assert from "node:assert/strict";
import test from "node:test";
import {
  createXClaimCredentialRpcReader,
  resolveXCredentialForClaim,
  XAccountCredential,
  XCredentialResolutionError,
  type XClaimCredentialReader,
  type XV2Claim,
} from "./x_v2_claim_credentials.ts";

const SECRET = "tok_SECRET_acct_a2_value";
const LEGACY_SECRET = "tok_LEGACY_shared_store";
const AI_LAB_SECRET = "tok_AI_LAB_hardcoded";

const claim: XV2Claim = {
  attemptId: "11111111-1111-4111-8111-111111111111",
  claimToken: "22222222-2222-4222-8222-222222222222",
  socialAccountId: "acct_a2",
  brandId: "brand_a",
};

type Account = {
  id: string;
  brand_id: string;
  platform: string;
  connection_status: string;
  platform_user_id: string | null;
  publish_enabled: boolean;
  access_token: string | null;
};

// Same brand with two X accounts, a second brand, a non-X account, plus the
// legacy shared token and AI Lab token that must never be used.
const ACCOUNTS: Account[] = [
  { id: "acct_a1", brand_id: "brand_a", platform: "x", connection_status: "identity_verified", platform_user_id: "x_a1", publish_enabled: true, access_token: "tok_acct_a1" },
  { id: "acct_a2", brand_id: "brand_a", platform: "x", connection_status: "identity_verified", platform_user_id: "x_a2", publish_enabled: true, access_token: SECRET },
  { id: "acct_b", brand_id: "brand_b", platform: "x", connection_status: "identity_verified", platform_user_id: "x_b", publish_enabled: true, access_token: "tok_acct_b" },
  { id: "acct_other", brand_id: "brand_a", platform: "other", connection_status: "identity_verified", platform_user_id: "o", publish_enabled: true, access_token: "tok_other" },
  { id: "ai_salaryman_lab_x", brand_id: "ai_salaryman_lab", platform: "x", connection_status: "identity_verified", platform_user_id: "x_lab", publish_enabled: true, access_token: AI_LAB_SECRET },
];

/**
 * In-memory mirror of read_x_publish_credential_for_claim_v2: the attempt
 * binds (attemptId, claimToken) to exactly one account; lookups are by id.
 */
function fakeRpcFetch(
  attempts: Array<{ id: string; token: string; account: string; brand: string; phase?: string }>,
  accounts: Account[] = ACCOUNTS,
  calls: string[] = [],
): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("oauth_token_store")) return Response.json([{ access_token: LEGACY_SECRET }]);
    if (url.includes("read_ai_salaryman_lab_x_vault_token")) return Response.json({ token_value: AI_LAB_SECRET });
    assert.ok(url.endsWith("/rest/v1/rpc/read_x_publish_credential_for_claim_v2"), url);
    const body = JSON.parse(String(init?.body));
    const fail = (message: string) => Response.json({ code: "P0001", message }, { status: 400 });
    const attempt = attempts.find((a) => a.id === body.p_attempt_id && a.token === body.p_claim_token);
    if (!attempt || (attempt.phase ?? "pre_x") !== "pre_x") return fail("X_CLAIM_NOT_PRE_X");
    if (attempt.account !== body.p_social_account_id || attempt.brand !== body.p_expected_brand_id) {
      return fail("X_CLAIM_ACCOUNT_MISMATCH");
    }
    const account = accounts.find((a) => a.id === attempt.account);
    if (!account) return fail("X_ACCOUNT_NOT_FOUND");
    if (account.platform !== "x") return fail("X_ACCOUNT_NOT_X");
    if (account.brand_id !== attempt.brand) return fail("X_ACCOUNT_BRAND_MISMATCH");
    if (account.connection_status !== "identity_verified" || !account.platform_user_id) return fail("X_ACCOUNT_NOT_VERIFIED");
    if (body.p_require_publish_enabled && !account.publish_enabled) return fail("X_ACCOUNT_PUBLISH_DISABLED");
    if (!account.access_token) return fail("X_CREDENTIAL_NOT_CONFIGURED");
    return Response.json([{
      social_account_id: account.id,
      brand_id: account.brand_id,
      platform_user_id: account.platform_user_id,
      access_token: account.access_token,
    }]);
  };
}

function reader(fetchImpl: typeof fetch): XClaimCredentialReader {
  return createXClaimCredentialRpcReader({ supabaseUrl: "https://example.supabase.co/", serviceRoleKey: "srk", fetchImpl });
}

const exactAttempt = { id: claim.attemptId, token: claim.claimToken, account: "acct_a2", brand: "brand_a" };

async function expectCode(promise: Promise<unknown>, code: string): Promise<XCredentialResolutionError> {
  const error = await promise.then(() => null, (e) => e);
  assert.ok(error instanceof XCredentialResolutionError, `expected ${code}, got ${error}`);
  assert.equal(error.code, code);
  assert.equal(error.message, code);
  for (const secret of [SECRET, LEGACY_SECRET, AI_LAB_SECRET, "srk"]) {
    assert.ok(!String(error.stack).includes(secret));
  }
  return error;
}

test("exact matching account succeeds and the second X account of the same brand is never picked", async () => {
  const calls: string[] = [];
  const credential = await resolveXCredentialForClaim(claim, reader(fakeRpcFetch([exactAttempt], ACCOUNTS, calls)));
  assert.equal(credential.socialAccountId, "acct_a2");
  assert.equal(credential.brandId, "brand_a");
  assert.equal(credential.platformUserId, "x_a2");
  assert.equal(credential.bearerHeader(), `Bearer ${SECRET}`);
  assert.deepEqual(calls, ["https://example.supabase.co/rest/v1/rpc/read_x_publish_credential_for_claim_v2"]);
});

test("the RPC request carries only the claim identity, never a brand-only selector or secret reference", async () => {
  let sent: Record<string, unknown> = {};
  const fetchImpl: typeof fetch = async (input, init) => {
    sent = JSON.parse(String(init?.body));
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer srk");
    assert.equal(init?.redirect, "manual");
    return fakeRpcFetch([exactAttempt])(input, init);
  };
  await resolveXCredentialForClaim(claim, reader(fetchImpl));
  assert.deepEqual(Object.keys(sent).sort(), [
    "p_attempt_id", "p_claim_token", "p_expected_brand_id", "p_require_publish_enabled", "p_social_account_id",
  ]);
  assert.equal(sent.p_require_publish_enabled, true);
});

test("RPC redirect is rejected without following a service-role-key request", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async (_input, init) => {
    calls += 1;
    assert.equal(init?.redirect, "manual");
    return new Response(null, { status: 307, headers: { Location: "https://example.invalid/steal" } });
  };
  await expectCode(resolveXCredentialForClaim(claim, reader(fetchImpl)), "X_CREDENTIAL_READ_FAILED");
  assert.equal(calls, 1);
});

test("claim for a different-brand account is rejected", async () => {
  const other = { ...claim, socialAccountId: "acct_b" };
  await expectCode(resolveXCredentialForClaim(other, reader(fakeRpcFetch([{ ...exactAttempt, account: "acct_b", brand: "brand_b" }]))), "X_CLAIM_ACCOUNT_MISMATCH");
  const crossed = [{ ...exactAttempt, account: "acct_b", brand: "brand_a" }];
  await expectCode(resolveXCredentialForClaim({ ...claim, socialAccountId: "acct_b" }, reader(fakeRpcFetch(crossed))), "X_ACCOUNT_BRAND_MISMATCH");
});

test("non-X, missing, unverified, publish-disabled and unconfigured accounts are rejected", async () => {
  const cases: Array<[Partial<Account> | null, string, string]> = [
    [null, "acct_other", "X_ACCOUNT_NOT_X"],
    [null, "acct_missing", "X_ACCOUNT_NOT_FOUND"],
    [{ connection_status: "pending" }, "acct_a2", "X_ACCOUNT_NOT_VERIFIED"],
    [{ platform_user_id: null }, "acct_a2", "X_ACCOUNT_NOT_VERIFIED"],
    [{ publish_enabled: false }, "acct_a2", "X_ACCOUNT_PUBLISH_DISABLED"],
    [{ access_token: null }, "acct_a2", "X_CREDENTIAL_NOT_CONFIGURED"],
  ];
  for (const [patch, accountId, code] of cases) {
    const accounts = ACCOUNTS.map((a) => (patch && a.id === accountId ? { ...a, ...patch } : a));
    const c = { ...claim, socialAccountId: accountId };
    await expectCode(
      resolveXCredentialForClaim(c, reader(fakeRpcFetch([{ ...exactAttempt, account: accountId }], accounts))),
      code,
    );
  }
});

test("publish permission is only waived when the caller explicitly says so", async () => {
  const accounts = ACCOUNTS.map((a) => (a.id === "acct_a2" ? { ...a, publish_enabled: false } : a));
  const credential = await resolveXCredentialForClaim(claim, reader(fakeRpcFetch([exactAttempt], accounts)), { requirePublishEnabled: false });
  assert.equal(credential.socialAccountId, "acct_a2");
});

test("no fallback: a failed exact account never yields another account, the legacy store, or the AI Lab token", async () => {
  const calls: string[] = [];
  const accounts = ACCOUNTS.map((a) => (a.id === "acct_a2" ? { ...a, access_token: null } : a));
  await expectCode(resolveXCredentialForClaim(claim, reader(fakeRpcFetch([exactAttempt], accounts, calls))), "X_CREDENTIAL_NOT_CONFIGURED");
  assert.equal(calls.length, 1);
  assert.ok(calls.every((url) => !url.includes("oauth_token_store") && !url.includes("ai_salaryman_lab")));
});

test("a response for a different account than the claim is discarded", async () => {
  const lying: XClaimCredentialReader = {
    readForClaim: async () => [{ social_account_id: "acct_a1", brand_id: "brand_a", platform_user_id: "x_a1", access_token: "tok_acct_a1" }],
  };
  await expectCode(resolveXCredentialForClaim(claim, lying), "X_CLAIM_ACCOUNT_MISMATCH");
  const twoRows: XClaimCredentialReader = {
    readForClaim: async () => [
      { social_account_id: "acct_a2", brand_id: "brand_a", platform_user_id: "x_a2", access_token: SECRET },
      { social_account_id: "acct_a2", brand_id: "brand_a", platform_user_id: "x_a2", access_token: SECRET },
    ],
  };
  await expectCode(resolveXCredentialForClaim(claim, twoRows), "X_CREDENTIAL_UNAVAILABLE");
});

test("stale or foreign claims and blank inputs fail before or at the RPC", async () => {
  await expectCode(resolveXCredentialForClaim({ ...claim, claimToken: "33333333-3333-4333-8333-333333333333" }, reader(fakeRpcFetch([exactAttempt]))), "X_CLAIM_NOT_PRE_X");
  await expectCode(resolveXCredentialForClaim(claim, reader(fakeRpcFetch([{ ...exactAttempt, phase: "provider_started" }]))), "X_CLAIM_NOT_PRE_X");
  let called = false;
  const spy: XClaimCredentialReader = { readForClaim: async () => { called = true; return null; } };
  for (const bad of [{ ...claim, socialAccountId: " " }, { ...claim, brandId: "" }, { ...claim, attemptId: "" }]) {
    await expectCode(resolveXCredentialForClaim(bad, spy), "X_CREDENTIAL_REQUEST_INVALID");
  }
  assert.equal(called, false);
});

test("transport and unknown RPC errors map to fixed codes without echoing the body", async () => {
  const leaky: typeof fetch = async () =>
    Response.json({ message: `permission denied; token=${SECRET}`, hint: SECRET }, { status: 500 });
  const e1 = await expectCode(resolveXCredentialForClaim(claim, reader(leaky)), "X_CREDENTIAL_READ_FAILED");
  assert.equal(e1.outcome, "pre_x_retryable");
  const down: typeof fetch = async () => { throw new TypeError(`connect failed ${SECRET}`); };
  await expectCode(resolveXCredentialForClaim(claim, reader(down)), "X_CREDENTIAL_READ_FAILED");
  const notJson: typeof fetch = async () => new Response(`<html>${SECRET}</html>`, { status: 200 });
  const e3 = await expectCode(resolveXCredentialForClaim(claim, reader(notJson)), "X_CREDENTIAL_UNAVAILABLE");
  assert.equal(e3.outcome, "pre_x_terminal");
});

test("credential never serializes, inspects or logs its token", async () => {
  const logged: string[] = [];
  const original = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const key of Object.keys(original) as Array<keyof typeof original>) {
    console[key] = (...args: unknown[]) => { logged.push(args.map((a) => Deno.inspect(a)).join(" ")); };
  }
  try {
    const credential = await resolveXCredentialForClaim(claim, reader(fakeRpcFetch([exactAttempt])));
    console.log(credential, { credential });
    console.error(`${credential}`);
    const serialized = JSON.stringify({ credential });
    assert.ok(!serialized.includes(SECRET));
    assert.ok(!Deno.inspect(credential, { depth: 5 }).includes(SECRET));
    assert.ok(!String(credential).includes(SECRET));
    assert.ok(credential instanceof XAccountCredential);
    assert.deepEqual(JSON.parse(serialized).credential, { socialAccountId: "acct_a2", brandId: "brand_a", platformUserId: "x_a2" });
  } finally {
    Object.assign(console, original);
  }
  assert.ok(logged.length > 0);
  assert.ok(logged.every((line) => !line.includes(SECRET)));
});

test("resolver module has no brand-only, first-row, legacy-store, env or hardcoded-account path", async () => {
  const source = (await Deno.readTextFile(new URL("./x_v2_claim_credentials.ts", import.meta.url)))
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gmu, "");
  assert.doesNotMatch(source, /limit[=:]\s*["']?1/u);
  assert.doesNotMatch(source, /oauth_token_store|loadXTokens|loadBrandXTokens|loadBrandContext|Deno\.env|ai_salaryman_lab|brand_id: `eq\./u);
  assert.doesNotMatch(source, /console\./u);
  assert.doesNotMatch(source, /refresh_token|vault_(access|refresh)_token_secret_id/u);
});
