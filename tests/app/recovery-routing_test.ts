// Regression for the 2026-09-24 real-device E2E failure: a recovery link reached the app as
// `kabumori://reset-password…` and expo-router showed "Unmatched Route" because no route matched,
// so the recovery screen never mounted.
import assert from "node:assert/strict";
import test from "node:test";

import { parseRecoveryLink, recoveryRedirectPath } from "../../src/lib/password-recovery.ts";

const RECOVERY_LINKS = [
  // implicit flow, as delivered on the device
  "kabumori://reset-password#access_token=at&refresh_token=rt&type=recovery",
  // PKCE
  "kabumori://reset-password?code=c1",
  // token-hash template, off the recovery path
  "kabumori://callback?token_hash=th&type=recovery",
  // expired link: must still reach the recovery screen so its error message is shown
  "kabumori://reset-password#error=access_denied&error_code=otp_expired",
  // bare path forms expo-router may pass
  "/reset-password#access_token=at&refresh_token=rt&type=recovery",
  "reset-password?code=c1",
  "/reset-password",
  "exp://127.0.0.1:8081/--/reset-password?code=c1",
  "/--/reset-password?code=c1",
];

test("every recovery link shape is routed to / instead of an unmatched route", () => {
  for (const link of RECOVERY_LINKS) {
    assert.equal(recoveryRedirectPath(link), "/", link);
  }
});

test("the rewrite does not consume the recovery information the screen needs", () => {
  // The router only receives '/', but the recovery hook parses the original URL, which must still
  // classify as a recovery link with its credentials intact.
  const original = RECOVERY_LINKS[0];
  assert.equal(recoveryRedirectPath(original), "/");
  assert.deepEqual(parseRecoveryLink(original), {
    kind: "tokens",
    accessToken: "at",
    refreshToken: "rt",
  });
});

test("other links, including unknown ones, pass through unchanged", () => {
  for (const path of [
    "kabumori://news/abc",
    "kabumori://reports/123",
    "kabumori://",
    "/news/abc",
    "/",
    "kabumori://does-not-exist",
    "/does-not-exist",
    "kabumori-social://oauth-callback?code=xyz&state=s",
    "https://example.com/reset",
    "https://example.com/reset-password?code=not-our-link",
    "kabumori://reset-password-help?code=not-recovery",
    "kabumori://news/reset-password-guide?code=not-recovery",
    "/news/reset-password-guide",
    "kabumori://news/abc?type=recovery",
    "kabumori://news/abc?type=recovery&code=not-our-link",
  ]) {
    assert.equal(recoveryRedirectPath(path), path, path);
  }
});

test("the native-intent entry point delegates to the tested helper", async () => {
  const source = await Deno.readTextFile(new URL("../../src/app/+native-intent.tsx", import.meta.url));
  assert.match(source, /export function redirectSystemPath\(/);
  assert.match(source, /return recoveryRedirectPath\(path\);/);
});
