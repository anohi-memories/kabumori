// F4 / G4 M1 end to end, run ONLY by postona_x_identity_credential_run.sh inside its combined tree (it imports F3's
// x_publisher.ts / x_credential_contract.ts / x_credential_generation.ts, overlaid read-only from PR #278). G4's
// credential source over the REAL disposable database (each psql call is a separate session = the trusted owner
// channel), F3's C1-C5 and G1-G5 checkers, and F3's real X publisher with a counting fake X: an accepted handoff sends
// exactly that account's token once; every refusal sends nothing. No network: the only "X" is the fake fetch below.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createXPostingCredentialSource, type OwnerQuery } from "../functions/_shared/social/x_posting_credential_source.ts";
import { credentialSourceViolations } from "../functions/_shared/postona_reservations/x_credential_contract.ts";
import { generationSourceOf, generationSourceViolations, oneShotCredentialSource } from "../functions/_shared/postona_reservations/x_credential_generation.ts";
import { createXReservationPublisher } from "../functions/_shared/postona_reservations/x_publisher.ts";

const need = (name: string): string => {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} required (run through postona_x_identity_credential_run.sh)`);
  return value;
};
const conn = ["-X", "-q", "-A", "-t", "-F", "\x1f", "-v", "ON_ERROR_STOP=1", "-h", need("XG_E2E_HOST"), "-p", need("XG_E2E_PORT"),
  "-U", need("XG_E2E_USER"), "-d", need("XG_E2E_DB")];

/** One script on stdin, in its OWN session (so psql interpolates :'p1'); its output ('' for SQL null / no row). */
async function psql(sql: string, vars: Record<string, string> = {}): Promise<string> {
  const args = [...conn];
  for (const [key, value] of Object.entries(vars)) args.push("-v", `${key}=${value}`);
  const child = new Deno.Command(need("XG_E2E_PSQL"), { args, stdin: "piped", stdout: "piped", stderr: "piped" }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(sql + "\n"));
  await writer.close();
  const out = await child.output();
  if (!out.success) throw new Error("psql failed: " + new TextDecoder().decode(out.stderr).split("\n")[0]);
  return new TextDecoder().decode(out.stdout).trim();
}
/** The owner channel as a driver would expose it: rows of the named columns (one row at most here). */
const ownerQuery: OwnerQuery = async (sql, params) => {
  const listed = /^select ([a-z_, ]+) from /u.exec(sql)?.[1];
  const columns = listed ? listed.split(",").map((c) => c.trim()) : [/ as (\w+)$/u.exec(sql)?.[1] ?? "value"];
  const line = await psql(sql.replaceAll("$1", ":'p1'") + ";", { p1: String(params[0]) });
  if (line === "") return [];
  const cells = line.split("\x1f");
  return [Object.fromEntries(columns.map((column, i) => [column, cells[i] === "" ? null : cells[i]]))];
};
const access = (tag: string) => psql(`select xg.access('${tag}');`);
const v2 = (n: number, tag: string, puid: string, tokenTag = tag) => psql(`select xg.connect_v2(xg.enroll(${n}), '${tag}', '${puid}', '${tokenTag}');`);
const dbGeneration = (account: string) => psql(`select postona_x_resv.x_credential_generation('${account}');`).then((g) => g === "" ? null : g);

function fakeX() {
  const calls: Array<{ url: string; authorization: string | null; body: string }> = [];
  const fetch = (url: string, init?: RequestInit) => {
    calls.push({ url, authorization: new Headers(init?.headers).get("authorization"), body: String(init?.body) });
    return Promise.resolve(new Response(JSON.stringify({ data: { id: "1840000000000000001", text: "ok" } }), { status: 201 }));
  };
  return { calls, fetch };
}
const source = createXPostingCredentialSource({ query: ownerQuery, enabled: true });

/** F3's single-post path, reduced to G4's part: credentialFor -> the generation must equal the database's right now ->
 *  one send with exactly that token (F3's oneShotCredentialSource + real publisher). Returns [result, fake X calls]. */
async function generationBoundSend(account: string, text: string) {
  const x = fakeX();
  const credential = await generationSourceOf(source).credentialFor(account);
  if (!credential || credential.generation !== await dbGeneration(account)) return [{ kind: "rejected_before_send", code: "X_CREDENTIALS_UNAVAILABLE" }, x.calls] as const;
  const result = await createXReservationPublisher({ credentials: oneShotCredentialSource(account, credential.token), fetch: x.fetch }).publish(account, text);
  return [result, x.calls] as const;
}

// The people (fake): A, B attested; C connected only through the live v1 (client-stated id); E attested then POSTONA
// ended; F attested then overwritten by a v1 complete in a later transaction.
const acctA = await v2(401, "e2eA", "1401");
const acctB = await v2(402, "e2eB", "1402");
const acctC = await psql(`select xg.connect_v1(xg.enroll(403), 'e2eC', '1403', 'e2eC');`);
const acctE = await v2(404, "e2eE", "1404");
await psql(`select xg.state(xg.uid(404), 'ended');`);
const acctF = await v2(405, "e2eF", "1405");
await psql(`select xg.connect_v1(xg.uid(405), 'e2eF2', '1405', 'e2eF-v1');`);
for (const id of [acctA, acctB, acctC, acctE, acctF]) assert(/^sa_[0-9a-f]{24}$/u.test(id), `setup ${id}`);

Deno.test("F3's C1-C5 (token port) and G1-G5 (generation-bound port) pass on G4's source over the real database", async () => {
  const notConnected = [acctC, acctE, acctF, "sa_no_such_account"];
  assertEquals(await credentialSourceViolations(source, { connected: [acctA, acctB], notConnected }), []);
  assertEquals(await generationSourceViolations(source, { connected: [acctA, acctB], notConnected, databaseGeneration: dbGeneration }), []);
  const shipped = createXPostingCredentialSource({ query: ownerQuery });
  assert((await credentialSourceViolations(shipped, { connected: [acctA, acctB], notConnected: [] })).includes("C1 available is not true"));
  assertEquals(generationSourceOf(shipped).available, false, "the shipped default is not a generation source");
});

Deno.test("accepted: one send with exactly that account's own token, by either port", async () => {
  const x = fakeX();
  assertEquals(await createXReservationPublisher({ credentials: source, fetch: x.fetch }).publish(acctA, "M1 synthetic post"),
               { kind: "published", providerPostId: "1840000000000000001" });
  assertEquals(x.calls.length, 1);
  assertEquals(x.calls[0].url, "https://api.x.com/2/tweets");
  assertEquals(x.calls[0].authorization, `Bearer ${await access("e2eA")}`);
  assertEquals(JSON.parse(x.calls[0].body), { text: "M1 synthetic post" });
  const [result, calls] = await generationBoundSend(acctB, "M1 generation-bound");
  assertEquals(result.kind, "published");
  assertEquals(calls.length, 1);
  assertEquals(calls[0].authorization, `Bearer ${await access("e2eB")}`);
});

Deno.test("refused: a client-stated identity, an ended POSTONA, a v1 overwrite, an unknown account -> nothing sent", async () => {
  for (const account of [acctC, acctE, acctF, "sa_no_such_account", "Not-An-Id"]) {
    const x = fakeX();
    assertEquals(await createXReservationPublisher({ credentials: source, fetch: x.fetch }).publish(account, "must not be sent"),
                 { kind: "rejected_before_send", code: "X_CREDENTIALS_UNAVAILABLE" }, account);
    assertEquals(x.calls.length, 0, account);
    const [result, calls] = await generationBoundSend(account, "must not be sent");
    assertEquals(result.kind, "rejected_before_send", account);
    assertEquals(calls.length, 0, account);
  }
});

Deno.test("J2 V2 R1: signed v2 then unsigned v1 in ONE transaction -> after COMMIT, in a new session: nothing sent", async () => {
  const account = await psql(`begin;
select xg.connect_v2(xg.enroll(431), 'r1e2e', '1431', 'R1E2E-SIGNED');
select xg.connect_v1(xg.uid(431), 'r1e2e1', '1431', 'R1E2E-UNSIGNED');
commit;
select id from public.social_accounts where platform_user_id = '1431';`).then((out) => out.split("\n").pop()!);
  assert(/^sa_/u.test(account), account);
  assertEquals(await source.accessTokenFor(account), null);
  assertEquals(await source.credentialFor(account), null);
  const x = fakeX();
  assertEquals((await createXReservationPublisher({ credentials: source, fetch: x.fetch }).publish(account, "must not be sent")).kind, "rejected_before_send");
  assertEquals(x.calls.length, 0);
  assertEquals((await generationBoundSend(account, "must not be sent"))[1].length, 0);
});

Deno.test("J2 V2 R2: owner A -> B -> A in three committed sessions -> nothing sent; a new attested connect, a new generation", async () => {
  const account = await v2(441, "r2e2e", "1441", "R2E2E");
  const g1 = (await source.credentialFor(account))?.generation;
  assert(g1, "generation before");
  await psql(`select xg.enroll(442);`);
  await psql(`update public.brand_memberships set user_id = xg.uid(442) where brand_id = public.social_mobile_account_deletion_workspace(xg.uid(441)) and user_id = xg.uid(441) and role = 'owner';`);
  await psql(`update public.brand_memberships set user_id = xg.uid(441) where brand_id = public.social_mobile_account_deletion_workspace(xg.uid(441)) and user_id = xg.uid(442) and role = 'owner';`);
  assertEquals(await source.credentialFor(account), null, "the old attestation must not revive");
  const x = fakeX();
  assertEquals((await createXReservationPublisher({ credentials: source, fetch: x.fetch }).publish(account, "must not be sent")).kind, "rejected_before_send");
  assertEquals(x.calls.length, 0);
  assertEquals((await generationBoundSend(account, "must not be sent"))[1].length, 0);
  assertEquals(await psql(`select xg.connect_v2(xg.uid(441), 'r2e2e2', '1441', 'R2E2E-NEW');`), account);
  const again = await source.credentialFor(account);
  assert(again && again.generation !== g1 && again.token === await access("R2E2E-NEW"), "re-attested with a new generation");
});

Deno.test("the last moment: a change after authorize -> credentialFor null, nothing sent", async () => {
  const changes: Array<[number, string]> = [
    [411, "select xg.connect_v1(xg.uid(411), 'lm411b', '1411', 'lm411-v1');"],
    [412, "select xg.enroll(512); update public.brand_memberships set user_id = xg.uid(512) where brand_id = public.social_mobile_account_deletion_workspace(xg.uid(412)) and user_id = xg.uid(412) and role = 'owner';"],
    [413, "select xg.state(xg.uid(413), 'ended');"],
    [414, "insert into public.x_account_refresh_state_v2 (social_account_id, status) select id, 'reauth_required' from public.social_accounts where platform_user_id = '1414' on conflict (social_account_id) do update set status = 'reauth_required';"],
  ];
  for (const [n, change] of changes) {
    const account = await v2(n, `lm${n}`, String(1000 + n));
    assertEquals(await psql(`select postona_x_resv.g4_x_account_verified(xg.uid(${n}), '${account}');`), "t", `authorize ${n}`);
    assert((await source.credentialFor(account)) !== null, `credential before ${n}`);
    await psql(change);
    assertEquals(await source.credentialFor(account), null, `change ${n}`);
    const [result, calls] = await generationBoundSend(account, "must not be sent");
    assertEquals(result.kind, "rejected_before_send", `change ${n}`);
    assertEquals(calls.length, 0, `change ${n}`);
  }
});

Deno.test("a refresh: nothing until G4 re-attests the exact tokens; then the refreshed token with a new generation", async () => {
  const account = await v2(421, "rf421", "1421");
  const g1 = (await source.credentialFor(account))?.generation;
  await psql(`select vault.update_secret((select vault_access_token_secret_id from public.social_accounts where id = '${account}'), xg.access('rf421-refreshed'));
select vault.update_secret((select vault_refresh_token_secret_id from public.social_accounts where id = '${account}'), xg.refresh('rf421-refreshed'));
insert into public.x_account_refresh_state_v2 (social_account_id) values ('${account}') on conflict do nothing;
update public.x_account_refresh_state_v2 set generation = generation + 1, last_refreshed_at = now(), access_expires_at = now() + interval '2 hours' where social_account_id = '${account}';`);
  assertEquals(await source.credentialFor(account), null, "refreshed, not re-attested");
  assertEquals(await psql(`select public.x_account_attest_refreshed_credential('${account}', xg.sha(xg.access('rf421-refreshed')), xg.sha(xg.refresh('rf421-refreshed')));`), "t");
  const after = await source.credentialFor(account);
  assert(after && after.generation !== g1 && after.token === await access("rf421-refreshed"), "re-attested");
  const [result, calls] = await generationBoundSend(account, "after refresh");
  assertEquals(result.kind, "published");
  assertEquals(calls[0].authorization, `Bearer ${await access("rf421-refreshed")}`);
});

Deno.test("F5 PR #285: an unknown owner epoch (coverage broken) -> credentialFor null, nothing sent; restored -> usable", async () => {
  const account = await v2(461, "ep461", "1461");
  assert((await source.credentialFor(account)) !== null, "before");
  await psql(`alter table public.brand_memberships disable trigger account_lifecycle_owner_epoch_row;`);
  try {
    assertEquals(await psql(`select coalesce(private.account_lifecycle_brand_owner_epoch(public.social_mobile_account_deletion_workspace(xg.uid(461)))::text, 'NULL');`), "NULL");
    assertEquals(await source.credentialFor(account), null);
    assertEquals(await source.accessTokenFor(account), null);
    const [result, calls] = await generationBoundSend(account, "must not be sent");
    assertEquals(result.kind, "rejected_before_send");
    assertEquals(calls.length, 0);
  } finally {
    await psql(`alter table public.brand_memberships enable trigger account_lifecycle_owner_epoch_row;`);
  }
  assert((await source.credentialFor(account)) !== null, "after the coverage is back");
});

Deno.test("G3 pre-send: the generation moved after credentialFor (a re-attested refresh in between) -> nothing sent", async () => {
  const account = await v2(471, "ps471", "1471");
  const credential = await source.credentialFor(account);
  assert(credential, "credential");
  await psql(`select vault.update_secret((select vault_access_token_secret_id from public.social_accounts where id = '${account}'), xg.access('ps471-r'));
select vault.update_secret((select vault_refresh_token_secret_id from public.social_accounts where id = '${account}'), xg.refresh('ps471-r'));
insert into public.x_account_refresh_state_v2 (social_account_id) values ('${account}') on conflict do nothing;
update public.x_account_refresh_state_v2 set generation = generation + 1, last_refreshed_at = now(), access_expires_at = now() + interval '2 hours' where social_account_id = '${account}';
select public.x_account_attest_refreshed_credential('${account}', xg.sha(xg.access('ps471-r')), xg.sha(xg.refresh('ps471-r')));`);
  const now = await dbGeneration(account);
  assert(now !== null && now !== credential.generation, "the database generation moved");
  // F3's pre-send rule: send only when the generation bound to the token equals the database's right now.
  const x = fakeX();
  if (credential.generation === now) {
    await createXReservationPublisher({ credentials: oneShotCredentialSource(account, credential.token), fetch: x.fetch }).publish(account, "stale");
  }
  assertEquals(x.calls.length, 0);
});
