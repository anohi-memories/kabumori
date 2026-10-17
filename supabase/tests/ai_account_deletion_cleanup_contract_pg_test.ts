// The AI-cleanup reference against the REAL ledger + call-store + erasure migrations (PR249 -> PR256 -> PR261) in a
// disposable local PostgreSQL, through psql on the socket the runner gives: RPCs AS service_role, setup as the
// superuser with the test fixtures. Proves the shapes the offline test assumes are the shapes the SQL returns.
// Run by supabase/tests/ai_account_deletion_cleanup_contract_run.sh; skipped without its environment.
import assert from "node:assert/strict";
import { BRIDGE_MAX_DEADLINE_MS, DEFAULT_MARGIN_MS, runAiAccountCleanup } from "./ai_account_deletion_cleanup_contract.ts";

const HOST = Deno.env.get("ACS_PGHOST");
const PORT = Deno.env.get("ACS_PGPORT");
const SUPER = Deno.env.get("ACS_PGSUPER");
const DB = Deno.env.get("ACS_DB");
const enabled = !!HOST && !!PORT && !!SUPER && !!DB && /^\/(private\/)?tmp\//.test(HOST);
const opts = { ignore: !enabled, sanitizeOps: false, sanitizeResources: false };

async function psql(statement: string): Promise<string> {
  const output = await new Deno.Command("psql", {
    args: ["-X", "-h", HOST!, "-p", PORT!, "-U", SUPER!, "-d", DB!, "-Atq", "-v", "ON_ERROR_STOP=1", "-c", statement],
    env: { LC_ALL: "C" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = (b: Uint8Array) => new TextDecoder().decode(b).trim();
  if (!output.success) throw new Error(`psql: ${text(output.stderr).split("\n")[0]}`);
  return text(output.stdout);
}
async function rpc(name: string, p: Record<string, unknown>): Promise<unknown> {
  if (!/^ai_(calls|ledger)_[a-z_]+$/.test(name)) throw new Error("unexpected rpc");
  const json = JSON.stringify(p);
  if (json.includes("$acs$")) throw new Error("payload contains the quote tag");
  return JSON.parse(await psql(`set role service_role; select public.${name}($acs$${json}$acs$::jsonb)`));
}

const user = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const slugOf = (n: number) => `u_${String(n).padStart(24, "0")}`;
const ready = { entitlementsEndedAtMs: 0, aiAuthorizationStopped: true, nowMs: BRIDGE_MAX_DEADLINE_MS + DEFAULT_MARGIN_MS };
const userClaim = (op: string, n: number) => `acs_test.claim_p('${op}', 'tenant-${n}', '${op}', 'user', '${user(n)}', 'postona.consult', '${slugOf(n)}')`;
const systemClaim = (op: string, n: number) => `acs_test.claim_p('${op}', 'system-postona', '${op}', 'system', null, 'postona.ai_lab', '${slugOf(n)}')`;
async function finished(claim: string) {
  const owner = await psql(`select acs_test.claim(${claim}) ->> 'owner'`);
  await psql(`select acs_test.rpc('ai_calls_complete', acs_test.complete_p(${claim}, '${owner}', acs_test.fail_result(${claim}, 'PROVIDER_FAILED')))`);
}

Deno.test({ name: "setup: a fully scoped per-user policy for the seeded calls", ...opts }, async () => {
  await psql(`insert into ai_ledger.budget_policies (policy_key, scope_provider, scope_model, scope_application, scope_feature, scope_subject_kind, per_user, period, max_calls)
              values ('contract.consult.user', 'anthropic', 'claude-haiku-5-5', 'postona', 'consult', 'user', true, 'day', 1000)`);
});

Deno.test({ name: "a person with call-store rows, system rows of their workspace, ledger rows and an own policy: done, nothing left; a second pass is done with zeros", ...opts }, async () => {
  const n = 1;
  await psql(`insert into ai_ledger.budget_policies (policy_key, scope_application, scope_subject_kind, scope_user_id, period, max_calls, note)
              values ('override.user.${user(n)}', 'postona', 'user', '${user(n)}', 'month', 500, 'ticket: jane@example.com')`);
  await psql(`select aue_test.seed_user('${user(n)}', 'contract-${n}')`);
  await finished(userClaim("c1-a", n));
  await finished(userClaim("c1-b", n));
  await finished(systemClaim("c1-sys", n));
  const first = await runAiAccountCleanup(rpc, { userId: user(n), workspaceSlug: slugOf(n), ...ready });
  assert.deepEqual(first, {
    status: "done",
    callRowsDeleted: 2,
    systemBrandRowsDeleted: 1,
    // one per-user bucket (the daily per-user policy); the person's own override policy is not per-user
    erased: { reservations: 4, usage_events: 3, budget_buckets: 1, budget_policies: 1 },
    footprint: { reservations: 0, usage_events: 0, budget_buckets: 0, budget_policies: 0, policy_mentions: 0, call_rows: 0, brand_call_rows: 0 },
  });
  assert.equal(await psql(`select aue_test.mentions('${user(n)}') + aue_test.mentions('jane@example.com') + aue_test.mentions('${slugOf(n)}')`), "0");
  const second = await runAiAccountCleanup(rpc, { userId: user(n), workspaceSlug: slugOf(n), ...ready });
  assert.deepEqual(second, {
    status: "done",
    callRowsDeleted: 0,
    systemBrandRowsDeleted: 0,
    erased: { reservations: 0, usage_events: 0, budget_buckets: 0, budget_policies: 0 },
    footprint: { reservations: 0, usage_events: 0, budget_buckets: 0, budget_policies: 0, policy_mentions: 0, call_rows: 0, brand_call_rows: 0 },
  });
});

Deno.test({ name: "in flight: the person's own claim, a system claim of their workspace, a ledger attempt -> retry later at that step", ...opts }, async () => {
  await psql(`select acs_test.claim(${userClaim("c2", 2)})`);
  assert.deepEqual(await runAiAccountCleanup(rpc, { userId: user(2), workspaceSlug: slugOf(2), ...ready }),
    { status: "retry_later", step: "forget_user", reason: "CALLS_IN_FLIGHT", detail: { in_flight: 1 } });

  await psql(`select acs_test.claim(${systemClaim("c3-sys", 3)})`);
  assert.deepEqual(await runAiAccountCleanup(rpc, { userId: user(3), workspaceSlug: slugOf(3), ...ready }),
    { status: "retry_later", step: "forget_system_brand", reason: "CALLS_IN_FLIGHT", detail: { in_flight: 1 } });

  await psql(`select ail_test.reserve(aue_test.request('contract-4-open'), 1, 'anthropic', 'claude-haiku-5-5', 'postona', 'consult', 'user', '${user(4)}', null, 0.0044)`);
  assert.deepEqual(await runAiAccountCleanup(rpc, { userId: user(4), workspaceSlug: null, ...ready }),
    { status: "retry_later", step: "erase_user", reason: "LEDGER_IN_FLIGHT", detail: { in_flight: 1 } });
  assert.equal(await psql(`select aue_test.footprint('${user(4)}') ->> 'reservations'`), "1", "nothing was erased");
});

Deno.test({ name: "a policy that is not the person's names them: operator required; after the operator's fix the next pass is done", ...opts }, async () => {
  const n = 5;
  await psql(`select aue_test.seed_user('${user(n)}', 'contract-${n}')`);
  await psql(`insert into ai_ledger.budget_policies (policy_key, scope_provider, period, max_calls, note) values ('ops.slip.${n}', 'openai', 'month', 1, 'debug ${user(n)}')`);
  assert.deepEqual(await runAiAccountCleanup(rpc, { userId: user(n), workspaceSlug: null, ...ready }),
    { status: "operator_required", step: "erase_user", reason: "POLICY_TEXT_MENTIONS_USER", detail: { policies: 1 } });
  await psql(`update ai_ledger.budget_policies set note = null where policy_key = 'ops.slip.${n}'`);
  const result = await runAiAccountCleanup(rpc, { userId: user(n), workspaceSlug: null, ...ready });
  assert.equal(result.status, "done");
});

Deno.test({ name: "the real SQL refuses forms the reference never sends (upper-case id, a slug as id, REPEATABLE READ)", ...opts }, async () => {
  const lettered = "00000000-0000-4000-8000-0000000000ab";
  await assert.rejects(rpc("ai_calls_forget_user", { user_id: lettered.toUpperCase() }), /AI_CALLS_INVALID_INPUT/);
  await assert.rejects(rpc("ai_ledger_erase_user", { user_id: slugOf(6) }), /AI_LEDGER_INVALID_INPUT/);
  await assert.rejects(rpc("ai_calls_forget_system_brand", { brand_ref: user(6) }), /AI_CALLS_INVALID_INPUT/);
  await assert.rejects(psql(`begin isolation level repeatable read; set local role service_role; select public.ai_ledger_erase_user('{"user_id": "${user(6)}"}'); commit;`),
    /REQUIRES_READ_COMMITTED/);
});
