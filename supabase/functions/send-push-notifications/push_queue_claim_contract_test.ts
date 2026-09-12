import assert from "node:assert/strict";
import test from "node:test";

const migration = await Deno.readTextFile(
  new URL(
    "../../migrations/20260912100000_harden_push_notification_claims.sql",
    import.meta.url,
  ),
);
const dispatcher = await Deno.readTextFile(
  new URL("./index.ts", import.meta.url),
);

test("claim RPC uses one atomic pending-row claim with SKIP LOCKED", () => {
  assert.match(
    migration,
    /create or replace function public\.claim_pending_push_notifications\(p_limit integer default 200\)/i,
  );
  assert.match(migration, /for update of n skip locked/i);
  assert.match(migration, /where n\.push_status = 'pending'/i);
  assert.match(migration, /set push_status = 'processing'/i);
  assert.match(
    migration,
    /push_claim_token = pg_catalog\.gen_random_uuid\(\)/i,
  );
  assert.match(migration, /push_attempt_count = n\.push_attempt_count \+ 1/i);
  assert.match(
    migration,
    /returns table\s*\(\s*id uuid,\s*user_id uuid/i,
  );
  const claimRpc = migration.slice(
    migration.indexOf("create or replace function"),
  );
  assert.doesNotMatch(claimRpc, /insert into public\.notifications/i);
});

test("sent and failed states are not claimable, and expired claims fail closed", () => {
  assert.match(
    migration,
    /where n\.push_status = 'pending'[\s\S]*?for update of n skip locked/i,
  );
  assert.match(
    migration,
    /set push_status = 'failed'[\s\S]*?where n\.push_status = 'processing'/i,
  );
  assert.match(
    migration,
    /push_last_error_code = 'PUSH_DELIVERY_OUTCOME_UNKNOWN'/i,
  );
  assert.doesNotMatch(
    migration,
    /set push_status = 'pending'[\s\S]{0,120}processing/i,
  );
});

test("dispatch claim rechecks global and safely identifiable source opt-outs", () => {
  assert.match(migration, /s\.push_enabled/i);
  assert.match(migration, /s\.important_news/i);
  assert.match(migration, /s\.market_critical_news/i);
  assert.match(migration, /s\.morning_report/i);
  assert.match(migration, /s\.close_report/i);
  assert.match(
    migration,
    /c\.id::text = n\.source_id and c\.company_code is null/i,
  );
  assert.match(
    migration,
    /r\.id::text = n\.source_id[\s\S]*?r\.user_id = n\.user_id/i,
  );
  assert.match(
    migration,
    /push_last_error_code = 'PUSH_DISABLED_BEFORE_DISPATCH'/i,
  );
});

test("claim RPC is service-role only and bounded to the dispatcher batch size", () => {
  assert.match(
    migration,
    /least\(greatest\(coalesce\(p_limit, 200\), 1\), 200\)/i,
  );
  assert.match(
    migration,
    /revoke all on function public\.claim_pending_push_notifications\(integer\)[\s\S]*?from public, anon, authenticated/i,
  );
  assert.match(
    migration,
    /grant execute on function public\.claim_pending_push_notifications\(integer\) to service_role/i,
  );
  assert.match(migration, /set search_path = ''/i);
});

test("dispatcher uses the RPC claim and finalizes only the matching processing claim", () => {
  assert.match(dispatcher, /\/rest\/v1\/rpc\/claim_pending_push_notifications/);
  assert.match(dispatcher, /push_status=eq\.processing&push_claim_token=eq\./);
  assert.match(
    dispatcher,
    /if \(!result\.ok\)\s*\{\s*throw new Error\(`UPDATE_CLAIMED_NOTIFICATION_FAILED/,
  );
  assert.match(dispatcher, /if \(updated\.length !== 1\)/);
  assert.doesNotMatch(
    dispatcher,
    /\/rest\/v1\/notifications\?push_status=eq\.pending/,
  );
});

test("ambiguous Expo transport failures are terminal and never reset claims to pending", () => {
  assert.match(
    dispatcher,
    /A transport\/HTTP failure after a request begins is ambiguous/,
  );
  assert.match(dispatcher, /finalizeUnknownProviderOutcome\(/);
  assert.match(
    dispatcher,
    /status: "failed",\s*errorCode: "PUSH_DELIVERY_OUTCOME_UNKNOWN"/,
  );
  assert.doesNotMatch(
    dispatcher,
    /EXPO_PUSH_OUTCOME_UNKNOWN[\s\S]{0,160}status: "pending"/,
  );
});
