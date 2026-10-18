// F4 / G4 M1: the server-only X credential source, offline (a fake owner channel; no database, no network, no env).
// The database side is proven by supabase/tests/postona_x_identity_credential_run.sh (PG17 + F3's publisher e2e).
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  createXPostingCredentialSource,
  X_POSTING_CREDENTIAL_SOURCE_ENABLED,
  XCredentialSourceUnavailable,
  type OwnerQuery,
} from "./x_posting_credential_source.ts";

const TOKENS: Record<string, string> = { sa_aaaaaaaaaaaaaaaaaaaaaaaa: "fake-access-token-A-0123456789", sa_bbbbbbbbbbbbbbbbbbbbbbbb: "fake-access-token-B-0123456789" };
const GENERATIONS: Record<string, string> = { sa_aaaaaaaaaaaaaaaaaaaaaaaa: "0123456789abcdef0123456789abcdef" };

function fakeDb(overrides: Partial<{ throws: unknown; rows: ReadonlyArray<Record<string, unknown>> }> = {}) {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const query: OwnerQuery = (sql, params) => {
    calls.push({ sql, params });
    if (overrides.throws !== undefined) return Promise.reject(overrides.throws);
    if (overrides.rows !== undefined) return Promise.resolve(overrides.rows);
    const id = String(params[0]);
    if (sql.includes("x_posting_access_token_for")) return Promise.resolve([{ token: TOKENS[id] ?? null }]);
    return Promise.resolve([{ generation: GENERATIONS[id] ?? null }]);
  };
  return { query, calls };
}

Deno.test("shipped OFF: not available, answers null, never asks the database", async () => {
  assertEquals(X_POSTING_CREDENTIAL_SOURCE_ENABLED, false);
  const db = fakeDb();
  const source = createXPostingCredentialSource({ query: db.query });
  assertEquals(source.available, false);
  assertEquals(await source.accessTokenFor("sa_aaaaaaaaaaaaaaaaaaaaaaaa"), null);
  assertEquals(await source.credentialGenerationFor("sa_aaaaaaaaaaaaaaaaaaaaaaaa"), null);
  assertEquals(db.calls.length, 0);
  assertEquals(createXPostingCredentialSource({ query: db.query, enabled: "true" as unknown as boolean }).available, false);
});

Deno.test("enabled: each account's own token through one parameterized call; unknown -> null (C1-C4 shape)", async () => {
  const db = fakeDb();
  const source = createXPostingCredentialSource({ query: db.query, enabled: true });
  assertEquals(source.available, true);
  assertEquals(await source.accessTokenFor("sa_aaaaaaaaaaaaaaaaaaaaaaaa"), TOKENS.sa_aaaaaaaaaaaaaaaaaaaaaaaa);
  assertEquals(await source.accessTokenFor("sa_bbbbbbbbbbbbbbbbbbbbbbbb"), TOKENS.sa_bbbbbbbbbbbbbbbbbbbbbbbb);
  assertEquals(await source.accessTokenFor("sa_cccccccccccccccccccccccc"), null);
  assertEquals(db.calls.map((c) => c.sql), Array(3).fill("select public.x_posting_access_token_for($1) as token"));
  assertEquals(db.calls.map((c) => c.params), [["sa_aaaaaaaaaaaaaaaaaaaaaaaa"], ["sa_bbbbbbbbbbbbbbbbbbbbbbbb"], ["sa_cccccccccccccccccccccccc"]]);
  assertEquals(await source.credentialGenerationFor("sa_aaaaaaaaaaaaaaaaaaaaaaaa"), GENERATIONS.sa_aaaaaaaaaaaaaaaaaaaaaaaa);
  assertEquals(await source.credentialGenerationFor("sa_bbbbbbbbbbbbbbbbbbbbbbbb"), null);
});

Deno.test("malformed ids are never sent; malformed answers are null, not a token", async () => {
  const db = fakeDb();
  const source = createXPostingCredentialSource({ query: db.query, enabled: true });
  for (const id of ["", "SA_X", "sa x", "sa_a'; drop", "a".repeat(90), null, undefined, 42]) {
    assertEquals(await source.accessTokenFor(id as unknown as string), null, String(id));
  }
  assertEquals(db.calls.length, 0);
  for (const rows of [[], [{ token: "short" }], [{ token: "has space in it 0123456789" }], [{ token: 123 }], [{}], [{ token: "a".repeat(20) }, { token: "b".repeat(20) }]]) {
    const one = createXPostingCredentialSource({ query: fakeDb({ rows }).query, enabled: true });
    assertEquals(await one.accessTokenFor("sa_aaaaaaaaaaaaaaaaaaaaaaaa"), null, JSON.stringify(rows));
  }
  const badGeneration = createXPostingCredentialSource({ query: fakeDb({ rows: [{ generation: "not-a-generation" }] }).query, enabled: true });
  assertEquals(await badGeneration.credentialGenerationFor("sa_aaaaaaaaaaaaaaaaaaaaaaaa"), null);
});

Deno.test("a database failure is a fixed error that never carries the cause (C5)", async () => {
  const secret = "fake-access-token-A-0123456789";
  const source = createXPostingCredentialSource({ query: fakeDb({ throws: new Error(`driver said ${secret}`) }).query, enabled: true });
  const error = await assertRejects(() => source.accessTokenFor("sa_aaaaaaaaaaaaaaaaaaaaaaaa"), XCredentialSourceUnavailable);
  assertEquals(error.message, "X_CREDENTIAL_SOURCE_UNAVAILABLE");
  assert(!JSON.stringify({ m: error.message, s: error.stack, c: (error as Error & { cause?: unknown }).cause }).includes(secret));
});

Deno.test("the module reads no environment, does no network, logs nothing and imports nothing", async () => {
  const source = await Deno.readTextFile(new URL("./x_posting_credential_source.ts", import.meta.url));
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
  for (const banned of ["Deno.env", "fetch(", "console.", "import ", "localStorage", "SUPABASE_"]) {
    assert(!code.includes(banned), `found ${banned}`);
  }
});
