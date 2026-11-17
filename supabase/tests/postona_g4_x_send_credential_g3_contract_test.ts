// G4-02 #19, #20 (Issue #561): G3's contract for the generation-bound X credential source (G3 PR #699, read only), checked against G4's
// source over the REAL local PG17 database. G4-02 #20: G4's source answers only for a send attempt, so the source G3's contract checks
// here is G4's source with each account's attempt passed in (what G3's port has to pass after its own change); through G3's current
// one-argument port the same source answers nothing. Run only by postona_g4_x_send_credential_run.sh, which copies this file next to G3's
// x_credential_generation.ts / credential_generation_derivation.ts / x_publisher.ts (git show of PR #699 HEAD) and G4's
// x_send_credential_source.ts. The read is psql as service_role (the only role 003 grants), standing in for PostgREST.
// No network (--deny-net); the tokens are the runner's fake values.
import assert from "node:assert/strict";
import { generationSourceViolations } from "./x_credential_generation.ts";
import { xGenerationSourceFromG4Raw } from "./credential_generation_derivation.ts";
import { createG4XSendCredentialSource, type XSendAttempt } from "./x_send_credential_source.ts";
import type { XPostingGenerationCredentialSource } from "./x_credential_generation.ts";

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
const read = async (account: string, attempt: Required<XSendAttempt>) =>
  JSON.parse(await psql(
    "set role service_role;\nselect coalesce(json_agg(r), '[]'::json) from public.postona_x_send_credential_for_claim_v1(:'r'::uuid, :'l'::uuid, :'a', nullif(:'s', '')::uuid) r;\n",
    { r: attempt.reservationId, l: attempt.leaseToken, a: account, s: attempt.sessionId ?? "" },
  ));
// account=reservation|lease|session (the runner's SYNTHETIC G3 claims, one per account)
const attempts = new Map(env("G4XS_ATTEMPTS").split(",").map((x) => {
  const [account, rest] = x.split("=");
  const [reservationId, leaseToken, sessionId] = rest.split("|");
  return [account, { reservationId, leaseToken, sessionId }] as const;
}));
// The database's G3 generation as G3's 014 defines it: sha256 hex of 'g3x1|' || G4's verified generation (null unless verified)
const databaseGeneration = async (account: string) =>
  (await psql(`select encode(sha256(convert_to('g3x1|' || r.credential_generation, 'UTF8')), 'hex')
    from public.social_accounts sa, postona_g4_credential.x_publish_credential_verdict(private.account_lifecycle_brand_owner(sa.brand_id), sa.id) r
   where sa.id = :'a' and r.verified;\n`, { a: account })) || null;

Deno.test("G3's generation contract (G1-G5) holds for G4's source through G3's adapter on the real database", async () => {
  const [k1, k2, disconnected, noLineage, serviceEnded, ownerLost] = env("G4XS_ACCOUNTS").split(",");
  const g4 = createG4XSendCredentialSource({ read });
  // the port after G3's change: the attempt G3's begin / claim answered for this account
  const source = xGenerationSourceFromG4Raw({ available: true, credentialFor: (a: string) => g4.credentialFor(a, attempts.get(a) ?? null) });
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
  // G3's current one-argument port: G4's source answers nothing (fail-closed until G3 passes the attempt)
  const onePort = xGenerationSourceFromG4Raw(g4 as unknown as Parameters<typeof xGenerationSourceFromG4Raw>[0]) as XPostingGenerationCredentialSource;
  let answered = 0;
  for (const a of [k1, k2]) if (await onePort.credentialFor(a) !== null) answered += 1;
  console.log(`G4XS_G3_ONE_ARG_PORT answered=${answered}`);
  assert.equal(answered, 0);
});
