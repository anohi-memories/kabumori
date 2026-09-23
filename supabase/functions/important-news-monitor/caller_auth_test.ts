import assert from "node:assert/strict";
import test from "node:test";
import {
  importantNewsCronSecretHeader,
  isConfiguredImportantNewsCronSecret,
  isValidImportantNewsCronSecret,
} from "./caller_auth.ts";

const secret = "A".repeat(43);

test("accepts only the configured 256-bit base64url secret", () => {
  const request = new Request("https://example.test/functions/v1/important-news-monitor", {
    headers: { "x-important-news-cron-secret": secret },
  });

  assert.equal(isConfiguredImportantNewsCronSecret(secret), true);
  assert.equal(importantNewsCronSecretHeader(request), secret);
  assert.equal(isValidImportantNewsCronSecret(secret, importantNewsCronSecretHeader(request)), true);
});

test("rejects missing, malformed, and wrong caller credentials", () => {
  const missing = new Request("https://example.test/functions/v1/important-news-monitor");
  const malformed = new Request("https://example.test/functions/v1/important-news-monitor", {
    headers: { "x-important-news-cron-secret": "not-a-cron-secret" },
  });
  const wrong = new Request("https://example.test/functions/v1/important-news-monitor", {
    headers: { "x-important-news-cron-secret": "B".repeat(42) + "Q" },
  });

  assert.equal(importantNewsCronSecretHeader(missing), null);
  assert.equal(isValidImportantNewsCronSecret(secret, importantNewsCronSecretHeader(missing)), false);
  assert.equal(isValidImportantNewsCronSecret(secret, importantNewsCronSecretHeader(malformed)), false);
  assert.equal(isValidImportantNewsCronSecret(secret, importantNewsCronSecretHeader(wrong)), false);
});

test("fails closed when the server secret is missing or not a canonical 32-byte base64url value", () => {
  assert.equal(isConfiguredImportantNewsCronSecret(undefined), false);
  assert.equal(isConfiguredImportantNewsCronSecret("short"), false);
  assert.equal(isConfiguredImportantNewsCronSecret("!".repeat(43)), false);
  assert.equal(isConfiguredImportantNewsCronSecret("A".repeat(42) + "B"), false);
  assert.equal(isValidImportantNewsCronSecret(undefined, secret), false);
  assert.equal(isValidImportantNewsCronSecret(secret, "A".repeat(44)), false);
});
