// Partial-rollout proof (H2 finding F3), first state of the approved order: the guarded x-test-post
// runtime is live but the permission migration is NOT applied yet. Runs on a disposable local database
// that has the real prerequisite migrations but not the candidate, through
// social_mobile_publish_permission_postgrest_shim.ts (which answers a missing function like PostgREST:
// 404 PGRST202). Only X itself is fake. The states after the migration are proven by
// social_mobile_publish_permission_e2e_test.ts; the order itself by social_mobile_publish_permission_rollout_test.ts.
//
// Started by social_mobile_publish_permission_run.sh with PUB_E2E=1 BEFORE it applies the candidate.
// Without the PUB_E2E_* variables every test here is skipped.
import assert from "node:assert/strict";
import { createHandler } from "../functions/social-mobile-publish-setting/http.ts";
import { loadBrandContext } from "../functions/_shared/brand/brand_context.ts";
import { xOAuthClientRegistryFromEnv } from "../functions/_shared/x_v2_account_refresh.ts";
import {
  createVaultAccountCredentialRpc,
  VaultAccountXAuth,
  type XRequestResult,
} from "../functions/x-test-post/vault_account_auth.ts";

const shimUrl = Deno.env.get("PUB_E2E_URL") ?? "";
const anonKey = Deno.env.get("PUB_E2E_ANON_KEY") ?? "";
const serviceKey = Deno.env.get("PUB_E2E_SERVICE_KEY") ?? "";
const fixture = JSON.parse(Deno.env.get("PUB_E2E_FIXTURE") ?? "null") as null | {
  owner: string;
  // An account that was already ON before the rollout, in a live brand, with a running post.
  workspace: { brand: string; account: string; post: string };
};
const enabled = Boolean(shimUrl && anonKey && serviceKey && fixture);
if (enabled && !/^http:\/\/127\.0\.0\.1:\d+$/u.test(shimUrl)) throw new Error("Refusing: the e2e proof only talks to a local shim");

const e2e = (name: string, fn: (f: NonNullable<typeof fixture>) => Promise<void>) =>
  Deno.test({ name, ignore: !enabled, fn: () => fn(fixture!) });

e2e("guarded runtime, permission migration not applied: the Vault-backed send fails closed with zero X and zero token requests", async (f) => {
  const ws = f.workspace;
  // The dispatcher's cached context says ON and live, as it would for an account enabled before the rollout.
  const cached = await loadBrandContext({ supabaseUrl: shimUrl, serviceRoleKey: serviceKey, brandId: ws.brand });
  assert.equal(cached.socialAccount?.publish_enabled, true);
  assert.deepEqual([cached.brand.is_active, cached.brand.publish_mode], [true, "live"]);

  const tokenRequests: string[] = [];
  const auth = await VaultAccountXAuth.load(
    { scheduledPostId: ws.post, socialAccountId: ws.account, brandId: ws.brand },
    createVaultAccountCredentialRpc({ supabaseUrl: shimUrl, serviceRoleKey: serviceKey }),
    {
      resolveClient: xOAuthClientRegistryFromEnv((key) => ({ X_CLIENT_ID: "cid", X_CLIENT_SECRET: "csecret" } as Record<string, string>)[key]),
      refreshEnabled: true,
      fetchImpl: (input) => {
        tokenRequests.push(String(input));
        return Promise.reject(new Error("no token request may happen in this state"));
      },
    },
  );
  const sends: number[] = [];
  const request = (): Promise<XRequestResult> => {
    sends.push(1);
    return Promise.resolve({ status: 201, body: { data: { id: "x_fake" } } });
  };
  await assert.rejects(auth.send(request), (error: unknown) => error instanceof Error && error.message === "X_PUBLISH_PERMISSION_UNAVAILABLE");
  assert.deepEqual(sends, [], "nothing reached X");
  assert.deepEqual(tokenRequests, [], "no token was rotated either");
});

e2e("permission migration not applied: the switch does not exist, the Edge function answers a bounded 503 and nothing changes", async (f) => {
  const ws = f.workspace;
  const handler = createHandler({ get: (name) => ({ SUPABASE_URL: shimUrl, SUPABASE_ANON_KEY: anonKey } as Record<string, string>)[name] });
  const response = await handler(new Request("https://edge.local/social-mobile-publish-setting", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer fake-jwt.${f.owner}` },
    body: JSON.stringify({ social_account_id: ws.account, desired_enabled: false, expected_current_enabled: true }),
  }));
  assert.deepEqual({ status: response.status, body: await response.json() }, {
    status: 503, body: { success: false, error: "PUBLISH_SETTING_UNAVAILABLE" },
  });
  const after = await loadBrandContext({ supabaseUrl: shimUrl, serviceRoleKey: serviceKey, brandId: ws.brand });
  assert.equal(after.socialAccount?.publish_enabled, true);
});
