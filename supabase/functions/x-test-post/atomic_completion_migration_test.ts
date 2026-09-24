import assert from "node:assert/strict";
import test from "node:test";

const sql = await Deno.readTextFile(new URL("../../migrations/20260924180000_x_autopost_phase1f_atomic_completion.sql", import.meta.url));
const code = sql.replace(/--.*$/gmu, "");
const dispatcher = await Deno.readTextFile(new URL("./index.ts", import.meta.url));

function definition(name: string): string {
  const match = code.match(new RegExp(`create function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`, "u"));
  assert.ok(match, `missing ${name}`);
  return match[0];
}

test("single explicit transaction with a drift assertion before any change", () => {
  assert.match(code, /^\s*begin;/u);
  assert.match(code, /commit;\s*$/u);
  const assertAt = code.indexOf("PHASE1F_PRECONDITION_ATTEMPT_CONSTRAINTS_DRIFTED");
  assert.ok(assertAt > 0 && assertAt < code.indexOf("alter table"));
  assert.doesNotMatch(code, /create\s+or\s+replace/iu);
  assert.doesNotMatch(code, /create\s+(or\s+replace\s+)?function\s+public\.(complete_(tip|interaction|useful_tip|morning_report|close_report|us_premarket_report|morning_greeting)_post|retry_scheduled_post|fail_scheduled_post|claim_due_post)\s*\(/iu);
});

test("x_rejected is terminal, provider-started, id-less and coded", () => {
  assert.match(code, /'x_outcome_uncertain', 'x_rejected',\s+'x_confirmed_db_incomplete', 'completed'/u);
  assert.match(code, /outcome = 'x_rejected' and provider_started_at is not null and x_post_id is null and error_code is not null/u);
  const rejected = definition("record_post_x_rejected_v2");
  assert.match(rejected, /v_attempt\.phase <> 'provider_started' or v_attempt\.outcome is not null/u);
  assert.match(rejected, /set status = 'failed'/u);
});

test("confirmed completion validates identity, is exactly-once and never moves backwards", () => {
  const core = definition("x_v2_finish_confirmed_attempt");
  assert.match(core, /a\.claim_token = p_claim_token for update/u);
  assert.match(core, /X_COMPLETION_ACCOUNT_MISMATCH/u);
  assert.match(core, /X_COMPLETION_POST_TYPE_MISMATCH/u);
  assert.match(core, /return 'already_completed'/u);
  assert.match(core, /v_attempt\.phase = 'provider_started' and v_attempt\.outcome is null/u);
  assert.match(core, /v_attempt\.outcome = 'x_confirmed_db_incomplete'/u);
  assert.match(core, /raise exception 'ATTEMPT_NOT_CONFIRMABLE'/u);
  assert.match(core, /X_COMPLETION_OUTSIDE_V2_DOMAIN/u);
});

test("typed completions reproduce the legacy side effects inside the same function", () => {
  const interaction = definition("complete_interaction_post_v2");
  assert.match(interaction, /update public\.interaction_topics\s+set last_used_at = now\(\), use_count = use_count \+ 1/u);
  assert.match(interaction, /insert into public\.interaction_post_metrics/u);
  assert.match(interaction, /'Interaction X post created; topic=' \|\| p_interaction_topic_id::text/u);
  const useful = definition("complete_useful_tip_post_v2");
  assert.match(useful, /update public\.useful_tips set last_used_at = now\(\), use_count = use_count \+ 1/u);
  assert.match(useful, /'Verified useful tip posted'/u);
  const report = definition("x_v2_complete_report_run");
  for (const [table, message] of [["morning_report_runs", "Morning report posted"], ["close_report_runs", "Close report posted"], ["us_premarket_report_runs", "US premarket report posted"]]) {
    assert.match(report, new RegExp(`update public\\.${table} r set status = 'succeeded', x_post_id = p_x_post_id, error = null`, "u"), table);
    assert.ok(report.includes(`'${message}'`), message);
  }
  assert.match(report, /X_COMPLETION_RUN_POST_MISMATCH/u);
  for (const fn of [interaction, useful, definition("complete_report_post_v2")]) {
    assert.match(fn, /if v_result = 'completed' then/u);
    assert.match(fn, /set_config\('kabumori\.x_queue_domain', 'v2', true\)/u);
  }
});

test("provider steps are sequential, never restarted, and chained", () => {
  const begin = definition("begin_provider_step_v2");
  assert.match(begin, /PROVIDER_STEP_ALREADY_STARTED/u);
  assert.match(begin, /PROVIDER_STEP_OUT_OF_ORDER/u);
  assert.match(begin, /p_step_no = 1 and p_step_kind = 'create_reply'/u);
  assert.match(begin, /PROVIDER_STEP_FIRST_MUST_CREATE/u);
  assert.match(begin, /PROVIDER_STEP_PREVIOUS_NOT_CONFIRMED/u);
  assert.match(begin, /PROVIDER_STEP_KIND_SEQUENCE_INVALID/u);
  assert.match(begin, /PROVIDER_STEP_PARENT_MISMATCH/u);
  const finish = definition("finish_provider_step_v2");
  assert.match(finish, /a\.claim_token = p_claim_token for update/u);
  assert.match(finish, /v_attempt\.phase <> 'provider_started' or v_attempt\.outcome is not null/u);
  assert.match(code, /primary key \(attempt_id, step_no\)/u);
});

test("ACL: typed RPCs service_role-only, internals API-closed, generic completion retired, ledger read-only", () => {
  const defs = code.match(/create function public\.[\s\S]*?\n\$\$;/gu) ?? [];
  assert.equal(defs.length, 10);
  for (const def of defs) assert.match(def, /security definer set search_path = ''/u);
  assert.match(code, /from public, anon, authenticated, service_role;\s+grant execute on function/u);
  assert.match(code, /revoke execute on function public\.complete_post_x_confirmed_v2\(uuid, uuid, text\) from service_role;/u);
  assert.match(code, /revoke all on public\.post_provider_steps_v2 from public, anon, authenticated, service_role;/u);
  assert.match(code, /revoke insert, update, delete, truncate on public\.post_queue_attempts_v2, public\.post_queue_account_turns_v2\s+from service_role;/u);
  assert.match(code, /revoke insert, update, delete, truncate on public\.scheduled_posts\s+from public, anon, authenticated, service_role;/u);
  const grant = code.slice(code.lastIndexOf("grant execute on function"));
  assert.doesNotMatch(grant, /x_v2_/u);
});

test("live dispatcher is not wired to Phase1F", () => {
  assert.doesNotMatch(dispatcher, /_post_v2|record_post_x_rejected_v2|provider_step_v2|x_v2_outcome_ledger/u);
});
