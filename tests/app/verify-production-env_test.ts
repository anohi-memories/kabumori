import assert from "node:assert/strict";
import test from "node:test";

import { verifyProductionEnv } from "../../scripts/verify-production-env.mjs";

const VALID = {
  EXPO_PUBLIC_SUPABASE_URL: "https://wsmznyzcvmuitkglfeuj.supabase.co",
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  EXPO_PUBLIC_KABUMORI_WEB_URL: "https://kabumori.example.com",
};

const legacyAnonPayload = btoa(JSON.stringify({ role: "anon" }))
  .replace(/=/g, "")
  .replace(/\+/g, "-")
  .replace(/\//g, "_");
const LEGACY_ANON_KEY = `e30.${legacyAnonPayload}.signature`;

test("no problems when every value is set and well-formed", () => {
  assert.deepEqual(verifyProductionEnv(VALID), []);
});

test("each missing value is reported by name", () => {
  for (const key of Object.keys(VALID)) {
    const problems = verifyProductionEnv({ ...VALID, [key]: undefined });
    assert.ok(problems.some((problem) => problem.startsWith(key)), problems.join(" / "));
  }
});

test("a malformed Supabase URL is rejected, not just an empty one", () => {
  const problems = verifyProductionEnv({ ...VALID, EXPO_PUBLIC_SUPABASE_URL: "not-a-url" });
  assert.ok(problems.some((problem) => problem.startsWith("EXPO_PUBLIC_SUPABASE_URL")));
});

test("a long arbitrary key string is rejected", () => {
  const problems = verifyProductionEnv({
    ...VALID,
    EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "this-is-not-a-supabase-key-but-is-long-enough",
  });
  assert.ok(problems.some((problem) => problem.startsWith("EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY")));
});

test("a legacy anon JWT remains accepted", () => {
  assert.deepEqual(
    verifyProductionEnv({ ...VALID, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: LEGACY_ANON_KEY }),
    [],
  );
});

test("secret keys and service_role JWTs are rejected", () => {
  const secretKey = verifyProductionEnv({
    ...VALID,
    EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_secret_aaaaaaaaaaaaaaaaaaaaaaaa",
  });
  const serviceRolePayload = btoa(JSON.stringify({ role: "service_role" }))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  const serviceRoleJwt = verifyProductionEnv({
    ...VALID,
    EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: `e30.${serviceRolePayload}.signature`,
  });

  assert.ok(secretKey.some((problem) => problem.startsWith("EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY")));
  assert.ok(serviceRoleJwt.some((problem) => problem.startsWith("EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY")));
});

test("a web URL with a path is rejected the same way an empty one is", () => {
  const withPath = verifyProductionEnv({ ...VALID, EXPO_PUBLIC_KABUMORI_WEB_URL: "https://kabumori.example.com/privacy" });
  const empty = verifyProductionEnv({ ...VALID, EXPO_PUBLIC_KABUMORI_WEB_URL: "" });
  assert.equal(withPath.length, 1);
  assert.equal(empty.length, 1);
});

test("an empty environment reports all three problems", () => {
  assert.equal(verifyProductionEnv({}).length, 3);
});
