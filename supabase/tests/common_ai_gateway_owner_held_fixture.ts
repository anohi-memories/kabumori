// G6-11 / G6-12 (2026-10-20): TEST-ONLY SQL fixtures for the owner-held check of the R1 root, and the helpers the
// G6-12 isolation tests share. NONE of this is a migration: every statement here is run by a test inside the runner's
// disposable scratch database only (common_ai_gateway_restart_race_pg_run.sh), never on a Supabase project, and
// gateway.ts calls none of it. A real change needs a separate approved TASK and a Codex Sol (high) review.
//
// G6-12 (H3 #330 P2, CHANGES_REQUIRED_P2_CONTRACT_ISOLATION): the PR384 candidate's "held -> send" argument relies on
// ai_calls_abandon seeing the open reservation. abandon reads the ledger with a plain SELECT, so a recovery
// transaction whose REPEATABLE READ / SERIALIZABLE snapshot predates the reservation does not see it, closes the row,
// and forget_user + a re-claim can follow; the old owner's mark_sent is then still allowed. Two candidate guards:
//   GUARD_FIXTURE_SQL  (proposal 1): the mutators refuse any isolation but READ COMMITTED (as the existing
//                       ai_calls_forget_system_brand already does), checked from inside the function.
//   FENCE_FIXTURE_SQL  (proposal 2): isolation-independent: held stamps its own acquired row (fence_seq + 1), so an
//                       abandon whose snapshot predates the stamp hits a write-write conflict (40001) on its existing
//                       FOR UPDATE, and one whose snapshot follows it sees the reservation committed before the stamp.
import assert from "node:assert/strict";
import { age, answer, codeOf, gateway, keyOf, paused, psql, resume, resumeAt, rows, sends } from "./common_ai_gateway_restart_race_support.ts";

/** The candidate (TEST-ONLY; see the header). */
export const OWNER_HELD_CANDIDATE_SQL = `
create function public.ai_calls_claim_held(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_key text := ai_calls.input_text(p, 'call_key', true, '^h5m2_[0-9a-f]{64}$');
  v_tenant text := ai_calls.input_text(p, 'tenant_tag', true, '^[0-9a-f]{64}$');
  v_fingerprint text := ai_calls.input_text(p, 'fingerprint', true, '^[0-9a-f]{64}$');
  v_application text := ai_calls.input_text(p, 'application', true, '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$');
  v_feature text := ai_calls.input_text(p, 'feature', true, '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$');
  v_subject text := ai_calls.input_text(p, 'subject_kind', true, '^(system|user)$');
  v_user uuid := ai_calls.input_uuid(p, 'user_id', false);
  v_brand text := ai_calls.input_text(p, 'brand_ref', false, '^[a-z][a-z0-9_]{1,40}$');
  v_owner uuid := ai_calls.input_uuid(p, 'owner', true);
  v_row ai_calls.consumer_calls;
begin
  if (v_subject = 'system' and v_user is not null) or (v_subject = 'user' and v_user is null) then
    raise exception 'AI_CALLS_INVALID_INPUT: subject' using errcode = '22023';
  end if;
  -- The same locks, in the same order, as ai_calls_claim: the person's lock shared (forget_user takes it exclusive),
  -- then the call key's (ai_calls_claim and ai_calls_abandon take it), then the row FOR SHARE (ai_calls_complete
  -- takes it FOR UPDATE). Nothing is inserted or updated: a missing row stays missing.
  if v_subject = 'user' then
    perform pg_advisory_xact_lock_shared(hashtextextended('ai_calls:user:' || v_user::text, 0));
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ai_calls:call:' || v_key, 0));
  select c.* into v_row from ai_calls.consumer_calls c where c.call_key = v_key for share;
  if not found then
    return jsonb_build_object('held', false, 'reason', 'NOT_FOUND');
  end if;
  if (v_row.tenant_tag, v_row.fingerprint, v_row.application, v_row.feature, v_row.subject_kind, v_row.user_id, v_row.brand_ref)
     is distinct from (v_tenant, v_fingerprint, v_application, v_feature, v_subject, v_user, v_brand) then
    return jsonb_build_object('held', false, 'reason', 'IDENTITY_MISMATCH');
  end if;
  if v_row.state <> 'acquired' then
    return jsonb_build_object('held', false, 'reason', 'NOT_ACQUIRED');
  end if;
  if v_row.claim_token is distinct from v_owner then
    return jsonb_build_object('held', false, 'reason', 'OWNER_MISMATCH');
  end if;
  return jsonb_build_object('held', true);
end;
$$;
revoke all on function public.ai_calls_claim_held(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.ai_calls_claim_held(jsonb) to service_role;
`;

/**
 * Proposal 1 (TEST-ONLY): a READ COMMITTED guard in front of ai_calls_abandon and ai_calls_forget_user, and in the
 * candidate. In the fixture the existing functions are renamed and wrapped (so the shared bodies are not copied);
 * in a real migration the same three lines go at the top of each body.
 */
export const GUARD_FIXTURE_SQL = `
alter function public.ai_calls_abandon(jsonb) rename to ai_calls_abandon_unguarded;
alter function public.ai_calls_forget_user(jsonb) rename to ai_calls_forget_user_unguarded;
revoke all on function public.ai_calls_abandon_unguarded(jsonb), public.ai_calls_forget_user_unguarded(jsonb) from public, anon, authenticated, service_role;
create function public.ai_calls_abandon(p jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'AI_CALLS_REQUIRES_READ_COMMITTED: %', current_setting('transaction_isolation') using errcode = 'P0001';
  end if;
  return public.ai_calls_abandon_unguarded(p);
end;
$$;
create function public.ai_calls_forget_user(p jsonb) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'AI_CALLS_REQUIRES_READ_COMMITTED: %', current_setting('transaction_isolation') using errcode = 'P0001';
  end if;
  return public.ai_calls_forget_user_unguarded(p);
end;
$$;
revoke all on function public.ai_calls_abandon(jsonb), public.ai_calls_forget_user(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.ai_calls_abandon(jsonb), public.ai_calls_forget_user(jsonb) to service_role;
` + OWNER_HELD_CANDIDATE_SQL.replace(
  "begin\n  if (v_subject = 'system'",
  "begin\n  if current_setting('transaction_isolation') <> 'read committed' then\n    raise exception 'AI_CALLS_REQUIRES_READ_COMMITTED: %', current_setting('transaction_isolation') using errcode = 'P0001';\n  end if;\n  if (v_subject = 'system'",
);

/**
 * Proposal 2 (TEST-ONLY): held writes. A new column fence_seq on ai_calls.consumer_calls, the transition trigger
 * allowing acquired -> acquired only when fence_seq alone grows by one, and held = "UPDATE my own acquired row with my
 * original token, RETURNING". Still never INSERTs. ai_calls_abandon is NOT changed: its existing row FOR UPDATE is
 * what conflicts with the stamp.
 */
export const FENCE_FIXTURE_SQL = `
alter table ai_calls.consumer_calls add column fence_seq bigint not null default 0;
create or replace function ai_calls.call_transition()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.call_key, new.tenant_tag, new.fingerprint, new.application, new.feature, new.subject_kind, new.user_id,
      new.brand_ref, new.lifecycle_version, new.claim_token, new.created_at)
     is distinct from
     (old.call_key, old.tenant_tag, old.fingerprint, old.application, old.feature, old.subject_kind, old.user_id,
      old.brand_ref, old.lifecycle_version, old.claim_token, old.created_at) then
    raise exception 'AI_CALLS_IDENTITY_IMMUTABLE' using errcode = 'P0001';
  end if;
  -- G6-12 fixture: the owner-held stamp (acquired -> acquired, fence_seq + 1, nothing else).
  if old.state = 'acquired' and new.state = 'acquired' and new.fence_seq = old.fence_seq + 1
     and (to_jsonb(new) - 'fence_seq') = (to_jsonb(old) - 'fence_seq') then
    return new;
  end if;
  if new.fence_seq is distinct from old.fence_seq then
    raise exception 'AI_CALLS_FENCE_SEQ' using errcode = 'P0001';
  end if;
  if old.state = 'acquired' and new.state in ('complete', 'abandoned') then
    return new;
  end if;
  if old.state = 'complete' and new.state = 'complete' and old.content_purged_at is null
     and new.content_purged_at is not null and new.audit = old.audit and new.completed_at = old.completed_at
     and new.result = ai_calls.tombstone(old.audit) then
    return new;
  end if;
  raise exception 'AI_CALLS_TRANSITION: % -> %', old.state, new.state using errcode = 'P0001';
end;
$$;
` + OWNER_HELD_CANDIDATE_SQL.replace(
  "  select c.* into v_row from ai_calls.consumer_calls c where c.call_key = v_key for share;\n  if not found then",
  "  -- G6-12 proposal 2: stamp my own acquired row (a write the abandon's FOR UPDATE conflicts with); never insert.\n  update ai_calls.consumer_calls c set fence_seq = c.fence_seq + 1\n   where c.call_key = v_key and c.state = 'acquired' and c.claim_token = v_owner\n     and (c.tenant_tag, c.fingerprint, c.application, c.feature, c.subject_kind, c.user_id, c.brand_ref)\n         is not distinct from (v_tenant, v_fingerprint, v_application, v_feature, v_subject, v_user, v_brand)\n  returning c.* into v_row;\n  if found then\n    return jsonb_build_object('held', true);\n  end if;\n  select c.* into v_row from ai_calls.consumer_calls c where c.call_key = v_key for share;\n  if not found then",
);

export type Isolation = "read committed" | "repeatable read" | "serializable";
export const USER_C = "00000000-0000-4000-8000-0000000000c3";
const TOMB = { role: "postona.consult.reply", model: "gpt-6-luna", policyVersion: "r1", attempts: 0, estimatedCostUsd: 0, costBasis: "no_request" };

async function service(name: string, p: unknown): Promise<{ ok: boolean; out: string; err: string }> {
  return await psql(`set role service_role; select public.${name}($j$${JSON.stringify(p)}$j$::jsonb)`);
}
async function serviceJson(name: string, p: unknown): Promise<Record<string, unknown>> {
  const r = await service(name, p);
  assert.ok(r.ok, `${name}: ${r.err}`);
  return JSON.parse(r.out);
}
/** A second session that runs `sql` in its own transaction (stdout / stderr / SQLSTATE kept). */
export function session(sql: string) {
  const host = Deno.env.get("GRR_PGHOST")!, port = Deno.env.get("GRR_PGPORT")!, superuser = Deno.env.get("GRR_PGSUPER")!, db = Deno.env.get("GRR_DB")!;
  const child = new Deno.Command("psql", {
    args: ["-X", "-h", host, "-p", port, "-U", superuser, "-d", db, "-Atq", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-c", sql],
    env: { LC_ALL: "C" },
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  return child.output().then((o) => {
    const err = new TextDecoder().decode(o.stderr).trim();
    return { ok: o.success, out: new TextDecoder().decode(o.stdout).trim(), err, sqlstate: err.match(/ERROR:\s+([0-9A-Z]{5}):/)?.[1] ?? null };
  });
}
export async function sleeping(marker: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if ((await rows(`select count(*) from pg_stat_activity where query like '%${marker}%' and wait_event = 'PgSleep'`)) !== "0") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`session ${marker} never slept`);
}
/** A recovery transaction at `isolation`: its snapshot is taken by reading the candidates FIRST, then it waits, then abandons. */
export function recoveryTransaction(isolation: Isolation, key: string, tenantTag: string, marker: string) {
  const audit = { ...TOMB, callId: key, tenantTag, feature: "postona:consult" };
  return session(`set role service_role; begin isolation level ${isolation};
    select jsonb_array_length(public.ai_calls_recovery_candidates('{"older_than_seconds": 300}'::jsonb));
    select pg_sleep(2) /* ${marker} */;
    select public.ai_calls_abandon($j$${JSON.stringify({ call_key: key, older_than_seconds: 300, audit })}$j$::jsonb);
    commit;`);
}

/**
 * The H3 chain at the SQL level (no gateway, no provider): A's claim; a recovery transaction at `isolation` whose
 * snapshot predates A's reservation; A reserves attempt 1 and its held check (with the original token) answers held;
 * the recovery abandons (or not); forget_user; B re-claims; A's mark_sent with its original reservation.
 * Returns what happened at each step; the caller asserts the SAFETY condition.
 */
export async function snapshotChain(isolation: Isolation, n: string) {
  // One person per chain (forget_user refuses while any of the person's rows is acquired; B's row stays acquired).
  const user = `00000000-0000-4000-8000-0000000000${n}${n}`;
  const p = { call_key: "h5m2_" + n.repeat(64), tenant_tag: n.repeat(64), fingerprint: n.repeat(64), application: "postona", feature: "postona:consult", subject_kind: "user", user_id: user, brand_ref: "brand_c" };
  const a = await serviceJson("ai_calls_claim", p);
  await rows(`set session_replication_role = replica; update ai_calls.consumer_calls set created_at = created_at - interval '1900 seconds' where call_key = '${p.call_key}'`);
  const marker = `g612-${n}`;
  const recovery = recoveryTransaction(isolation, p.call_key, p.tenant_tag, marker);
  await sleeping(marker);
  const reserve = await serviceJson("ai_ledger_reserve", {
    request_id: p.call_key, attempt: 1, provider: "openai", model: "gpt-6-luna", application: "postona", feature: "consult",
    logical_role: "postona.consult.reply", subject_kind: "user", user_id: user, amount_usd: 0.001, hold_seconds: 900,
  });
  const heldAnswer = await serviceJson("ai_calls_claim_held", { ...p, owner: a.owner });
  const r = await recovery;
  const abandon = r.ok ? JSON.parse(r.out.split("\n").at(-1)!) : { error: r.sqlstate, message: r.err.split("\n")[0] };
  const stateAfter = await rows(`select coalesce((select state from ai_calls.consumer_calls where call_key = '${p.call_key}'), '-')`);
  const forget = await service("ai_calls_forget_user", { user_id: user });
  const forgot = forget.ok ? JSON.parse(forget.out) : { error: forget.err.split("\n")[0] };
  let reclaimed = false;
  if (forgot.forgotten === true) {
    const b = await serviceJson("ai_calls_claim", p);
    reclaimed = b.kind === "acquired" && b.owner !== a.owner;
  }
  const markSent = await serviceJson("ai_ledger_mark_sent", { reservation_id: reserve.reservation_id });
  return { held: heldAnswer.held, abandon, stateAfter, forgot: forgot.forgotten ?? forgot.error, reclaimed, markSent: markSent.may_send };
}

export const JWT_C1 = "g6r-user-c.session-1.sig";
/** Person C (fake G5 session, entitlement, brand_c) for the separate-process scenario. */
export async function setupPersonC(): Promise<void> {
  await rows(`insert into g6r_fake.sessions values ('${JWT_C1}', '${USER_C}', 'sc1', 'active');
    insert into g6r_fake.entitlements values ('${USER_C}', 'postona:x_autopost');
    insert into g6r_fake.brands values ('brand_c', '${USER_C}', 21, 1)`);
}

/**
 * The H3 chain end to end, with SEPARATE PROCESSES and the fake provider: A (owner-held gateway) claims and waits;
 * a recovery transaction at `isolation` takes its snapshot (before A's reservation) and sleeps; A reserves, its held
 * check answers and A waits again; the recovery abandons (or not); forget_user; if it forgot, B re-claims and waits;
 * A goes on (recheck, mark_sent, the provider); then B. Returns what happened; the caller asserts the SAFETY condition.
 */
export async function processChain(isolation: Isolation, op: string) {
  const who = { credential: JWT_C1, brand: "brand_c", ownerHeld: true } as const;
  const k = await keyOf(op, { user: USER_C, brand: "brand_c" });
  const a = gateway(op, { ...who, pauseAt: ["after:ai_calls_claim", "after:ai_calls_claim_held#1"], trace: true });
  await paused(a, "after:ai_calls_claim");
  await age(k, 1900);
  const tenant = await rows(`select tenant_tag from ai_calls.consumer_calls where call_key = '${k}'`);
  const marker = `g612-e2e-${isolation.replace(" ", "-")}`;
  const recovery = recoveryTransaction(isolation, k, tenant, marker);
  await sleeping(marker);
  await resumeAt(a, "after:ai_calls_claim");
  await paused(a, "after:ai_calls_claim_held#1");
  const r = await recovery;
  const abandon = r.ok ? JSON.parse(r.out.split("\n").at(-1)!) : { error: r.sqlstate };
  const forget = await psql(`set role service_role; select public.ai_calls_forget_user('{"user_id": "${USER_C}"}'::jsonb)`);
  const forgot = forget.ok ? JSON.parse(forget.out).forgotten : "error";
  let b: ReturnType<typeof gateway> | null = null;
  if (forgot === true) {
    b = gateway(op, { ...who, pauseAt: "after:ai_calls_claim" });
    await paused(b, "after:ai_calls_claim");
  }
  await resumeAt(a, "after:ai_calls_claim_held#1");
  const ra = codeOf(await answer(a));
  let rb = "-";
  if (b) {
    await resume(b);
    rb = codeOf(await answer(b));
  }
  return { abandon: abandon.abandoned ?? abandon.reason ?? abandon.error, forgot, reclaimed: b !== null, a: ra, b: rb, sends: await sends(op), key: k };
}

export const SAFE_END = { closed: false, reclaimed: false, nonOwnerSends: 0 };
export const safeEnd = (o: Awaited<ReturnType<typeof processChain>>) => ({ closed: o.abandon === true, reclaimed: o.reclaimed, nonOwnerSends: o.reclaimed ? o.sends : 0 });
/** The safety the held -> send argument needs: while A's reservation is open, nobody closes, forgets or re-claims A's call. */
export const SAFE = { held: true, abandon: "LEDGER_NOT_FINAL-or-refused", stateAfter: "acquired", forgot: "CALLS_IN_FLIGHT-or-refused", reclaimed: false, markSent: true };
export const asSafety = (o: Awaited<ReturnType<typeof snapshotChain>>) => ({
  held: o.held,
  abandon: o.abandon && typeof o.abandon === "object" && "abandoned" in o.abandon && o.abandon.abandoned === true ? "ABANDONED" : "LEDGER_NOT_FINAL-or-refused",
  stateAfter: o.stateAfter,
  forgot: o.forgot === true ? "FORGOTTEN" : "CALLS_IN_FLIGHT-or-refused",
  reclaimed: o.reclaimed,
  markSent: o.markSent,
});
