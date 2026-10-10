import assert from "node:assert/strict";
import test from "node:test";
import {
  beginRpcPayload,
  classifyThreadsCleanup,
  completeRpcPayload,
  consumeRpcPayload,
  PROVIDER_CLEANUP_RESULTS,
  T13_REFUSAL_CODES,
  THREADS_CONNECT_ATTESTATION_VAULT_NAME,
  THREADS_CONNECT_RPC,
  THREADS_CONNECT_RPC_REFUSAL_CODES,
  THREADS_OAUTH_STATE_MAX_TTL_MS,
  THREADS_REMOTE_REVOKE_AVAILABLE,
  threadsConnectAttestation,
  type ThreadsConnectAttested,
  ThreadsConnectRpcInputError,
  type ThreadsLocalCleanupFacts,
} from "./threads_connect_rpc_contract.ts";

// Fake values only; the key is the TEST-ONLY one of supabase/tests/postona_threads_oauth_test_fixture.sql.
const KEY = "fake_attestation_key_0123456789abcdef0123456789abcdef";
const HASH = "a".repeat(64);
const NOW = new Date("2026-10-10T00:00:00.000Z");
const BASE: ThreadsConnectAttested = {
  oauthStateId: "00000000-0000-4000-8000-0000000000aa",
  providerUserId: "17841400000000001",
  handle: "postona.test",
  accessToken: "fakeTHREADSaccessTOKEN0001",
};
const supabaseDir = new URL("../../../", import.meta.url);
const candidateSql = () => Deno.readTextFile(new URL("candidates/postona_threads_oauth_workspace_candidate.sql", supabaseDir));

function inputError(code: ThreadsConnectRpcInputError["code"]) {
  return (error: unknown) => error instanceof ThreadsConnectRpcInputError && error.code === code && error.message === code;
}

test("RPC names are the candidate's three public functions", async () => {
  const sql = await candidateSql();
  for (const name of Object.values(THREADS_CONNECT_RPC)) {
    assert.match(sql, new RegExp(`^create function public\\.${name}\\(`, "m"));
  }
  assert.equal(Object.keys(THREADS_CONNECT_RPC).length, 3);
});

test("begin payload: the shape the candidate accepts, refused before any call otherwise", () => {
  const ok = beginRpcPayload({ stateHash: HASH, redirectUri: "https://app.postona.test/cb", expiresAt: new Date(NOW.getTime() + 300_000), now: NOW });
  assert.deepEqual(ok, { p_state_hash: HASH, p_redirect_uri: "https://app.postona.test/cb", p_expires_at: "2026-10-10T00:05:00.000Z" });
  const atLimit = new Date(NOW.getTime() + THREADS_OAUTH_STATE_MAX_TTL_MS);
  assert.equal(beginRpcPayload({ stateHash: HASH, redirectUri: "https://a.test/" + "p".repeat(2033), expiresAt: atLimit, now: NOW }).p_expires_at,
    "2026-10-10T00:10:00.000Z");
  for (const stateHash of ["A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64), ""]) {
    assert.throws(() => beginRpcPayload({ stateHash, redirectUri: "https://a.test/cb", expiresAt: atLimit, now: NOW }), inputError("STATE_HASH_INVALID"));
  }
  for (const redirectUri of ["http://a.test/cb", "https://a.test/cb#f", "https://u@a.test/cb", "https://a.test/c b", "https://*.a.test/cb",
                             "kabumori-social://oauth-callback", "https://a.test/" + "p".repeat(2034), "https://"]) {
    assert.throws(() => beginRpcPayload({ stateHash: HASH, redirectUri, expiresAt: atLimit, now: NOW }), inputError("REDIRECT_URI_INVALID"));
  }
  for (const offset of [0, -1, THREADS_OAUTH_STATE_MAX_TTL_MS + 1, Number.NaN]) {
    assert.throws(() => beginRpcPayload({ stateHash: HASH, redirectUri: "https://a.test/cb", expiresAt: new Date(NOW.getTime() + offset), now: NOW }),
      inputError("EXPIRY_INVALID"));
  }
});

test("consume payload carries only a well-formed state hash", () => {
  assert.deepEqual(consumeRpcPayload(HASH), { p_state_hash: HASH });
  assert.throws(() => consumeRpcPayload(HASH.toUpperCase()), inputError("STATE_HASH_INVALID"));
});

test("attestation: the candidate's known answers (shared with postona_threads_oauth_behavior.sql)", async () => {
  assert.equal(await threadsConnectAttestation(KEY, BASE), "f13d6e3ec49ed569b7d63ba2c565136b9d5bcd39eeedf60b032c88cb564e60a9");
  assert.equal(await threadsConnectAttestation(KEY, { ...BASE, handle: null }), "04722f619c1cca7ca60ec8c804a30253016ddb21f7a9a950b5462fefbf3859cd");
  assert.equal(THREADS_CONNECT_ATTESTATION_VAULT_NAME, "postona_threads_connect_attestation_v1");
  const sql = await candidateSql();
  assert.match(sql, /where d\.name = 'postona_threads_connect_attestation_v1'/);
  assert.match(sql, /'postona-threads-connect-v1', p_oauth_state_id::text,\s+p_platform_user_id, coalesce\(p_handle, ''\),/);
});

test("attestation binds every field and the key", async () => {
  const reference = await threadsConnectAttestation(KEY, BASE);
  const variants: ThreadsConnectAttested[] = [
    { ...BASE, oauthStateId: "00000000-0000-4000-8000-0000000000ab" },
    { ...BASE, providerUserId: "17841400000000002" },
    { ...BASE, handle: "postona.tesT" },
    { ...BASE, handle: null },
    { ...BASE, accessToken: BASE.accessToken + "x" },
  ];
  const outputs = new Set([reference, ...(await Promise.all(variants.map((v) => threadsConnectAttestation(KEY, v))))]);
  assert.equal(outputs.size, variants.length + 1);
  assert.notEqual(await threadsConnectAttestation(KEY + "!", BASE), reference);
  assert.match(reference, /^[0-9a-f]{64}$/);
});

test("attestation refuses what the candidate refuses, before computing anything", async () => {
  await assert.rejects(threadsConnectAttestation("k".repeat(31), BASE), inputError("KEY_INVALID"));
  // The candidate attests the canonical (lower-case) uuid text; anything else could never match.
  for (const oauthStateId of [BASE.oauthStateId.toUpperCase(), "not-a-uuid", "00000000000040008000000000000000aa"]) {
    await assert.rejects(threadsConnectAttestation(KEY, { ...BASE, oauthStateId }), inputError("STATE_ID_INVALID"));
  }
  for (const providerUserId of ["0178414", "1784a", "1" + "7".repeat(32), ""]) {
    await assert.rejects(threadsConnectAttestation(KEY, { ...BASE, providerUserId }), inputError("IDENTITY_INVALID"));
  }
  for (const handle of ["@postona", "h".repeat(31), "", "post ona"]) {
    await assert.rejects(threadsConnectAttestation(KEY, { ...BASE, handle }), inputError("IDENTITY_INVALID"));
  }
  for (const accessToken of ["shortTOKEN15chr", "fake THREADS token", "fakeTHREADSaccessTOKEN\n", "t".repeat(4097)]) {
    await assert.rejects(threadsConnectAttestation(KEY, { ...BASE, accessToken }), inputError("TOKEN_INVALID"));
  }
  assert.match(await threadsConnectAttestation(KEY, { ...BASE, providerUserId: "1" + "7".repeat(31), handle: "h".repeat(30), accessToken: "t".repeat(4096) }),
    /^[0-9a-f]{64}$/);
  assert.match(await threadsConnectAttestation(KEY, { ...BASE, accessToken: "t".repeat(16) }), /^[0-9a-f]{64}$/);
});

test("complete payload: the attested fields, unchanged, with their attestation", async () => {
  const payload = await completeRpcPayload(KEY, BASE);
  assert.deepEqual(payload, {
    p_oauth_state_id: BASE.oauthStateId,
    p_platform_user_id: BASE.providerUserId,
    p_handle: BASE.handle,
    p_access_token: BASE.accessToken,
    p_attestation: "f13d6e3ec49ed569b7d63ba2c565136b9d5bcd39eeedf60b032c88cb564e60a9",
  });
  await assert.rejects(completeRpcPayload(KEY, { ...BASE, accessToken: "x" }), inputError("TOKEN_INVALID"));
});

test("refusal codes are exactly the candidate's own and the guard's", async () => {
  const sql = await candidateSql();
  const raised = new Set([...sql.matchAll(/raise exception '([A-Z0-9_]+)'/g)].map((m) => m[1]).filter((c) => !c.startsWith("POSTONA_THREADS_OAUTH_")));
  assert.deepEqual([...raised].sort(), [...THREADS_CONNECT_RPC_REFUSAL_CODES].sort());
  const guard = await Deno.readTextFile(new URL("tests/postona_threads_oauth_mock_t13_fixture.sql", supabaseDir));
  const guardCodes = new Set([...guard.matchAll(/raise exception '([A-Z0-9_]+)'/g)].map((m) => m[1]));
  // The stand-in raises exactly the agreed codes (G5's guard adds a session check under the same AUTH code).
  assert.deepEqual([...guardCodes].sort(), [...T13_REFUSAL_CODES].sort());
  assert.equal(new Set([...T13_REFUSAL_CODES, ...THREADS_CONNECT_RPC_REFUSAL_CODES]).size,
    T13_REFUSAL_CODES.length + THREADS_CONNECT_RPC_REFUSAL_CODES.length);
});

test("T10 Threads cleanup is truthful: never confirmed remote revocation without a revoke endpoint", () => {
  assert.equal(THREADS_REMOTE_REVOKE_AVAILABLE, false);
  assert.deepEqual([...PROVIDER_CLEANUP_RESULTS], ["confirmed_remote_revoked", "local_removed_remote_unverified", "reconciliation_required", "blocked"]);
  const results = new Map<string, string>();
  for (const secretSharedWithAnotherRow of [false, true]) {
    for (const vaultDelete of ["confirmed", "failed", "unknown", "not_needed"] as const) {
      for (const readBackClean of [false, true]) {
        const facts: ThreadsLocalCleanupFacts = { secretSharedWithAnotherRow, vaultDelete, readBackClean };
        results.set(`${secretSharedWithAnotherRow}/${vaultDelete}/${readBackClean}`, classifyThreadsCleanup(facts));
      }
    }
  }
  for (const [facts, result] of results) {
    assert.notEqual(result, "confirmed_remote_revoked", facts);
    const [shared, vault, clean] = facts.split("/");
    const expected = shared === "true"
      ? "blocked"
      : vault === "failed" || vault === "unknown" || clean === "false"
      ? "reconciliation_required"
      : "local_removed_remote_unverified";
    assert.equal(result, expected, facts);
  }
});

test("isolation: the module imports nothing and nothing imports it", async () => {
  const source = await Deno.readTextFile(new URL("./threads_connect_rpc_contract.ts", import.meta.url));
  assert.deepEqual([...source.matchAll(/^\s*(import|export) .+ from /gm)], []);
  assert.doesNotMatch(source, /\bfetch\(|Deno\.env|createClient/);
  const importers: string[] = [];
  const walk = async (dir: URL): Promise<void> => {
    for await (const entry of Deno.readDir(dir)) {
      const child = new URL(entry.name + (entry.isDirectory ? "/" : ""), dir);
      if (entry.isDirectory) await walk(child);
      else if (/\.(ts|tsx|mjs|js)$/.test(entry.name) && !entry.name.startsWith("threads_connect_rpc_contract")) {
        if ((await Deno.readTextFile(child)).includes("threads_connect_rpc_contract")) importers.push(child.pathname);
      }
    }
  };
  await walk(new URL("functions/", supabaseDir));
  assert.deepEqual(importers, []);
});
