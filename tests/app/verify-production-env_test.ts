import assert from "node:assert/strict";
import test from "node:test";

import { verifyProductionEnv } from "../../scripts/verify-production-env.mjs";

const VALID = {
  EXPO_PUBLIC_SUPABASE_URL: "https://wsmznyzcvmuitkglfeuj.supabase.co",
  EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  EXPO_PUBLIC_KABUMORI_WEB_URL: "https://kabumori.example.com",
};

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

test("a placeholder-looking key is rejected", () => {
  const problems = verifyProductionEnv({ ...VALID, EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "x" });
  assert.ok(problems.some((problem) => problem.startsWith("EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY")));
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
