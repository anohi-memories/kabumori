// MOCK_ONLY test doubles: the contract itself is what is tested (a good double passes, each broken double is caught).
import assert from "node:assert/strict";
import test from "node:test";
import { credentialSourceViolations } from "./x_credential_contract.ts";
import { X_CREDENTIALS_NOT_CONNECTED } from "./x_publisher.ts";

const CASES = { connected: ["sa_a", "sa_b"] as const, notConnected: ["sa_gone", "sa_unknown"] };
const TOKENS: Record<string, string> = { sa_a: "fake-token-a-0123456789", sa_b: "fake-token-b-0123456789" };
const double = (answer: (account: string) => Promise<string | null>, available = true) => ({ available, accessTokenFor: answer });

test("a conforming source passes; the shipped NOT_CONNECTED source is reported as not delivered", async () => {
  assert.deepEqual(await credentialSourceViolations(double((a) => Promise.resolve(TOKENS[a] ?? null)), CASES), []);
  const shipped = await credentialSourceViolations(X_CREDENTIALS_NOT_CONNECTED, CASES);
  assert.ok(shipped.includes("C1 available is not true") && shipped.some((v) => v.startsWith("C2 sa_a")), JSON.stringify(shipped));
});

test("each broken source is caught: another account's token, a shared token, a throw, a token in an error", async () => {
  const leaky = await credentialSourceViolations(double((a) => Promise.resolve(TOKENS[a] ?? TOKENS.sa_a)), CASES);
  assert.ok(leaky.some((v) => v.includes("ANOTHER ACCOUNT'S token")), JSON.stringify(leaky));
  const shared = await credentialSourceViolations(double((a) => Promise.resolve(a in TOKENS ? TOKENS.sa_a : null)), CASES);
  assert.ok(shared.includes("C4 two accounts share a token"), JSON.stringify(shared));
  const throwing = await credentialSourceViolations(double((a) => (a in TOKENS ? Promise.resolve(TOKENS[a]) : Promise.reject(new Error(`no grant (had ${TOKENS.sa_b})`)))), CASES);
  assert.ok(throwing.some((v) => v.startsWith("C3 sa_gone: threw")) && throwing.some((v) => v.startsWith("C5")), JSON.stringify(throwing));
  const malformed = await credentialSourceViolations(double((a) => Promise.resolve(a in TOKENS ? "short" : null)), CASES);
  assert.ok(malformed.some((v) => v.startsWith("C2")), JSON.stringify(malformed));
});
