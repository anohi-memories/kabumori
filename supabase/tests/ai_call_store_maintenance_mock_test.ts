// The non-production maintenance mock against the ledger + call-store (+ erasure) migrations in a disposable
// PostgreSQL, through psql on the local socket the runner gives (RPCs AS service_role, setup as the superuser with
// the test fixtures). Run by supabase/tests/ai_ledger_user_erasure_run.sh (part "maintenance"); skipped without env.
import assert from "node:assert/strict";
import { maintenanceTick, type Registration } from "./ai_call_store_maintenance_mock.ts";

const HOST = Deno.env.get("ACS_PGHOST");
const PORT = Deno.env.get("ACS_PGPORT");
const SUPER = Deno.env.get("ACS_PGSUPER");
const DB = Deno.env.get("ACS_DB");
const enabled = !!HOST && !!PORT && !!SUPER && !!DB && /^\/(private\/)?tmp\//.test(HOST);

async function psql(statement: string): Promise<string> {
  const output = await new Deno.Command("psql", {
    args: ["-X", "-h", HOST!, "-p", PORT!, "-U", SUPER!, "-d", DB!, "-Atq", "-v", "ON_ERROR_STOP=1", "-c", statement],
    env: { LC_ALL: "C" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes).trim();
  if (!output.success) throw new Error(`psql: ${text(output.stderr).split("\n")[0]}`);
  return text(output.stdout);
}

async function rpc(name: string, p: unknown): Promise<unknown> {
  if (!/^ai_(calls|ledger)_[a-z_]+$/.test(name)) throw new Error("unexpected rpc");
  const json = JSON.stringify(p);
  if (json.includes("$acs$")) throw new Error("payload contains the quote tag");
  return JSON.parse(await psql(`set role service_role; select public.${name}($acs$${json}$acs$::jsonb)`));
}

const REGISTRY: Record<string, Registration> = {
  "postona.consult": { role: "postona.consult.reply", model: "claude-haiku-5-5", policyVersion: "postona-maint-1" },
};
const claim = (op: string, feature = "postona.consult") => `acs_test.claim_p('${op}', 'tenant-m', '${op}', 'user', '00000000-0000-4000-8000-0000000000a1', '${feature}')`;
const reserve = (op: string) =>
  `ail_test.reserve(${claim(op)} ->> 'call_key', 1, 'anthropic', 'claude-haiku-5-5', 'postona', 'consult', 'user', '00000000-0000-4000-8000-0000000000a1', null, 0.0044)`;
const state = async (op: string, feature = "postona.consult") =>
  await psql(`select state || '|' || coalesce(result ->> 'code', '-') || '|' || coalesce(result -> 'audit' ->> 'attempts', '-') || '|' || coalesce(result -> 'audit' ->> 'costBasis', '-') from ai_calls.consumer_calls where call_key = ${claim(op, feature)} ->> 'call_key'`);

Deno.test({ name: "maintenance mock: recover, abandon with ledger-consistent audits, purge; a second tick changes nothing", ignore: !enabled, sanitizeResources: false, sanitizeOps: false }, async () => {
  await psql(`insert into ai_ledger.budget_policies (policy_key, scope_provider, scope_model, scope_application, scope_feature, scope_subject_kind, per_user, period, max_calls)
              values ('maint.consult', 'anthropic', 'claude-haiku-5-5', 'postona', 'consult', 'user', true, 'day', 1000)`);
  // A: claimed, crashed before reserving.
  await psql(`select acs_test.claim(${claim("mt-a")}); select acs_test.backdate(${claim("mt-a")}, interval '1 hour')`);
  // B: sent, crashed before settling (sent long ago -> recover_stale marks it unknown at the upper bound).
  await psql(`select acs_test.claim(${claim("mt-b")}); select ail_test.mark_sent(${reserve("mt-b")}); select acs_test.backdate(${claim("mt-b")}, interval '1 hour')`);
  await psql(`set session_replication_role = replica; update ai_ledger.reservations set sent_at = now() - interval '1 hour' where request_id = ${claim("mt-b")} ->> 'call_key'`);
  // C: reserved, never sent, hold expired (-> released).
  await psql(`select acs_test.claim(${claim("mt-c")}); select ${reserve("mt-c")}; select acs_test.backdate(${claim("mt-c")}, interval '1 hour')`);
  await psql(`set session_replication_role = replica; update ai_ledger.reservations set expires_at = now() - interval '1 minute' where request_id = ${claim("mt-c")} ->> 'call_key'`);
  // D: claimed just now (not a candidate). E: completed 25 h ago (purged). F: unregistered feature. G: sent recently.
  await psql(`select acs_test.claim(${claim("mt-d")})`);
  const owner = await psql(`select acs_test.claim(${claim("mt-e")}) ->> 'owner'`);
  await psql(`select acs_test.rpc('ai_calls_complete', acs_test.complete_p(${claim("mt-e")}, '${owner}', acs_test.ok_result(${claim("mt-e")}, '{"reply": "MAINT-SENTINEL"}')))`);
  await psql(`select acs_test.backdate(${claim("mt-e")}, interval '25 hours')`);
  await psql(`select acs_test.claim(${claim("mt-f", "postona.unregistered")}); select acs_test.backdate(${claim("mt-f", "postona.unregistered")}, interval '1 hour')`);
  await psql(`select acs_test.claim(${claim("mt-g")}); select ail_test.mark_sent(${reserve("mt-g")}); select acs_test.backdate(${claim("mt-g")}, interval '1 hour')`);
  const reservationsBefore = await psql("select count(*) from ai_ledger.reservations");

  const first = await maintenanceTick(rpc, REGISTRY);
  assert.deepEqual(first, { recovered: { released: 1, marked_unknown: 1 }, abandoned: 3, waiting: 1, unregistered: 1, purged: 1 });
  assert.equal(await state("mt-a"), "abandoned|UNKNOWN|0|no_request");
  assert.equal(await state("mt-b"), "abandoned|UNKNOWN|1|includes_upper_bound");
  assert.equal(await state("mt-c"), "abandoned|UNKNOWN|0|no_request");
  assert.equal(await state("mt-d"), "acquired|-|-|-");
  assert.equal(await state("mt-e"), "complete|UNKNOWN|1|measured");
  assert.equal(await state("mt-f", "postona.unregistered"), "acquired|-|-|-", "an unregistered feature is never guessed");
  assert.equal(await state("mt-g"), "acquired|-|-|-", "an attempt still within its grace waits");
  assert.equal(await psql("select count(*) from ai_calls.consumer_calls c where c::text like '%MAINT-SENTINEL%'"), "0");
  assert.equal(await psql("select count(*) from ai_ledger.reservations"), reservationsBefore, "nothing is (re)sent");

  const second = await maintenanceTick(rpc, REGISTRY);
  assert.deepEqual(second, { recovered: { released: 0, marked_unknown: 0 }, abandoned: 0, waiting: 1, unregistered: 1, purged: 0 });
});
