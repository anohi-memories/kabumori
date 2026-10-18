// MOCK_ONLY: in-memory credential sources; G4's real source does not exist yet (Issue #131).
import assert from "node:assert/strict";
import test from "node:test";
import { generationSourceOf, generationSourceViolations, oneShotCredentialSource, X_GENERATION_CREDENTIALS_NOT_CONNECTED } from "./x_credential_generation.ts";

const GEN_A = "a".repeat(64);
const GEN_B = "b".repeat(64);

test("shipped default is not connected; only an available source WITH credentialFor is accepted", async () => {
  assert.equal(X_GENERATION_CREDENTIALS_NOT_CONNECTED.available, false);
  assert.equal(await X_GENERATION_CREDENTIALS_NOT_CONNECTED.credentialFor("sa_x"), null);
  const good = { available: true, credentialFor: () => Promise.resolve({ token: "t".repeat(20), generation: GEN_A }) };
  assert.equal(generationSourceOf(good), good);
  for (const bad of [null, undefined, {}, { available: true }, { available: "true", credentialFor: good.credentialFor }, { available: true, accessTokenFor: () => Promise.resolve("t".repeat(20)) }]) {
    assert.equal(generationSourceOf(bad), X_GENERATION_CREDENTIALS_NOT_CONNECTED, JSON.stringify(bad));
  }
});

test("the one-shot source answers exactly its token, for exactly its account, once", async () => {
  const one = oneShotCredentialSource("sa_x", "token-0123456789abcdef");
  assert.equal(one.available, true);
  assert.equal(await one.accessTokenFor("sa_other"), null);
  assert.equal(await one.accessTokenFor("sa_x"), "token-0123456789abcdef");
  assert.equal(await one.accessTokenFor("sa_x"), null, "a second send gets nothing");
});

test("G1-G5 contract check: a conforming fake passes; each violation is named", async () => {
  const db = new Map([["sa_a", GEN_A], ["sa_b", GEN_B]]);
  const cases = { connected: ["sa_a", "sa_b"] as const, notConnected: ["sa_gone"], databaseGeneration: (a: string) => Promise.resolve(db.get(a) ?? null) };
  const conforming = { available: true, credentialFor: (a: string) => Promise.resolve(db.has(a) ? { token: `token-of-${a}-0123456789`, generation: db.get(a)! } : null) };
  assert.deepEqual(await generationSourceViolations(conforming, cases), []);
  const stale = { available: true, credentialFor: (a: string) => Promise.resolve(db.has(a) ? { token: `token-of-${a}-0123456789`, generation: GEN_A } : null) };
  assert.deepEqual(await generationSourceViolations(stale, cases), ["G3 sa_b: generation differs from the database"]);
  const shared = { available: true, credentialFor: (a: string) => Promise.resolve(db.has(a) ? { token: "same-token-0123456789", generation: db.get(a)! } : { token: "same-token-0123456789", generation: GEN_A }) };
  assert.deepEqual(await generationSourceViolations(shared, cases), ["G5 two accounts share a token", "G4 sa_gone: answered ANOTHER ACCOUNT'S token"]);
  const noGeneration = { available: false, credentialFor: (a: string) => Promise.resolve(db.has(a) ? { token: `token-of-${a}-0123456789`, generation: "" } : null) };
  assert.deepEqual(await generationSourceViolations(noGeneration, cases), ["G1 available is not true", "G2 sa_a: no valid token + generation", "G2 sa_b: no valid token + generation"]);
  const leaky = { available: true, credentialFor: (a: string) => db.has(a) ? Promise.resolve({ token: `token-of-${a}-0123456789`, generation: db.get(a)! }) : Promise.reject(new Error("token-of-sa_a-0123456789")) };
  assert.deepEqual(await generationSourceViolations(leaky, cases), ["G4 sa_gone: threw", "G5 sa_gone: a token in the error"]);
});
