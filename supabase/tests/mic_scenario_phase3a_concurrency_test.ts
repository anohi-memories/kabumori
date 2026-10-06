// DISPOSABLE DB ONLY. Run after mic_scenario_phase3a_review.sql. No HTTP/AI.
// MIC_SCENARIO_REVIEW_SOCKET=/private/tmp/mic-scenario-pg-review.XXXXXX
// deno test --no-config --allow-run=psql --allow-env=MIC_SCENARIO_REVIEW_SOCKET this_file
import assert from "node:assert/strict";

const socket = Deno.env.get("MIC_SCENARIO_REVIEW_SOCKET");
const localOnly = typeof socket === "string" && /^\/private\/tmp\/mic-scenario-pg-review\.[A-Za-z0-9]+$/.test(socket);

async function sql(statement: string, mustSucceed = true) {
  if (!localOnly) throw new Error("EXPLICIT_DISPOSABLE_SOCKET_REQUIRED");
  const output = await new Deno.Command("psql", {
    args: ["-X", "-qAt", "-h", socket!, "-p", "55483", "-U", "postgres", "-d", "mic_scenario_review",
      "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-c", statement],
    stdin: "null", stdout: "piped", stderr: "piped",
  }).output();
  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);
  if (mustSucceed) assert.equal(output.code, 0, stderr);
  return { code: output.code, stdout, stderr };
}

Deno.test({ name: "DB: simultaneous claims have one winner and one 23505; no second running row", ignore: !localOnly, fn: async () => {
  const statement = "begin; set local role service_role; insert into mic_scenario_evaluation_runs(scenario_key,run_window) values('market','race'); select pg_sleep(0.3); commit;";
  const results = await Promise.all([sql(statement, false), sql(statement, false)]);
  assert.equal(results.filter((result) => result.code === 0).length, 1);
  assert.match(results.find((result) => result.code !== 0)!.stderr, /23505.*mic_scenario_runs_one_running_uidx/s);
  assert.equal((await sql("select count(*) from mic_scenario_evaluation_runs where status='running'")).stdout.trim(), "1");
  await sql("set role service_role; update mic_scenario_evaluation_runs set status='failed',completed_at=now() where status='running';");
} });

async function prepareSuccessor() {
  await sql(`
    insert into mic_state_evaluation_runs(id,domain,run_window,status)
    values('44444444-4444-4444-8444-444444444444','rates','successor','evaluated');
    update market_state_current set source_evaluation_run_id='44444444-4444-4444-8444-444444444444' where domain='rates';
    update review_inputs set data=data||jsonb_build_object(
      'updated_at',(select updated_at from mic_scenario_current),
      'snapshots',(select jsonb_agg(to_jsonb(c)-'updated_at' order by domain) from market_state_current c),
      'fingerprint','mic-scenario-v1|'||(select string_agg(domain||':'||source_evaluation_run_id,'|' order by domain) from market_state_current));
    set role service_role; select review_prepare();
  `);
}

Deno.test({ name: "DB: simultaneous RPC retries commit once, successor history keeps old retry identity", ignore: !localOnly, fn: async () => {
  const oldRun = (await sql("select source_scenario_run_id from mic_scenario_current")).stdout.trim();
  const oldUsage = (await sql("select ai_usage_event_id from mic_scenario_evaluation_runs where status='evaluated'")).stdout.trim();
  await prepareSuccessor();
  const results = await Promise.all([sql("set role service_role; select review_apply();"), sql("set role service_role; select review_apply();")]);
  assert.deepEqual(results.map((result) => result.stdout.trim()).sort(), ["already_applied", "applied"]);
  assert.equal((await sql("select count(*) from mic_scenario_history")).stdout.trim(), "1");
  assert.equal((await sql("select count(*) from mic_scenario_evidence")).stdout.trim(), "4");
  assert.equal((await sql(`set role service_role; select review_apply('{"run_id":"${oldRun}","usage_id":${oldUsage}}');`)).stdout.trim(), "already_applied");
  // The historical row is now present, so its row-level append-only trigger
  // can be exercised (not just its permission/TRUNCATE guards).
  await sql("select review_expect_error('update mic_scenario_history set snapshot=''{}''','APPEND_ONLY'); select review_expect_error('delete from mic_scenario_history','APPEND_ONLY');");
} });

Deno.test({ name: "DB: live State update held before RPC forces wait then fail closed", ignore: !localOnly, fn: async () => {
  const lock = sql("begin; update market_state_current set observation_status='delayed_expected' where domain='rates'; select pg_sleep(2); commit;");
  // Wait until the writer really holds its row lock, not just a timing guess.
  for (let i = 0; i < 100; i++) {
    const held = await sql("select count(*) from pg_stat_activity where wait_event='PgSleep' and query like '%observation_status%' and pid<>pg_backend_pid();");
    if (held.stdout.trim() === "1") break;
    if (i === 99) throw new Error("LOCK_BARRIER_NOT_REACHED");
  }
  await sql("update review_inputs set data=data||jsonb_build_object('updated_at',(select updated_at from mic_scenario_current)); set role service_role; select review_prepare();");
  const result = await sql("set role service_role; select review_apply();", false);
  await lock;
  assert.match(result.stderr, /STATE_CHANGED_DURING_EVALUATION/);
  assert.equal((await sql("select count(*) from mic_scenario_history")).stdout.trim(), "1");
  await sql("set role service_role; update mic_scenario_evaluation_runs set status='failed',completed_at=now() where status='running';");
  assert.equal((await sql("select deadlocks from pg_stat_database where datname=current_database()")).stdout.trim(), "0");
} });

Deno.test({ name: "DB: stale reconciliation racing an in-flight commit cannot terminalize evaluated run", ignore: !localOnly, fn: async () => {
  await sql(`
    insert into mic_state_evaluation_runs(id,domain,run_window,status)
    values('55555555-5555-4555-8555-555555555555','rates','stale-race','evaluated');
    update market_state_current set source_evaluation_run_id='55555555-5555-4555-8555-555555555555' where domain='rates';
    -- Age only this disposable fixture, never an application row.
    alter table mic_scenario_current disable trigger trg_mic_scenario_current_updated_at;
    update mic_scenario_current set updated_at=now()-interval '30 minutes';
    alter table mic_scenario_current enable trigger trg_mic_scenario_current_updated_at;
    update review_inputs set data=data||jsonb_build_object(
      'updated_at',(select updated_at from mic_scenario_current),
      'snapshots',(select jsonb_agg(to_jsonb(c)-'updated_at' order by domain) from market_state_current c),
      'fingerprint','mic-scenario-v1|'||(select string_agg(domain||':'||source_evaluation_run_id,'|' order by domain) from market_state_current));
    set role service_role; select review_prepare();
    update mic_scenario_evaluation_runs set started_at=now()-interval '20 minutes' where status='running';
  `);
  await sql("create function review_pause() returns trigger language plpgsql as $$begin perform pg_sleep(2); return new; end$$; create trigger review_pause before update on mic_scenario_current for each row execute function review_pause();");
  const commit = sql("set role service_role; select review_apply();");
  for (let i = 0; i < 100; i++) {
    if ((await sql("select count(*) from pg_stat_activity where wait_event='PgSleep' and query like '%review_apply%' and pid<>pg_backend_pid();")).stdout.trim() === "1") break;
    if (i === 99) throw new Error("RPC_LOCK_BARRIER_NOT_REACHED");
  }
  const reconcile = sql("set role service_role; update mic_scenario_evaluation_runs set status='failed',completed_at=now() where status='running' and started_at<now()-interval '15 minutes' returning id;");
  assert.equal((await commit).stdout.trim(), "applied");
  assert.equal((await reconcile).stdout.trim(), "");
  await sql("drop trigger review_pause on mic_scenario_current; drop function review_pause();");
  assert.equal((await sql("select count(*) from mic_scenario_evaluation_runs where status='running'")).stdout.trim(), "0");
  assert.equal((await sql("select count(*) from mic_scenario_history")).stdout.trim(), "2");
} });
