import assert from "node:assert/strict";
import test from "node:test";
import { g3CredentialGeneration, xGenerationSourceFromG4Raw } from "./credential_generation_derivation.ts";
import { X_GENERATION_CREDENTIALS_NOT_CONNECTED } from "./x_credential_generation.ts";

// Vectors computed outside Deno (Python hashlib.sha256 over the same UTF-8 text); the database side is compared in
// supabase/candidates/postona_x_reservations/g4_verdict_run.sh phase VW (x_credential_generation / threads_credential_generation).
const X1 = "9f6518a85c52100cc3f008207149fab7139bf3985ac304dd32638ff7e71b269b"; // 'g3x1|g4x1:1'
const X42 = "e9346508745d665152b690ac3141adf252b004bb145dc5dff5c69fefe6fec111"; // 'g3x1|g4x1:42'
const T49 = "1e0a180ec934548d095d9baf77d8727205906b2b16112d38c8192fd9bf19b6c3"; // 'g3t1|g4t1:00000000-0000-4000-8000-000000000049'
const STATE = "00000000-0000-4000-8000-000000000049";

test("D1 X / Threads: sha256 hex of the G3 prefix || G4's generation, as the database", async () => {
  assert.equal(await g3CredentialGeneration("x", "g4x1:1"), X1);
  assert.equal(await g3CredentialGeneration("x", "g4x1:42"), X42);
  assert.equal(await g3CredentialGeneration("threads", `g4t1:${STATE}`), T49);
});

test("D2 the platforms never share a value: a G4 value of the other platform, or any other shape, is null", async () => {
  assert.equal(await g3CredentialGeneration("x", `g4t1:${STATE}`), null);
  assert.equal(await g3CredentialGeneration("threads", "g4x1:1"), null);
  for (const bad of [null, undefined, 1, "", "g4x1:", "g4x1:-1", "g4x1:1 ", " g4x1:1", "g4x1:01x", "g4x1:12345678901234567890", "G4X1:1",
    "g4t1:ABCDEF00-0000-4000-8000-000000000049", `g4t1:${STATE}0`, "g3x1|g4x1:1", X1]) {
    assert.equal(await g3CredentialGeneration("x", bad), null, String(bad));
    assert.equal(await g3CredentialGeneration("threads", bad), null, String(bad));
  }
  assert.equal(await g3CredentialGeneration("bluesky" as "x", "g4x1:1"), null);
});

test("D3 the X adapter: one G4 read -> { token, G3's generation }; anything doubtful -> null, never thrown", async () => {
  const reads: string[] = [];
  let answer: unknown = { token: "fake-x-token-0123456789", g4Generation: "g4x1:42" };
  const source = xGenerationSourceFromG4Raw({
    available: true,
    credentialFor(account: string) {
      reads.push(account);
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve(answer);
    },
  });
  assert.equal(source.available, true);
  assert.deepEqual(await source.credentialFor("acct-1"), { token: "fake-x-token-0123456789", generation: X42 });
  assert.deepEqual(reads, ["acct-1"]);
  for (const bad of [null, {}, { token: "short", g4Generation: "g4x1:42" }, { token: "fake-x-token-0123456789", g4Generation: `g4t1:${STATE}` },
    { token: "fake-x-token-0123456789", g4Generation: X42 }, { token: "fake-x-token-0123456789" }, { token: "fake x token 0123456789", g4Generation: "g4x1:1" },
    new Error("fake-x-token-0123456789")]) {
    answer = bad;
    assert.equal(await source.credentialFor("acct-1"), null);
  }
  assert.equal(reads.length, 9); // one read per lookup, nothing cached
});

test("D4 a source that is not exactly available with credentialFor stays not connected", () => {
  for (const s of [null, undefined, {}, { available: "true", credentialFor: () => null }, { available: true }, { available: false, credentialFor: () => null }]) {
    assert.equal(xGenerationSourceFromG4Raw(s), X_GENERATION_CREDENTIALS_NOT_CONNECTED);
  }
});
