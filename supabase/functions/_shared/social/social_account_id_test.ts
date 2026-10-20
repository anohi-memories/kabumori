// Offline: no --allow-net, no --allow-env (read only, for the migration parity and the leftover scan).
//   deno test --no-config --cached-only --allow-read=. supabase/functions/_shared/social/social_account_id_test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { isSocialAccountId, SOCIAL_ACCOUNT_ID } from "./social_account_id.ts";
import { SOCIAL_ACCOUNT_ID as DISCONNECT_SOCIAL_ACCOUNT_ID } from "./threads_disconnect.ts";
import { INVALID_SOCIAL_ACCOUNT_IDS, VALID_SOCIAL_ACCOUNT_IDS } from "./social_account_id_cases.ts";

const root = new URL("../../../../", import.meta.url);

test("the real shape is accepted, everything else refused", () => {
  for (const id of VALID_SOCIAL_ACCOUNT_IDS) assert.equal(isSocialAccountId(id), true, id);
  for (const id of INVALID_SOCIAL_ACCOUNT_IDS) assert.equal(isSocialAccountId(id), false, JSON.stringify(String(id)));
});

test("parity: exactly the table's CHECK as the migration asserts it, and one definition (disconnect re-exports it)", async () => {
  const migration = await Deno.readTextFile(new URL("supabase/migrations/20261007150000_postona_social_accounts_multi_provider.sql", root));
  const check = /CHECK \(\(id ~ ''(\^[^']+\$)''::text\)\)/u.exec(migration);
  assert.ok(check, "the catalog assertion of social_accounts_id_check");
  assert.equal(SOCIAL_ACCOUNT_ID.source, check[1]);
  assert.equal(SOCIAL_ACCOUNT_ID.flags, "u");
  assert.equal(DISCONNECT_SOCIAL_ACCOUNT_ID, SOCIAL_ACCOUNT_ID);
});

test("no UUID-only assumption is left on an account id in the G4 Threads entries", async () => {
  for (const name of ["threads_send_port.ts", "threads_account_binding.ts", "threads_connect_to_send.ts"]) {
    const source = (await Deno.readTextFile(new URL(name, import.meta.url))).replace(/^\s*\/\/.*$/gmu, "");
    assert.equal(source.includes('from "./social_account_id.ts"'), true, name);
    // Every UUID test that remains is on a person (auth.users id), never on an account id.
    for (const m of source.matchAll(/UUID\.test\(([^)]*)\)/gu)) assert.match(m[1], /Principal|principal/u, `${name}: ${m[0]}`);
    assert.equal(/(?:socialAccountId|social_account_id)[^;\n]{0,40}UUID|UUID[^;\n]{0,40}(?:socialAccountId|social_account_id)/u.test(source), false, name);
  }
  const own = await Deno.readTextFile(new URL("./social_account_id.ts", import.meta.url));
  assert.deepEqual([...own.matchAll(/(?:from|import\()\s*["']([^"']+)["']/gu)], []);
});
