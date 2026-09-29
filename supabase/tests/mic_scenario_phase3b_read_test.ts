// DISPOSABLE DB ONLY; after Phase3A fixture, migration x2 and SQL suite.
// MIC_SCENARIO_REVIEW_SOCKET=/private/tmp/mic-scenario-pg-review.XXXXXX
// deno test --no-config --allow-run=psql --allow-env=MIC_SCENARIO_REVIEW_SOCKET this_file
// Each adapter GET uses a new real READ COMMITTED DB transaction. Mutations
// are test-only fixture work, never issued by the read adapter.
import assert from "node:assert/strict";
import { readScenarioForConsumer } from "../functions/_shared/mic_scenario/read_adapter.ts";

const socket = Deno.env.get("MIC_SCENARIO_REVIEW_SOCKET");
const localOnly = typeof socket === "string" && /^\/private\/tmp\/mic-scenario-pg-review\.[A-Za-z0-9]+$/.test(socket);
const ctx = { supabaseUrl: "https://dummy.supabase.co", secretKey: "dummy" };
async function sql(query: string): Promise<string> {
  if (!localOnly) throw new Error("EXPLICIT_DISPOSABLE_SOCKET_REQUIRED");
  const out = await new Deno.Command("psql", { args: ["-X", "-qAt", "-h", socket!, "-p", "55483", "-U", "postgres",
    "-d", "mic_scenario_review", "-v", "ON_ERROR_STOP=1", "-c", query], stdout: "piped", stderr: "piped" }).output();
  assert.equal(out.code, 0, new TextDecoder().decode(out.stderr));
  return new TextDecoder().decode(out.stdout).trim();
}
async function prepare() {
  // The Phase3A SQL suite uses empty test-only Scenario JSON to isolate its
  // DB contract. Supply bounded content here to exercise the read contract.
  await sql(`update mic_scenario_current set
    base_case='{"title":"base","description":"conditional","supporting_state_domains":["rates"],"confirmation_conditions":[],"invalidation_conditions":[],"watch_items":[]}',
    upside_case='{"title":"up","description":"conditional","triggers":["condition"],"implications":[],"invalidation_conditions":[],"watch_items":[]}',
    downside_case='{"title":"down","description":"conditional","triggers":["condition"],"implications":[],"invalidation_conditions":[],"watch_items":[]}';
    update market_state_current c set
      narrative=e.state_snapshot->>'narrative', data_confidence=(e.state_snapshot->>'data_confidence')::numeric,
      bullish_factors=e.state_snapshot->'bullish_factors', bearish_factors=e.state_snapshot->'bearish_factors',
      key_risks=e.state_snapshot->'key_risks', ai_confidence=(e.state_snapshot->>'ai_confidence')::numeric,
      ai_evaluated_at=(e.state_snapshot->>'ai_evaluated_at')::timestamptz,
      source_evaluation_run_id=(e.state_snapshot->>'source_evaluation_run_id')::uuid,
      coverage_status=e.state_snapshot->>'coverage_status', observation_status=e.state_snapshot->>'observation_status',
      updated_at=clock_timestamp()
    from mic_scenario_evidence e where e.scenario_run_id=(select source_scenario_run_id from mic_scenario_current)
      and e.domain=c.domain;`);
}
function dbFetch(afterGet?: (table: string, count: number) => Promise<void>) {
  let count = 0;
  return (async (url: string, init?: RequestInit) => {
    assert.equal(init?.method, "GET");
    const path = new URL(url);
    const table = path.pathname.split("/").pop()!;
    assert.ok(["mic_scenario_current", "market_state_current", "mic_scenario_evaluation_runs", "mic_scenario_evidence"].includes(table));
    let filter = table === "mic_scenario_current" ? "scenario_key='market'" :
      table === "market_state_current" ? "domain in ('rates','macro','equity_index')" : "";
    if (!filter) {
      const key = table === "mic_scenario_evaluation_runs" ? "id" : "scenario_run_id";
      const id = path.searchParams.get(key)?.replace(/^eq\./, "");
      assert.match(id!, /^[0-9a-f-]{36}$/);
      filter = `${key}='${id}'`;
    }
    const select = path.searchParams.get("select")!;
    assert.match(select, /^[a-z_,]+$/);
    const rows = await sql(`begin read only; set local role service_role;
      select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb) from (select ${select} from ${table} where ${filter}) t; commit;`);
    await afterGet?.(table, ++count);
    return new Response(rows);
  }) as typeof fetch;
}

Deno.test({ name: "DB read: stable inputs and SQL decimal cap match; read adapter changes no rows", ignore: !localOnly, fn: async () => {
  await prepare();
  const before = await sql("select md5(jsonb_agg(to_jsonb(t))::text) from mic_scenario_current t;");
  const out = await readScenarioForConsumer(ctx, undefined, dbFetch());
  assert.equal(out.status, "degraded", JSON.stringify(out));
  assert.equal(out.effective_confidence, 0.7);
  assert.equal(await sql("select md5(jsonb_agg(to_jsonb(t))::text) from mic_scenario_current t;"), before);
  await sql("update market_state_current set data_confidence=0.6,updated_at=clock_timestamp() where domain='rates';");
  const degraded = await readScenarioForConsumer(ctx, undefined, dbFetch());
  const sqlCap = Number(await sql("select floor((min(data_confidence)-0.1)*1000)/1000 from market_state_current;"));
  assert.equal(degraded.effective_confidence, sqlCap);
  const evaluated = Date.parse(await sql("select min(ai_evaluated_at) from market_state_current;"));
  const recent = await readScenarioForConsumer(ctx, new Date(evaluated + 37 * 3600000), dbFetch());
  const recentCap = Number(await sql("select floor((min(data_confidence*0.8)-0.1)*1000)/1000 from market_state_current;"));
  assert.equal(recent.effective_confidence, recentCap);
  assert.equal(recentCap, 0.38);
} });

Deno.test({ name: "DB read: committed current changes between each GET fail closed; stable retry recovers", ignore: !localOnly, fn: async () => {
  for (const barrier of [1, 2, 3, 4, 5]) {
    await prepare();
    const out = await readScenarioForConsumer(ctx, undefined, dbFetch(async (_, count) => {
      if (count === barrier) await sql("begin; update mic_scenario_current set updated_at=clock_timestamp(); commit;");
    }));
    assert.equal(out.status, "invalid", `barrier ${barrier}`);
    assert.deepEqual(out.reason_codes, ["read_race_detected"]);
    assert.equal(out.scenario, null);
    const retry = await readScenarioForConsumer(ctx, undefined, dbFetch());
    assert.equal(retry.status, "degraded", JSON.stringify(retry));
  }
} });

Deno.test({ name: "DB read: no_change/material State writes between evidence and validation never leak body", ignore: !localOnly, fn: async () => {
  for (const mutation of ["data_confidence=0.5", "observation_status='stale'", "narrative='changed interpretation'"]) {
    await prepare();
    const out = await readScenarioForConsumer(ctx, undefined, dbFetch(async (table) => {
      if (table === "mic_scenario_evidence") await sql(`begin; update market_state_current set ${mutation},updated_at=clock_timestamp() where domain='rates'; commit;`);
    }));
    assert.equal(out.status, "invalid");
    assert.equal(out.scenario, null);
  }
  await prepare();
  const retry = await readScenarioForConsumer(ctx, undefined, dbFetch());
  assert.equal(retry.status, "degraded", JSON.stringify(retry));
} });

Deno.test({ name: "DB read: commit after final State observation demonstrates the point-in-time boundary", ignore: !localOnly, fn: async () => {
  await prepare();
  const out = await readScenarioForConsumer(ctx, undefined, dbFetch(async (_, count) => {
    if (count === 5) await sql("begin; update market_state_current set data_confidence=0.2,updated_at=clock_timestamp() where domain='rates'; commit;");
  }));
  assert.equal(out.status, "degraded", JSON.stringify(out));
  assert.notEqual(out.scenario, null, "valid at observation, NOT a latest-at-return guarantee");
  const next = await readScenarioForConsumer(ctx, undefined, dbFetch());
  assert.equal(next.status, "invalid");
  assert.equal(next.scenario, null);
  await prepare();
} });
