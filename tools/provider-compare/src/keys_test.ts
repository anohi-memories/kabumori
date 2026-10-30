import assert from "node:assert/strict";
import test from "node:test";
import { describeKey, envNameFor, readMacKeychain, resolveApiKey } from "./keys.ts";

const env = (values: Record<string, string>) => ({ get: (name: string) => values[name] });

test("the environment variable names are the vendors' standard ones", () => {
  assert.equal(envNameFor("anthropic"), "ANTHROPIC_API_KEY");
  assert.equal(envNameFor("openai"), "OPENAI_API_KEY");
});

test("env wins; the keychain is not even consulted when the variable is set", async () => {
  let asked = false;
  const resolved = await resolveApiKey("anthropic", {
    env: env({ ANTHROPIC_API_KEY: "fake-key-value-1" }),
    keychainService: "svc",
    readKeychain: () => { asked = true; return Promise.resolve("other"); },
  });
  assert.deepEqual(resolved, { key: "fake-key-value-1", source: "env" });
  assert.equal(asked, false);
});

test("the keychain is read only when a service name was given explicitly", async () => {
  let asked: string | null = null;
  const reader = (service: string) => { asked = service; return Promise.resolve("kc-fake-key"); };
  assert.equal(await resolveApiKey("anthropic", { env: env({}), readKeychain: reader }), null);
  assert.equal(asked, null);
  const resolved = await resolveApiKey("anthropic", { env: env({}), keychainService: "my-service", readKeychain: reader });
  assert.deepEqual(resolved, { key: "kc-fake-key", source: "keychain" });
  assert.equal(asked, "my-service");
});

test("blank values count as absent", async () => {
  assert.equal(await resolveApiKey("openai", { env: env({ OPENAI_API_KEY: "   " }) }), null);
});

test("describeKey exposes presence and source but never any part of the value", () => {
  const description = describeKey({ key: "super-secret-value", source: "env" });
  assert.deepEqual(description, { present: true, source: "env" });
  assert.ok(!JSON.stringify(description).includes("secret"));
  assert.deepEqual(describeKey(null), { present: false, source: null });
});

test("a keychain service name that is not a plain identifier is rejected before any process is started", async () => {
  for (const bad of ["", "a b", "x; rm -rf /", "$(id)", "../x", "a".repeat(81)]) {
    assert.equal(await readMacKeychain(bad), null, JSON.stringify(bad));
  }
});
