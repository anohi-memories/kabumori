import assert from "node:assert/strict";
import test from "node:test";
import { assertNoSecrets, REDACTED, redactSecrets, SecretLeakError } from "./redact.ts";

// These strings are obviously fake. They only have the SHAPE of real keys.
const FAKE_ANTHROPIC = "sk-ant-FAKEFAKE0123456789";
const FAKE_OPENAI = "sk-proj-FAKEFAKE0123456789";

test("key-shaped strings are masked even when the key is not known to the caller", () => {
  const text = `failed with ${FAKE_ANTHROPIC} and ${FAKE_OPENAI}`;
  const out = redactSecrets(text);
  assert.ok(!out.includes("FAKEFAKE"));
  assert.equal(out, `failed with ${REDACTED} and ${REDACTED}`);
});

test("Authorization and x-api-key header text is masked", () => {
  assert.equal(redactSecrets("Authorization: Bearer abcDEF123456789xyz"), `Authorization: Bearer ${REDACTED}`);
  assert.equal(redactSecrets('x-api-key: "abcDEF123456789"'), `x-api-key: "${REDACTED}"`);
});

test("known secrets are removed wherever they appear, including non-standard formats", () => {
  const secret = "custom-token-value-123";
  assert.equal(redactSecrets(`a ${secret} b ${secret}`, [secret]), `a ${REDACTED} b ${REDACTED}`);
});

test("very short 'secrets' are ignored so ordinary words are not erased", () => {
  assert.equal(redactSecrets("hello world", ["he"]), "hello world");
});

test("assertNoSecrets throws SecretLeakError without echoing the secret", () => {
  assert.throws(() => assertNoSecrets(JSON.stringify({ error: FAKE_ANTHROPIC })), SecretLeakError);
  try {
    assertNoSecrets(`x ${FAKE_OPENAI}`);
    assert.fail("should have thrown");
  } catch (error) {
    assert.ok(error instanceof SecretLeakError);
    assert.ok(!String((error as Error).message).includes("FAKE"));
  }
  assert.doesNotThrow(() => assertNoSecrets(JSON.stringify({ ok: true, text: "plain news text" })));
  assert.throws(() => assertNoSecrets("has unusual-secret-9999 inside", ["unusual-secret-9999"]), SecretLeakError);
});
