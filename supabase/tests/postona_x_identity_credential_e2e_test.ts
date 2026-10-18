// F4 / G4 M1 end to end, run ONLY by postona_x_identity_credential_run.sh inside its combined tree (it imports F3's
// x_publisher.ts / x_credential_contract.ts, overlaid read-only from PR #257). G4's credential source over the REAL
// disposable database (psql on a local socket = the trusted owner channel), F3's C1-C5 checker, and F3's real X
// publisher with a counting fake X: an accepted handoff sends exactly that account's token once; every refusal sends
// nothing. No network: the only "X" is the fake fetch below.
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createXPostingCredentialSource, type OwnerQuery } from "../functions/_shared/social/x_posting_credential_source.ts";
import { credentialSourceViolations } from "../functions/_shared/postona_reservations/x_credential_contract.ts";
import { createXReservationPublisher } from "../functions/_shared/postona_reservations/x_publisher.ts";

const need = (name: string): string => {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} required (run through postona_x_identity_credential_run.sh)`);
  return value;
};
const conn = ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-h", need("XG_E2E_HOST"), "-p", need("XG_E2E_PORT"), "-U", need("XG_E2E_USER"), "-d", need("XG_E2E_DB")];

/** One script on stdin (so psql interpolates :'p1'), its single output value ('' for SQL null). */
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
const ownerQuery: OwnerQuery = async (sql, params) => {
  const column = /as (\w+)\s*$/u.exec(sql)?.[1] ?? "value";
  const value = await psql(sql.replaceAll("$1", ":'p1'") + ";", { p1: String(params[0]) });
  return [{ [column]: value === "" ? null : value }];
};
const access = (tag: string) => psql(`select xg.access('${tag}');`);
const v2 = (n: number, tag: string, puid: string) => psql(`select xg.connect_v2(xg.enroll(${n}), '${tag}', '${puid}', '${tag}');`);

function fakeX() {
  const calls: Array<{ url: string; authorization: string | null; body: string }> = [];
  const fetch = (url: string, init?: RequestInit) => {
    calls.push({ url, authorization: new Headers(init?.headers).get("authorization"), body: String(init?.body) });
    return Promise.resolve(new Response(JSON.stringify({ data: { id: "1840000000000000001", text: "ok" } }), { status: 201 }));
  };
  return { calls, fetch };
}
const source = createXPostingCredentialSource({ query: ownerQuery, enabled: true });

// The people (fake): A, B attested; C connected only through the live v1 (client-stated id); E attested then POSTONA
// ended; F attested then overwritten by a v1 complete.
const acctA = await v2(401, "e2eA", "1401");
const acctB = await v2(402, "e2eB", "1402");
const acctC = await psql(`select xg.connect_v1(xg.enroll(403), 'e2eC', '1403', 'e2eC');`);
const acctE = await v2(404, "e2eE", "1404");
await psql(`select xg.state(xg.uid(404), 'ended');`);
const acctF = await v2(405, "e2eF", "1405");
await psql(`select xg.connect_v1(xg.uid(405), 'e2eF2', '1405', 'e2eF-v1');`);
for (const id of [acctA, acctB, acctC, acctE, acctF]) assert(/^sa_[0-9a-f]{24}$/u.test(id), `setup ${id}`);

Deno.test("F3's C1-C5 checker passes on G4's source over the real database; the shipped default fails C1", async () => {
  assertEquals(await credentialSourceViolations(source, { connected: [acctA, acctB], notConnected: [acctC, acctE, acctF, "sa_no_such_account"] }), []);
  const shipped = createXPostingCredentialSource({ query: ownerQuery });
  assert((await credentialSourceViolations(shipped, { connected: [acctA, acctB], notConnected: [] })).includes("C1 available is not true"));
});

Deno.test("accepted: F3's publisher sends the stored text once, with exactly that account's own token", async () => {
  const x = fakeX();
  const publisher = createXReservationPublisher({ credentials: source, fetch: x.fetch });
  assertEquals(publisher.available, true);
  assertEquals(await publisher.publish(acctA, "M1 synthetic post"), { kind: "published", providerPostId: "1840000000000000001" });
  assertEquals(x.calls.length, 1);
  assertEquals(x.calls[0].url, "https://api.x.com/2/tweets");
  assertEquals(x.calls[0].authorization, `Bearer ${await access("e2eA")}`);
  assertEquals(JSON.parse(x.calls[0].body), { text: "M1 synthetic post" });
});

Deno.test("refused: a client-stated identity, an ended POSTONA, a v1 overwrite, an unknown account -> nothing sent", async () => {
  for (const account of [acctC, acctE, acctF, "sa_no_such_account", "Not-An-Id"]) {
    const x = fakeX();
    const result = await createXReservationPublisher({ credentials: source, fetch: x.fetch }).publish(account, "must not be sent");
    assertEquals(result, { kind: "rejected_before_send", code: "X_CREDENTIALS_UNAVAILABLE" }, account);
    assertEquals(x.calls.length, 0, account);
  }
});

Deno.test("the last moment: verified and generation g1 at authorize time, a change right before the send -> nothing sent", async () => {
  const changes: Array<[number, string]> = [
    [411, "select xg.connect_v1(xg.uid(411), 'lm411b', '1411', 'lm411-v1');"],
    [412, "select xg.enroll(512); update public.brand_memberships set user_id = xg.uid(512) where brand_id = public.social_mobile_account_deletion_workspace(xg.uid(412)) and user_id = xg.uid(412) and role = 'owner';"],
    [413, "select xg.state(xg.uid(413), 'ended');"],
    [414, "update public.x_account_refresh_state_v2 set status = 'reauth_required' where social_account_id = (select id from public.social_accounts where platform_user_id = '1414'); insert into public.x_account_refresh_state_v2 (social_account_id, status) select id, 'reauth_required' from public.social_accounts where platform_user_id = '1414' on conflict do nothing;"],
  ];
  for (const [n, change] of changes) {
    const account = await v2(n, `lm${n}`, String(1000 + n));
    assertEquals(await psql(`select postona_x_resv.g4_x_account_verified(xg.uid(${n}), '${account}');`), "t", `authorize ${n}`);
    const g1 = await source.credentialGenerationFor(account);
    assert(g1 !== null, `generation ${n}`);
    await psql(change);
    const x = fakeX();
    const result = await createXReservationPublisher({ credentials: source, fetch: x.fetch }).publish(account, "must not be sent");
    assertEquals(result, { kind: "rejected_before_send", code: "X_CREDENTIALS_UNAVAILABLE" }, `change ${n}`);
    assertEquals(x.calls.length, 0, `change ${n}`);
    // A reconnect / an owner change moves the generation (F5's request); a POSTONA or refresh-state change refuses the
    // handoff itself.
    if (n === 411 || n === 412) assert((await source.credentialGenerationFor(account)) !== g1, `generation moved ${n}`);
  }
});

Deno.test("a refresh after the attestation: a new generation, and the send uses the refreshed token", async () => {
  const account = await v2(421, "rf421", "1421");
  const g1 = await source.credentialGenerationFor(account);
  await psql(`select vault.update_secret((select vault_access_token_secret_id from public.social_accounts where id = '${account}'), xg.access('rf421-refreshed'));
insert into public.x_account_refresh_state_v2 (social_account_id) values ('${account}') on conflict do nothing;
update public.x_account_refresh_state_v2 set generation = generation + 1, last_refreshed_at = now(), access_expires_at = now() + interval '2 hours' where social_account_id = '${account}';`);
  const g2 = await source.credentialGenerationFor(account);
  assert(g2 !== null && g2 !== g1, "generation after the refresh");
  const x = fakeX();
  assertEquals((await createXReservationPublisher({ credentials: source, fetch: x.fetch }).publish(account, "after refresh")).kind, "published");
  assertEquals(x.calls[0].authorization, `Bearer ${await access("rf421-refreshed")}`);
});
