import assert from "node:assert/strict";
import test from "node:test";
import {
  beginRpcPayload,
  completeRpcPayload,
  consumeRpcPayload,
  X_CONNECT_ATTESTATION_VAULT_NAME,
  X_CONNECT_RPC_LIVE,
  X_CONNECT_RPC_V2,
  X_CONNECT_V2_REFUSAL_CODES,
  X_OAUTH_STATE_MAX_TTL_MS,
  xConnectAttestation,
  type XConnectAttested,
  XConnectRpcInputError,
} from "./x_connect_rpc_contract.ts";

// Fake values only; the key is the TEST-ONLY one of supabase/tests/postona_x_oauth_hardening_test_fixture.sql.
const KEY = "fake_x_attestation_key_0123456789abcdef0123456789ab";
const HASH = "b".repeat(64);
const NOW = new Date("2026-10-10T00:00:00.000Z");
const BASE: XConnectAttested = {
  oauthStateId: "00000000-0000-4000-8000-0000000000bb",
  xUserId: "1700000000000000001",
  username: "Postona_X",
  accessToken: "fakeXaccessTOKEN000000000001",
  refreshToken: "fakeXrefreshTOKEN00000000001",
};
const KAT = "083859c4e51418d24f3c25cbbf94fb58c0b33279579ba02abf0cf6a8c32e0a4f";
const supabaseDir = new URL("../../../", import.meta.url);
const candidateSql = () => Deno.readTextFile(new URL("candidates/postona_x_oauth_hardening_candidate.sql", supabaseDir));

function inputError(code: XConnectRpcInputError["code"]) {
  return (error: unknown) => error instanceof XConnectRpcInputError && error.code === code && error.message === code;
}

test("v2 RPC names are the candidate's three functions; the live names are the live Edge's", async () => {
  const sql = await candidateSql();
  for (const name of Object.values(X_CONNECT_RPC_V2)) assert.match(sql, new RegExp(`^create function public\\.${name}\\(`, "m"));
  const liveEdge = await Deno.readTextFile(new URL("functions/x-oauth-connect-user/oauth_logic.ts", supabaseDir));
  for (const name of Object.values(X_CONNECT_RPC_LIVE)) assert.match(liveEdge, new RegExp(`name: "${name}"`));
  for (const name of Object.values(X_CONNECT_RPC_V2)) assert.doesNotMatch(liveEdge, new RegExp(name));
});

test("begin payload: the shape v2 accepts (the live Edge's custom-scheme redirect included)", () => {
  const expiresAt = new Date(NOW.getTime() + X_OAUTH_STATE_MAX_TTL_MS);
  assert.deepEqual(beginRpcPayload({ stateHash: HASH, redirectUri: "kabumori-social://oauth-callback", expiresAt, now: NOW }),
    { p_state_hash: HASH, p_redirect_uri: "kabumori-social://oauth-callback", p_expires_at: "2026-10-10T00:10:00.000Z" });
  assert.equal(beginRpcPayload({ stateHash: HASH, redirectUri: "https://app.postona.test/x/" + "p".repeat(2021), expiresAt, now: NOW }).p_redirect_uri.length, 2048);
  for (const stateHash of ["B".repeat(64), "b".repeat(63), ""]) {
    assert.throws(() => beginRpcPayload({ stateHash, redirectUri: "kabumori-social://oauth-callback", expiresAt, now: NOW }), inputError("STATE_HASH_INVALID"));
  }
  for (const redirectUri of ["http://evil.example/cb", "kabumori-social://oauth-callback#f", "https://u@a.test/cb", "kabumori-social://oauth callback",
                             "Kabumori-social://oauth-callback", "kabumori-social:/oauth-callback", "https://a.test/" + "p".repeat(2034)]) {
    assert.throws(() => beginRpcPayload({ stateHash: HASH, redirectUri, expiresAt, now: NOW }), inputError("REDIRECT_URI_INVALID"));
  }
  for (const offset of [0, -1, X_OAUTH_STATE_MAX_TTL_MS + 1, 365 * 24 * 3600 * 1000]) {
    assert.throws(() => beginRpcPayload({ stateHash: HASH, redirectUri: "kabumori-social://oauth-callback", expiresAt: new Date(NOW.getTime() + offset), now: NOW }),
      inputError("EXPIRY_INVALID"));
  }
  assert.deepEqual(consumeRpcPayload(HASH), { p_state_hash: HASH });
  assert.throws(() => consumeRpcPayload(HASH.toUpperCase()), inputError("STATE_HASH_INVALID"));
});

test("attestation: v2's known answer (shared with postona_x_oauth_hardening_behavior.sql)", async () => {
  assert.equal(await xConnectAttestation(KEY, BASE), KAT);
  assert.equal(X_CONNECT_ATTESTATION_VAULT_NAME, "postona_x_connect_attestation_v1");
  const sql = await candidateSql();
  assert.match(sql, /where d\.name = 'postona_x_connect_attestation_v1'/);
  assert.match(sql, /'postona-x-connect-v1', p_oauth_state_id::text,\s+p_platform_user_id, p_handle,/);
});

test("attestation binds every field and the key", async () => {
  const variants: XConnectAttested[] = [
    { ...BASE, oauthStateId: "00000000-0000-4000-8000-0000000000bc" },
    { ...BASE, xUserId: "1700000000000000002" },
    { ...BASE, username: "postona_x" },
    { ...BASE, accessToken: BASE.accessToken + "x" },
    { ...BASE, refreshToken: BASE.refreshToken + "x" },
    { ...BASE, accessToken: BASE.refreshToken, refreshToken: BASE.accessToken },
  ];
  const outputs = new Set([KAT, ...(await Promise.all(variants.map((v) => xConnectAttestation(KEY, v))))]);
  assert.equal(outputs.size, variants.length + 1);
  assert.notEqual(await xConnectAttestation(KEY + "!", BASE), KAT);
});

test("attestation refuses what v2 refuses, before computing anything", async () => {
  await assert.rejects(xConnectAttestation("k".repeat(31), BASE), inputError("KEY_INVALID"));
  for (const oauthStateId of [BASE.oauthStateId.toUpperCase(), "not-a-uuid"]) {
    await assert.rejects(xConnectAttestation(KEY, { ...BASE, oauthStateId }), inputError("STATE_ID_INVALID"));
  }
  for (const xUserId of ["01700000000000000101", "17000x", "1" + "0".repeat(20), ""]) {
    await assert.rejects(xConnectAttestation(KEY, { ...BASE, xUserId }), inputError("IDENTITY_INVALID"));
  }
  for (const username of ["@Postona_X", "Postona_A_toolong", "", "post-ona"]) {
    await assert.rejects(xConnectAttestation(KEY, { ...BASE, username }), inputError("IDENTITY_INVALID"));
  }
  for (const tokens of [{ accessToken: "shortXtoken0015" }, { accessToken: "fakeX access TOKEN0001" }, { refreshToken: "fakeXrefresh\nTOKEN0001" },
                        { refreshToken: "r".repeat(4097) }, { refreshToken: BASE.accessToken }]) {
    await assert.rejects(xConnectAttestation(KEY, { ...BASE, ...tokens }), inputError("TOKEN_INVALID"));
  }
  assert.match(await xConnectAttestation(KEY, { ...BASE, xUserId: "1" + "0".repeat(19), username: "a".repeat(15), refreshToken: "r".repeat(4096) }),
    /^[0-9a-f]{64}$/);
});

test("complete payload: the attested fields, unchanged, with their attestation", async () => {
  assert.deepEqual(await completeRpcPayload(KEY, BASE), {
    p_oauth_state_id: BASE.oauthStateId,
    p_platform_user_id: BASE.xUserId,
    p_handle: BASE.username,
    p_access_token: BASE.accessToken,
    p_refresh_token: BASE.refreshToken,
    p_attestation: KAT,
  });
});

test("refusal codes are exactly the candidate's own", async () => {
  const sql = await candidateSql();
  const raised = new Set([...sql.matchAll(/raise exception '([A-Z0-9_]+)'/g)].map((m) => m[1]).filter((c) => !c.startsWith("POSTONA_X_OAUTH_")));
  assert.deepEqual([...raised].sort(), [...X_CONNECT_V2_REFUSAL_CODES].sort());
});

test("isolation: the module imports nothing and nothing imports it", async () => {
  const source = await Deno.readTextFile(new URL("./x_connect_rpc_contract.ts", import.meta.url));
  assert.deepEqual([...source.matchAll(/^\s*(import|export) .+ from /gm)], []);
  assert.doesNotMatch(source, /\bfetch\(|Deno\.env|createClient/);
  const importers: string[] = [];
  const walk = async (dir: URL): Promise<void> => {
    for await (const entry of Deno.readDir(dir)) {
      const child = new URL(entry.name + (entry.isDirectory ? "/" : ""), dir);
      if (entry.isDirectory) await walk(child);
      else if (/\.(ts|tsx|mjs|js)$/.test(entry.name) && !entry.name.startsWith("x_connect_rpc_contract")) {
        if ((await Deno.readTextFile(child)).includes("x_connect_rpc_contract")) importers.push(child.pathname);
      }
    }
  };
  await walk(new URL("functions/", supabaseDir));
  assert.deepEqual(importers, []);
});
