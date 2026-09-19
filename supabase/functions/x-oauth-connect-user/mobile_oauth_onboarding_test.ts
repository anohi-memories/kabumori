import {
  base64ToBase64Url,
  bytesToHex,
  isRetryableOAuthError,
  parseOAuthReturn,
} from "../../../apps/social-mobile/src/lib/x-oauth-onboarding.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function assertThrows(action: () => unknown, expectedMessage: string) {
  try {
    action();
  } catch (error) {
    assert(error instanceof Error && error.message === expectedMessage, "unexpected error");
    return;
  }
  throw new Error(`expected ${expectedMessage}`);
}

Deno.test("OAuth callback accepts only the configured deep link and matching raw state", () => {
  const result = parseOAuthReturn(
    "kabumori-social://oauth-callback?code=auth-code&state=raw-state-1234567890",
    "kabumori-social://oauth-callback",
    "raw-state-1234567890",
  );
  assert(result.kind === "success" && result.code === "auth-code", "valid callback not accepted");
});

Deno.test("OAuth callback rejects a mismatched state before returning code", () => {
  assertThrows(
    () => parseOAuthReturn(
      "kabumori-social://oauth-callback?code=auth-code&state=attacker-state",
      "kabumori-social://oauth-callback",
      "expected-state",
    ),
    "OAUTH_STATE_MISMATCH",
  );
});

Deno.test("OAuth callback rejects a different scheme, host, or path", () => {
  assertThrows(
    () => parseOAuthReturn(
      "https://attacker.example/oauth-callback?code=auth-code&state=expected-state",
      "kabumori-social://oauth-callback",
      "expected-state",
    ),
    "OAUTH_CALLBACK_REDIRECT_MISMATCH",
  );
});

Deno.test("X authorization denial becomes a cancelled state only after state validation", () => {
  const result = parseOAuthReturn(
    "kabumori-social://oauth-callback?error=access_denied&state=expected-state",
    "kabumori-social://oauth-callback",
    "expected-state",
  );
  assert(result.kind === "cancelled", "user denial not surfaced as cancellation");
  assertThrows(
    () => parseOAuthReturn(
      "kabumori-social://oauth-callback?error=access_denied&state=other-state",
      "kabumori-social://oauth-callback",
      "expected-state",
    ),
    "OAUTH_STATE_MISMATCH",
  );
});

Deno.test("OAuth callback rejects provider errors and missing authorization code", () => {
  assertThrows(
    () => parseOAuthReturn(
      "kabumori-social://oauth-callback?error=server_error&state=expected-state",
      "kabumori-social://oauth-callback",
      "expected-state",
    ),
    "OAUTH_PROVIDER_RETURNED_ERROR",
  );
  assertThrows(
    () => parseOAuthReturn(
      "kabumori-social://oauth-callback?state=expected-state",
      "kabumori-social://oauth-callback",
      "expected-state",
    ),
    "OAUTH_CALLBACK_CODE_MISSING",
  );
});

Deno.test("PKCE state bytes are hex encoded and SHA-256 output becomes base64url", () => {
  assert(bytesToHex(new Uint8Array([0, 15, 16, 255])) === "000f10ff", "state encoding mismatch");
  assert(base64ToBase64Url("ab+c/==") === "ab-c_", "PKCE base64url encoding mismatch");
});

Deno.test("OAuth retryable failures are limited to network, rate limit, and server errors", () => {
  assert(isRetryableOAuthError({ name: "FunctionsFetchError" }), "network failure should retry");
  assert(isRetryableOAuthError({ context: { status: 502 } }), "gateway failure should retry");
  assert(isRetryableOAuthError({ status: 429 }), "rate limit should retry");
  assert(!isRetryableOAuthError({ context: { status: 401 } }), "auth failure must be terminal");
  assert(!isRetryableOAuthError(new Error("unknown")), "unknown failure must fail closed");
});

Deno.test("first-user RPC uses an explicit membership primary-key conflict target", async () => {
  const migration = await Deno.readTextFile(
    "supabase/migrations/20260919120000_social_mobile_x_oauth_onboarding.sql",
  );
  assert(
    migration.includes("on conflict on constraint brand_memberships_pkey do nothing"),
    "PL/pgSQL output-variable ambiguity regression",
  );
  for (const rpc of [
    "begin_social_mobile_x_oauth_connection",
    "consume_social_mobile_x_oauth_state",
    "complete_social_mobile_x_oauth_connection",
  ]) {
    assert(
      migration.includes(`revoke all on function public.${rpc}(`) &&
        migration.includes(`from public, anon, service_role;`),
      `${rpc} must be unavailable to public/anon/service_role`,
    );
  }
});
