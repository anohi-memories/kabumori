// End-to-end proof on a disposable local database: the REAL Edge handler
// (social-mobile-publish-setting), the REAL brand context loader and cached publish guard, and the REAL
// Vault-backed send adapter (x-test-post/vault_account_auth.ts), all talking over HTTP to the REAL SQL
// functions through social_mobile_publish_permission_postgrest_shim.ts. Only X itself is fake: the
// "request" callback records that a send would have happened. No real network, no production.
//
// Started by social_mobile_publish_permission_run.sh with PUB_E2E=1 (which creates the fixture rows and
// the shim and sets the PUB_E2E_* variables). Without them every test here is skipped.
import assert from "node:assert/strict";
import { createHandler } from "../functions/social-mobile-publish-setting/http.ts";
import { loadBrandContext } from "../functions/_shared/brand/brand_context.ts";
import { assertBrandPublishAllowed } from "../functions/_shared/brand/publish_guard.ts";
import { xOAuthClientRegistryFromEnv } from "../functions/_shared/x_v2_account_refresh.ts";
import {
  createVaultAccountCredentialRpc,
  type VaultAccountCredentialRpc,
  type VaultAccountRef,
  VaultAccountXAuth,
  type XRequestResult,
} from "../functions/x-test-post/vault_account_auth.ts";

const shimUrl = Deno.env.get("PUB_E2E_URL") ?? "";
const anonKey = Deno.env.get("PUB_E2E_ANON_KEY") ?? "";
const serviceKey = Deno.env.get("PUB_E2E_SERVICE_KEY") ?? "";
const fixture = JSON.parse(Deno.env.get("PUB_E2E_FIXTURE") ?? "null") as null | {
  owner: string; viewer: string; stranger: string;
  // One eligible workspace per scenario, each with its own account and a running post.
  workspaces: Record<string, { brand: string; account: string; post: string }>;
};
const enabled = Boolean(shimUrl && anonKey && serviceKey && fixture);
if (enabled && !/^http:\/\/127\.0\.0\.1:\d+$/u.test(shimUrl)) throw new Error("Refusing: the e2e proof only talks to a local shim");

const handler = createHandler({ get: (name) => ({ SUPABASE_URL: shimUrl, SUPABASE_ANON_KEY: anonKey } as Record<string, string>)[name] });

async function toggle(user: string | null, account: string, desired: boolean, expected: boolean) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (user) headers.Authorization = `Bearer fake-jwt.${user}`;
  const response = await handler(new Request("https://edge.local/social-mobile-publish-setting", {
    method: "POST",
    headers,
    body: JSON.stringify({ social_account_id: account, desired_enabled: desired, expected_current_enabled: expected }),
  }));
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

const context = (brandId: string, fetchImpl: typeof fetch = fetch) =>
  loadBrandContext({ supabaseUrl: shimUrl, serviceRoleKey: serviceKey, brandId, fetchImpl });

async function setBrand(id: string, isActive: boolean, publishMode: string) {
  const response = await fetch(`${shimUrl}/__fixture/brand`, {
    method: "POST",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ id, is_active: isActive, publish_mode: publishMode }),
  });
  assert.equal(response.status, 200);
  await response.body?.cancel();
}

/** The dispatcher's send step for one running post; `sends` counts requests that would have reached X. */
async function loadSender(ws: { brand: string; account: string; post: string }) {
  const ref: VaultAccountRef = { scheduledPostId: ws.post, socialAccountId: ws.account, brandId: ws.brand };
  const auth = await VaultAccountXAuth.load(ref, createVaultAccountCredentialRpc({ supabaseUrl: shimUrl, serviceRoleKey: serviceKey }), {
    resolveClient: () => { throw new Error("no refresh in this proof"); },
    refreshEnabled: false,
  });
  const sends: string[] = [];
  const request = (accessToken: string): Promise<XRequestResult> => {
    sends.push(accessToken.startsWith("fake_") ? "fake-token" : "unexpected-token");
    return Promise.resolve({ status: 201, body: { data: { id: "x_fake" } } });
  };
  return { auth, sends, request };
}
const rejectsWith = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (error: unknown) => error instanceof Error && error.message === code);

async function fixtureCall(path: string, body: Record<string, unknown>) {
  const response = await fetch(`${shimUrl}/__fixture/${path}`, {
    method: "POST",
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 200, path);
  await response.body?.cancel();
}
const setAccount = (id: string, verified: boolean, errorCode: string | null) =>
  fixtureCall("account", { id, verified, error_code: errorCode });

/**
 * The send step with token refresh ON (the real begin/commit SQL, a fake X token endpoint). X accepts
 * only the refreshed token, so the first request is answered 401. `timeline` records every permission
 * check and every X request in order; `afterRefresh` runs when the refreshed credential is read back,
 * i.e. after the refresh committed and before the retry's permission check.
 */
async function loadRefreshingSender(ws: { brand: string; account: string; post: string }, afterRefresh?: () => Promise<void>) {
  await fixtureCall("refresh_rollout", { id: ws.account });
  const timeline: string[] = [];
  const base = createVaultAccountCredentialRpc({ supabaseUrl: shimUrl, serviceRoleKey: serviceKey });
  let reads = 0;
  const rpc: VaultAccountCredentialRpc = {
    ...base,
    read: async (ref) => {
      timeline.push("read");
      const credential = await base.read(ref);
      if (++reads === 2) await afterRefresh?.();
      return credential;
    },
    assertPublishPermission: (ref) => {
      timeline.push("permission");
      return base.assertPublishPermission(ref);
    },
    begin: (ref) => {
      timeline.push("begin");
      return base.begin(ref);
    },
    commit: (lease, ref, access, refresh, expiresIn) => {
      timeline.push("commit");
      return base.commit(lease, ref, access, refresh, expiresIn);
    },
  };
  const refreshed = "fake_e2e_refreshed_ACCESS";
  const tokenEndpoint: typeof fetch = (input) => {
    assert.equal(String(input), "https://api.x.com/2/oauth2/token");
    return Promise.resolve(Response.json({ access_token: refreshed, refresh_token: "fake_e2e_refreshed_REFRESH", expires_in: 7200 }));
  };
  const auth = await VaultAccountXAuth.load({ scheduledPostId: ws.post, socialAccountId: ws.account, brandId: ws.brand }, rpc, {
    resolveClient: xOAuthClientRegistryFromEnv((key) => ({ X_CLIENT_ID: "cid", X_CLIENT_SECRET: "csecret" } as Record<string, string>)[key]),
    refreshEnabled: true,
    fetchImpl: tokenEndpoint,
  });
  const request = (accessToken: string): Promise<XRequestResult> => {
    const status = accessToken === refreshed ? 201 : 401;
    timeline.push(`x:${status}`);
    return Promise.resolve({ status, body: status === 201 ? { data: { id: "x_fake" } } : {} });
  };
  return { auth, request, timeline };
}

const e2e = (name: string, fn: (f: NonNullable<typeof fixture>) => Promise<void>) =>
  Deno.test({ name, ignore: !enabled, fn: () => fn(fixture!) });

e2e("handler + SQL: owner ON/OFF, stale, same state; viewer, stranger and anonymous are refused; the database row follows", async (f) => {
  const ws = f.workspaces.basic;
  assert.equal((await toggle(null, ws.account, true, false)).status, 401);
  assert.deepEqual(await toggle(f.stranger, ws.account, true, false), { status: 404, body: { success: false, error: "ACCOUNT_NOT_FOUND" } });
  assert.deepEqual(await toggle(f.stranger, "sa_does_not_exist", true, false), { status: 404, body: { success: false, error: "ACCOUNT_NOT_FOUND" } });
  assert.deepEqual(await toggle(f.viewer, ws.account, true, false), { status: 403, body: { success: false, error: "PUBLISH_CONTROL_FORBIDDEN" } });
  assert.equal((await context(ws.brand)).socialAccount?.publish_enabled, false);

  assert.deepEqual(await toggle(f.owner, ws.account, true, false), {
    status: 200, body: { success: true, status: "updated", account: { id: ws.account, publish_enabled: true } },
  });
  assert.equal((await context(ws.brand)).socialAccount?.publish_enabled, true);
  assert.deepEqual(await toggle(f.owner, ws.account, true, false), { status: 409, body: { success: false, error: "STALE_STATE", current_enabled: true } });
  assert.deepEqual(await toggle(f.owner, ws.account, true, true), {
    status: 200, body: { success: true, status: "unchanged", account: { id: ws.account, publish_enabled: true } },
  });
  assert.deepEqual(await toggle(f.owner, ws.account, false, true), {
    status: 200, body: { success: true, status: "updated", account: { id: ws.account, publish_enabled: false } },
  });
  assert.equal((await context(ws.brand)).socialAccount?.publish_enabled, false);
});

e2e("handler + SQL: ON is refused for a brand that is not active and live, and nothing is written", async (f) => {
  const ws = f.workspaces.blocked;
  await setBrand(ws.brand, true, "dry_run");
  assert.deepEqual(await toggle(f.owner, ws.account, true, false), { status: 409, body: { success: false, error: "BRAND_PUBLISHING_NOT_LIVE" } });
  await setBrand(ws.brand, false, "live");
  assert.deepEqual(await toggle(f.owner, ws.account, true, false), { status: 409, body: { success: false, error: "BRAND_INACTIVE" } });
  assert.equal((await context(ws.brand)).socialAccount?.publish_enabled, false);
});

e2e("publish path + SQL: an enabled account in a live brand is sent exactly once", async (f) => {
  const ws = f.workspaces.send;
  assert.equal((await toggle(f.owner, ws.account, true, false)).status, 200);
  const cached = await context(ws.brand);
  assertBrandPublishAllowed(cached);
  const { auth, sends, request } = await loadSender(ws);
  assert.equal((await auth.send(request)).status, 201);
  assert.deepEqual(sends, ["fake-token"]);
});

// H1 R2, end to end. On the reviewed head (a59a89e9) this exact schedule let a send through.
e2e("H1 R2 schedule: dispatcher brand read, ON, brand disable, dispatcher account read -> the cached guard passes, the pre-send check refuses, zero sends", async (f) => {
  const ws = f.workspaces.r2;
  // The dispatcher's context loader reads the brand, then (a separate request) the account. Between the
  // two: the owner switches ON while the brand is still live, then the brand is disabled.
  let interleaved = false;
  const staged: typeof fetch = async (input, init) => {
    if (!interleaved && String(input).includes("/rest/v1/social_accounts")) {
      interleaved = true;
      assert.deepEqual((await toggle(f.owner, ws.account, true, false)).body, {
        success: true, status: "updated", account: { id: ws.account, publish_enabled: true },
      });
      await setBrand(ws.brand, false, "live");
    }
    return fetch(input, init);
  };
  const cached = await context(ws.brand, staged);
  assert.equal(interleaved, true);
  // The mixed snapshot: a brand read from before the disable, an account read from after the ON.
  assert.deepEqual([cached.brand.is_active, cached.brand.publish_mode, cached.socialAccount?.publish_enabled], [true, "live", true]);
  assertBrandPublishAllowed(cached); // the cached guard cannot see the disable
  // The credential reader has no brand check either, so the sender loads.
  const { auth, sends, request } = await loadSender(ws);
  await rejectsWith(auth.send(request), "BRAND_DISABLED");
  assert.deepEqual(sends, [], "nothing was sent to X");
  // And ON can no longer be granted for the disabled brand.
  assert.equal((await toggle(f.owner, ws.account, false, true)).status, 200, "OFF still works for a disabled brand");
  assert.deepEqual((await toggle(f.owner, ws.account, true, false)).body, { success: false, error: "BRAND_INACTIVE" });
});

e2e("stale cached account ON: the owner switches OFF during generation -> the send is refused; a request already in flight is not recalled", async (f) => {
  const ws = f.workspaces.off;
  assert.equal((await toggle(f.owner, ws.account, true, false)).status, 200);
  const cached = await context(ws.brand);
  assertBrandPublishAllowed(cached);
  const first = await loadSender(ws);
  // In flight: the owner's OFF lands while the request is on its way to X.
  const inFlight = (accessToken: string): Promise<XRequestResult> =>
    toggle(f.owner, ws.account, false, true).then((off) => {
      assert.equal(off.status, 200);
      return first.request(accessToken);
    });
  assert.equal((await first.auth.send(inFlight)).status, 201);
  assert.deepEqual(first.sends, ["fake-token"]);
  // OFF is now committed: the same dispatch (still holding the cached "ON" context) cannot start another.
  assertBrandPublishAllowed(cached);
  await rejectsWith(first.auth.send(first.request), "X_ACCOUNT_PUBLISH_DISABLED");
  assert.deepEqual(first.sends, ["fake-token"]);
});

// H2 F1: states ON refuses must be refused at send time too, by the final check itself.
for (const [label, key, verified, errorCode, sendRefusal, onRefusal] of [
  ["verified_at missing", "f1v", false, null, "X_ACCOUNT_NOT_VERIFIED", "CONNECTION_NOT_VERIFIED"],
  ["a recorded connection error", "f1e", true, "X_ACCESS_TOKEN_UNAUTHORIZED", "X_ACCOUNT_CONNECTION_DEGRADED", "CONNECTION_DEGRADED"],
] as const) {
  e2e(`F1 ${label}: the send is refused with zero X requests, OFF still works, ON is refused for the same reason`, async (f) => {
    const ws = f.workspaces[key];
    assert.equal((await toggle(f.owner, ws.account, true, false)).status, 200);
    const cached = await context(ws.brand);
    assertBrandPublishAllowed(cached);
    const { auth, sends, request } = await loadSender(ws); // loaded while eligible
    await setAccount(ws.account, verified, errorCode); // ... and degraded before the send
    await rejectsWith(auth.send(request), sendRefusal);
    assert.deepEqual(sends, [], "nothing was sent to X");
    assert.deepEqual(await toggle(f.owner, ws.account, false, true), {
      status: 200, body: { success: true, status: "updated", account: { id: ws.account, publish_enabled: false } },
    });
    assert.deepEqual(await toggle(f.owner, ws.account, true, false), {
      status: 409, body: { success: false, error: onRefusal, reconnect_recommended: true },
    });
    // Restored, the same account is eligible and sendable again.
    await setAccount(ws.account, true, null);
    assert.equal((await toggle(f.owner, ws.account, true, false)).status, 200);
    const again = await loadSender(ws);
    assert.equal((await again.auth.send(again.request)).status, 201);
    assert.deepEqual(again.sends, ["fake-token"]);
  });
}

e2e("401 -> refresh -> retry with the real refresh SQL: every X request is directly preceded by a fresh permission check", async (f) => {
  const ws = f.workspaces.retry;
  assert.equal((await toggle(f.owner, ws.account, true, false)).status, 200);
  const { auth, request, timeline } = await loadRefreshingSender(ws);
  assert.equal((await auth.send(request)).status, 201);
  assert.deepEqual(timeline, ["read", "permission", "x:401", "begin", "commit", "read", "permission", "x:201"]);
});

e2e("OFF lands after the refresh committed and before the retry: the retry's own check refuses it; X saw only the rejected first request", async (f) => {
  const ws = f.workspaces.retryoff;
  assert.equal((await toggle(f.owner, ws.account, true, false)).status, 200);
  const { auth, request, timeline } = await loadRefreshingSender(ws, async () => {
    assert.equal((await toggle(f.owner, ws.account, false, true)).status, 200);
  });
  await rejectsWith(auth.send(request), "X_ACCOUNT_PUBLISH_DISABLED");
  assert.deepEqual(timeline, ["read", "permission", "x:401", "begin", "commit", "read", "permission"]);
});
