// Key resolution and redaction (part of required test 27): only the documented environment variable is read, a
// missing / malformed / Admin key is refused without echoing it, and the key object never prints its value.
import assert from "node:assert/strict";
import test from "node:test";
import { redactSecrets, safeToken } from "./redact.ts";
import { PROVIDER_API_KEY_ENV, resolveProviderApiKey } from "./secrets.ts";
import { FAKE_ANTHROPIC_KEY, FAKE_OPENAI_KEY, fakeEnv } from "./test_support.ts";

test("each provider reads exactly one environment variable", () => {
  assert.deepEqual(PROVIDER_API_KEY_ENV, { openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY" });
  const env = fakeEnv();
  const resolved = resolveProviderApiKey("anthropic", env.readEnv);
  assert.ok(resolved.ok);
  assert.deepEqual(env.reads, ["ANTHROPIC_API_KEY"]);
  assert.equal(resolved.key.reveal(), FAKE_ANTHROPIC_KEY);
});

test("missing, empty, malformed and Admin keys are refused; the reason never contains the value", () => {
  const cases: Array<[Record<string, string | undefined>, string]> = [
    [{}, "KEY_MISSING"],
    [{ ANTHROPIC_API_KEY: "   " }, "KEY_MISSING"],
    [{ ANTHROPIC_API_KEY: "Xq7-tiny" }, "KEY_INVALID"],
    [{ ANTHROPIC_API_KEY: "has space inside the key value 123" }, "KEY_INVALID"],
    [{ ANTHROPIC_API_KEY: "control\u0007character-in-the-key-value" }, "KEY_INVALID"],
    [{ ANTHROPIC_API_KEY: "sk-ant-admin01-FAKE-not-a-real-admin-key" }, "KEY_INVALID"],
  ];
  for (const [values, code] of cases) {
    const resolved = resolveProviderApiKey("anthropic", fakeEnv(values).readEnv);
    assert.equal(resolved.ok, false);
    if (resolved.ok) continue;
    assert.equal(resolved.code, code);
    for (const value of Object.values(values)) {
      if (value && value.trim()) assert.ok(!JSON.stringify(resolved).includes(value.trim()));
    }
  }
  const throwing = resolveProviderApiKey("openai", () => {
    throw new Error("env denied");
  });
  assert.equal(throwing.ok, false);
});

test("27. the key object redacts itself in strings, JSON and inspection", () => {
  const resolved = resolveProviderApiKey("openai", fakeEnv().readEnv);
  assert.ok(resolved.ok);
  const key = resolved.key;
  for (const rendered of [String(key), `${key}`, JSON.stringify({ key }), Deno.inspect(key), Deno.inspect({ nested: key })]) {
    assert.ok(!rendered.includes(FAKE_OPENAI_KEY), rendered);
  }
  assert.ok(!Object.keys(key).some((name) => String((key as unknown as Record<string, unknown>)[name]).includes(FAKE_OPENAI_KEY)));
});

test("redaction removes credential-shaped text; safeToken keeps only a short identifier alphabet", () => {
  const text = "auth Bearer abcdef123456 key sk-ant-api03-ABCDEFGH and sk-proj-ABCDEFGHIJKLMNOP x-api-key: zzz eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl";
  const redacted = redactSecrets(text);
  for (const fragment of ["abcdef123456", "sk-ant-api03", "sk-proj-ABCDEFGHIJKLMNOP", "zzz", "eyJhbGciOi"]) assert.ok(!redacted.includes(fragment), fragment);
  assert.equal(safeToken("rate_limit_error"), "rate_limit_error");
  assert.equal(safeToken("bad value\nwith <html>"), "bad_value_with__html_");
  assert.equal(safeToken(""), null);
  assert.equal(safeToken(42), null);
  assert.ok(!(safeToken("sk-ant-api03-SECRETSECRET") ?? "").includes("SECRET"));
});
