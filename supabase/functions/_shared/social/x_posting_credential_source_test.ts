// F4 / G4 M1: the server-only X credential source, offline (a fake owner channel; no database, no network, no env).
// The database side is proven by supabase/tests/postona_x_identity_credential_run.sh (PG17 + F3's publisher e2e).
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  createXPostingCredentialSource,
  X_POSTING_CREDENTIAL_SOURCE_ENABLED,
  XCredentialSourceUnavailable,
  type OwnerQuery,
} from "./x_posting_credential_source.ts";

const A = "sa_aaaaaaaaaaaaaaaaaaaaaaaa";
const B = "sa_bbbbbbbbbbbbbbbbbbbbbbbb";
const C = "sa_cccccccccccccccccccccccc";
const TOKENS: Record<string, string> = { [A]: "fake-access-token-A-0123456789", [B]: "fake-access-token-B-0123456789" };
const GENERATIONS: Record<string, string> = { [A]: "a".repeat(64), [B]: "b".repeat(64) };

function fakeDb(overrides: Partial<{ throws: unknown; rows: ReadonlyArray<Record<string, unknown>> }> = {}) {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const query: OwnerQuery = (sql, params) => {
    calls.push({ sql, params });
    if (overrides.throws !== undefined) return Promise.reject(overrides.throws);
    if (overrides.rows !== undefined) return Promise.resolve(overrides.rows);
    const id = String(params[0]);
    if (sql.includes("x_posting_access_token_for")) return Promise.resolve([{ token: TOKENS[id] ?? null }]);
    return Promise.resolve(TOKENS[id] ? [{ token: TOKENS[id], generation: GENERATIONS[id] }] : []);
  };
  return { query, calls };
}

Deno.test("shipped OFF: not available, answers null, never asks the database", async () => {
  assertEquals(X_POSTING_CREDENTIAL_SOURCE_ENABLED, false);
  const db = fakeDb();
  const source = createXPostingCredentialSource({ query: db.query });
  assertEquals(source.available, false);
  assertEquals(await source.accessTokenFor(A), null);
  assertEquals(await source.credentialFor(A), null);
  assertEquals(db.calls.length, 0);
  assertEquals(createXPostingCredentialSource({ query: db.query, enabled: "true" as unknown as boolean }).available, false);
});

Deno.test("enabled: each account's own token; credentialFor is ONE query answering token + 64-hex generation together", async () => {
  const db = fakeDb();
  const source = createXPostingCredentialSource({ query: db.query, enabled: true });
  assertEquals(source.available, true);
  assertEquals(await source.accessTokenFor(A), TOKENS[A]);
  assertEquals(await source.accessTokenFor(C), null);
  assertEquals(await source.credentialFor(A), { token: TOKENS[A], generation: GENERATIONS[A] });
  assertEquals(await source.credentialFor(B), { token: TOKENS[B], generation: GENERATIONS[B] });
  assertEquals(await source.credentialFor(C), null);
  assertEquals(db.calls.map((c) => c.sql), [
    "select public.x_posting_access_token_for($1) as token",
    "select public.x_posting_access_token_for($1) as token",
    "select token, generation from public.x_posting_credential_for($1)",
    "select token, generation from public.x_posting_credential_for($1)",
    "select token, generation from public.x_posting_credential_for($1)",
  ]);
  assertEquals(db.calls.map((c) => c.params), [[A], [C], [A], [B], [C]]);
});

Deno.test("malformed ids are never sent; malformed or partial answers are null, never half a credential", async () => {
  const db = fakeDb();
  const source = createXPostingCredentialSource({ query: db.query, enabled: true });
  for (const id of ["", "SA_X", "sa x", "sa_a'; drop", "a".repeat(90), null, undefined, 42]) {
    assertEquals(await source.accessTokenFor(id as unknown as string), null, String(id));
    assertEquals(await source.credentialFor(id as unknown as string), null, String(id));
  }
  assertEquals(db.calls.length, 0);
  const badTokens: ReadonlyArray<Record<string, unknown>>[] = [[], [{ token: "short" }], [{ token: "has space in it 0123456789" }],
    [{ token: 123 }], [{}], [{ token: "a".repeat(20) }, { token: "b".repeat(20) }]];
  for (const rows of badTokens) {
    const one = createXPostingCredentialSource({ query: fakeDb({ rows }).query, enabled: true });
    assertEquals(await one.accessTokenFor(A), null, JSON.stringify(rows));
  }
  const badCredentials: ReadonlyArray<Record<string, unknown>>[] = [[], [{ token: TOKENS[A] }], [{ generation: "a".repeat(64) }],
    [{ token: TOKENS[A], generation: "a".repeat(32) }], [{ token: TOKENS[A], generation: "A".repeat(64) }],
    [{ token: "short", generation: "a".repeat(64) }],
    [{ token: TOKENS[A], generation: "a".repeat(64) }, { token: TOKENS[B], generation: "b".repeat(64) }]];
  for (const rows of badCredentials) {
    const one = createXPostingCredentialSource({ query: fakeDb({ rows }).query, enabled: true });
    assertEquals(await one.credentialFor(A), null, JSON.stringify(rows));
  }
});

Deno.test("a database failure is a fixed error that never carries the cause (C5 / G5)", async () => {
  const secret = TOKENS[A];
  const source = createXPostingCredentialSource({ query: fakeDb({ throws: new Error(`driver said ${secret}`) }).query, enabled: true });
  for (const call of [() => source.accessTokenFor(A), () => source.credentialFor(A)]) {
    const error = await assertRejects(call, XCredentialSourceUnavailable);
    assertEquals(error.message, "X_CREDENTIAL_SOURCE_UNAVAILABLE");
    assert(!JSON.stringify({ m: error.message, s: error.stack, c: (error as Error & { cause?: unknown }).cause }).includes(secret));
  }
});

Deno.test("the module reads no environment, does no network, logs nothing and imports nothing", async () => {
  const source = await Deno.readTextFile(new URL("./x_posting_credential_source.ts", import.meta.url));
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
  for (const banned of ["Deno.env", "fetch(", "console.", "import ", "localStorage", "SUPABASE_"]) {
    assert(!code.includes(banned), `found ${banned}`);
  }
});
