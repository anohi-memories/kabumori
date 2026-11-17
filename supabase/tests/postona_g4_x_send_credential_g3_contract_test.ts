// G4-02 #19 (Issue #561): G3's contract for the generation-bound X credential source (G3 PR #699, read only), checked against G4's
// source over the REAL local PG17 database. Run only by postona_g4_x_send_credential_run.sh, which copies this file next to G3's
// x_credential_generation.ts / credential_generation_derivation.ts / x_publisher.ts (git show of PR #699 HEAD) and G4's
// x_send_credential_source.ts. The read is psql as service_role (the only role 003 grants), standing in for PostgREST.
// No network (--deny-net); the tokens are the runner's fake values.
import assert from "node:assert/strict";
import { generationSourceViolations } from "./x_credential_generation.ts";
import { xGenerationSourceFromG4Raw } from "./credential_generation_derivation.ts";
import { createG4XSendCredentialSource } from "./x_send_credential_source.ts";

const env = (name: string) => {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`G4XS_ENV_MISSING ${name}`);
  return v;
};
async function psql(script: string, vars: Record<string, string>): Promise<string> {
  const args = ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-h", env("G4XS_HOST"), "-p", env("G4XS_PORT"), "-U", env("G4XS_USER"), "-d", env("G4XS_DB")];
  for (const [k, v] of Object.entries(vars)) args.push("-v", `${k}=${v}`);
  const child = new Deno.Command(env("G4XS_PSQL"), { args, stdin: "piped", stdout: "piped", stderr: "piped" }).spawn();
  const w = child.stdin.getWriter();
  await w.write(new TextEncoder().encode(script));
  await w.close();
  const out = await child.output();
  if (!out.success) throw new Error("G4XS_PSQL_FAILED"); // stderr is not echoed (it could carry a value)
  return new TextDecoder().decode(out.stdout).trim();
}
const read = async (account: string) =>
  JSON.parse(await psql("set role service_role;\nselect coalesce(json_agg(r), '[]'::json) from public.postona_x_send_credential_v1(:'a') r;\n", { a: account }));
// The database's G3 generation as G3's 014 defines it: sha256 hex of 'g3x1|' || G4's verified generation (null unless verified)
const databaseGeneration = async (account: string) =>
  (await psql(`select encode(sha256(convert_to('g3x1|' || r.credential_generation, 'UTF8')), 'hex')
    from public.social_accounts sa, postona_g4_credential.x_publish_credential_verdict(private.account_lifecycle_brand_owner(sa.brand_id), sa.id) r
   where sa.id = :'a' and r.verified;\n`, { a: account })) || null;

Deno.test("G3's generation contract (G1-G5) holds for G4's source through G3's adapter on the real database", async () => {
  const [k1, k2, disconnected, noLineage, serviceEnded, ownerLost] = env("G4XS_ACCOUNTS").split(",");
  const source = xGenerationSourceFromG4Raw(createG4XSendCredentialSource({ read }));
  const violations = await generationSourceViolations(source, {
    connected: [k1, k2],
    notConnected: [disconnected, noLineage, serviceEnded, ownerLost, "sa_doesnotexist000000000000"],
    databaseGeneration,
  });
  console.log(`G4XS_G3_CONTRACT violations=${violations.length} connected=2 not_connected=5`);
  assert.deepEqual(violations, []);
  // the generation G3 compares at preflight is exactly G3's derivation of G4's value; the token is the one G4 stored for that account
  const c1 = await source.credentialFor(k1);
  assert.equal(c1?.generation, await databaseGeneration(k1));
  assert.equal(c1?.token, "fakeXat_g4xs-k1-label");
});
