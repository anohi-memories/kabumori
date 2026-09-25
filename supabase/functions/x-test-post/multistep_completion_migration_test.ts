import assert from "node:assert/strict";
import test from "node:test";

const sql = await Deno.readTextFile(new URL("../../migrations/20260925090000_x_autopost_phase1g_multistep_completion.sql", import.meta.url));
const code = sql.replace(/--.*$/gmu, "");
const dispatcher = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
const greetingPublisher = await Deno.readTextFile(new URL("./morning_greeting_publish_logic.ts", import.meta.url));

function definition(name: string): string {
  const match = code.match(new RegExp(`create function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`, "u"));
  assert.ok(match, `missing ${name}`);
  return match[0];
}

test("one explicit transaction, preconditions first, additive only", () => {
  assert.match(code, /^\s*begin;/u);
  assert.match(code, /commit;\s*$/u);
  const firstChange = code.search(/create table|alter table|create function/u);
  assert.ok(code.indexOf("PHASE1G_PRECONDITION_PHASE1F_MISSING") < firstChange);
  assert.ok(code.indexOf("PHASE1G_PRECONDITION_PUBLISH_CLAIMS_NOT_BRAND_SCOPED") < firstChange);
  assert.doesNotMatch(code, /create\s+or\s+replace|\bdrop\s/iu);
  assert.doesNotMatch(code, /create\s+function\s+public\.(complete_tip_post|complete_morning_greeting_post|claim_due_post|begin_provider_step_v2|finish_provider_step_v2)\s*\(/iu);
});

test("plans fix count and shape before provider start", () => {
  assert.match(code, /plan_kind = 'tip_thread' and expected_steps between 1 and 3/u);
  assert.match(code, /plan_kind = 'morning_greeting_media_post' and expected_steps = 2/u);
  const plan = definition("plan_provider_steps_v2");
  assert.match(plan, /v_attempt\.phase <> 'pre_x'/u);
  assert.match(plan, /PROVIDER_STEP_PLAN_CONFLICT/u);
  assert.match(plan, /GREETING_PUBLISH_CLAIM_NOT_HELD/u);
});

test("steps start only through the plan and consume only confirmed media", () => {
  const begin = definition("begin_planned_provider_step_v2");
  for (const token of ["PROVIDER_STEP_PLAN_REQUIRED", "PROVIDER_STEP_BEYOND_PLAN", "PROVIDER_STEP_KIND_NOT_IN_PLAN", "PROVIDER_STEP_INPUT_MISMATCH"]) {
    assert.ok(begin.includes(token), token);
  }
  assert.match(begin, /p_input_provider_object_id is distinct from v_media\.provider_object_id/u);
  assert.match(begin, /GREETING_SCHEDULE_DATE_STALE/u);
  assert.match(begin, /perform public\.begin_provider_step_v2\(/u);
  assert.match(code, /revoke execute on function public\.begin_provider_step_v2\(uuid, uuid, smallint, text, text\) from service_role;/u);
});

test("tip completion requires every planned part confirmed and chained; legacy side effects exactly once", () => {
  const root = definition("x_v2_confirmed_thread_root");
  assert.match(root, /v_count <> v_plan\.expected_steps/u);
  assert.match(root, /parent_provider_object_id is distinct from v_prev_object/u);
  const tip = definition("complete_tip_post_v2");
  assert.match(tip, /update public\.tips set last_used_at = now\(\), use_count = use_count \+ 1 where id = p_tip_id;/u);
  assert.match(tip, /values \(v_post_id, 'tip', 'succeeded', p_tip_id, v_root, 'X post created'\)/u);
  assert.match(tip, /if v_result = 'completed' then/u);
});

test("greeting completion binds media, create and the day claim of this attempt", () => {
  const greeting = definition("complete_morning_greeting_post_v2");
  assert.match(greeting, /v_create\.input_provider_object_id is distinct from v_media\.provider_object_id/u);
  assert.match(greeting, /set status = 'published', x_post_id = v_create\.provider_object_id, published_at = now\(\)/u);
  assert.match(greeting, /c\.execution_id = p_attempt_id::text/u);
  assert.match(greeting, /'morning_greeting', 'succeeded', v_create\.provider_object_id, 'X post created'/u);
  const claim = definition("acquire_greeting_publish_claim_v2");
  assert.match(claim, /on conflict \(brand_id, post_type, date_jst\) do nothing/u);
  assert.match(claim, /GREETING_ALREADY_PUBLISHED/u);
  assert.match(claim, /GREETING_PUBLISH_CLAIM_HELD/u);
  assert.match(claim, /GREETING_SCHEDULE_DATE_STALE/u);
});

test("attempt guards: no rejected thread after a confirmed create; failed ends fail the day claim", () => {
  assert.match(definition("x_v2_multistep_attempt_guard"), /X_REJECTED_AFTER_CONFIRMED_CREATE/u);
  const onFinish = definition("x_v2_greeting_claim_on_finish");
  assert.match(onFinish, /new\.outcome not in \('completed', 'x_confirmed_db_incomplete'\)/u);
  assert.match(onFinish, /set status = 'failed'/u);
});

test("ACL and security", () => {
  const defs = code.match(/create function public\.[\s\S]*?\n\$\$;/gu) ?? [];
  assert.equal(defs.length, 8);
  for (const def of defs) assert.match(def, /security definer set search_path = ''/u);
  assert.match(code, /revoke all on public\.post_provider_step_plans_v2 from public, anon, authenticated, service_role;/u);
  assert.match(code, /from public, anon, authenticated, service_role;\s+grant execute on function/u);
  assert.doesNotMatch(code.slice(code.lastIndexOf("grant execute on function")), /x_v2_/u);
});

test("live dispatcher and legacy greeting publisher are not wired to Phase1G", () => {
  assert.doesNotMatch(dispatcher, /_post_v2|provider_step|x_v2_multistep|publish_claim_v2/u);
  assert.doesNotMatch(greetingPublisher, /_v2|x_v2_multistep/u);
});
