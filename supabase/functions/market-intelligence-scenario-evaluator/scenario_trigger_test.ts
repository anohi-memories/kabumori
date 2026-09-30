// Phase 3C: what repeated Cron invocations do. A small stateful in-memory
// model of the DB pieces the evaluator uses (runs with the one-running unique
// index, the current row with its CAS, market_state_current, the fingerprint
// uniqueness, and the RPC's fail-closed State re-verification). No network, no
// real OpenAI. The point: the number of AI calls follows State changes, never
// the number of Cron invocations.
import assert from "node:assert/strict";
import test from "node:test";
import { evaluateScenario } from "./index.ts";
import { responsePayload, validOutput } from "./mic_scenario_test_fixtures.ts";

const ctx = { supabaseUrl: "https://example.supabase.co", secretKey: "sk_test" };
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const T = (iso: string) => new Date(`${iso}Z`);

type State = Record<string, unknown> & { domain: string };
type Run = { id: string; status: "running" | "no_change" | "evaluated" | "failed"; started_at: string; window: string; fingerprint?: string };

function stateRow(domain: string, run: number, at: string, overrides: Record<string, unknown> = {}): State {
  return {
    domain, narrative: `${domain} narrative ${run}`, bullish_factors: ["b"], bearish_factors: ["r"], key_risks: ["k"],
    ai_confidence: 0.8, data_confidence: 0.9, coverage_status: "full", observation_status: "fresh",
    ai_evaluated_at: `${at}.000Z`, source_evaluation_run_id: uuid(run), ...overrides,
  };
}

type Sim = ReturnType<typeof createSim>;

function createSim(initialStates: State[], opts: { openAi?: () => Promise<Response> } = {}) {
  const states = new Map(initialStates.map((s) => [s.domain, s]));
  const runs: Run[] = [];
  const current = { updated_at: "2026-09-27T00:00:00Z", source_state_run_ids: [] as string[], input_fingerprint: null as string | null, source_scenario_run_id: null as string | null };
  let serverNow = "2026-09-30T01:25:00.000Z";
  let nextRun = 900;
  let usageId = 1;
  const stats = { openAiCalls: 0, models: [] as string[], usageRows: 0, rpcCalls: 0, stateWrites: 0, otherEndpoints: [] as string[] };
  const hooks: { beforeRpc?: () => void } = {};
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

  const impl = (async (input: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
    if (input === "https://api.openai.com/v1/responses") {
      stats.openAiCalls += 1;
      stats.models.push(body.model);
      if (opts.openAi) return await opts.openAi();
      return json(responsePayload(validOutput()));
    }
    const path = input.replace(`${ctx.supabaseUrl}/rest/v1/`, "");
    const url = new URL(input);
    if (path.startsWith("market_state_current")) {
      if (method !== "GET") stats.stateWrites += 1;
      return json([...states.values()]);
    }
    if (path.startsWith("mic_state_") || path.startsWith("mic_ingestion_runs")) stats.stateWrites += 1;
    if (path.startsWith("mic_scenario_current")) return json([current]);
    if (path.startsWith("ai_usage_events") && method === "POST") {
      stats.usageRows += 1;
      return json([{ id: usageId++ }], 201);
    }
    if (path.startsWith("mic_scenario_evaluation_runs")) {
      if (method === "GET" && url.searchParams.get("select") === "attempt_no") {
        const window = url.searchParams.get("run_window")!.replace("eq.", "");
        return json(runs.filter((r) => r.window === window).map((_, i) => ({ attempt_no: i + 1 })).slice(-1));
      }
      if (method === "GET") {
        const id = url.searchParams.get("id")!.replace("eq.", "");
        return json(runs.filter((r) => r.id === id).map((r) => ({ status: r.status })));
      }
      if (method === "POST") {
        // one-running unique index
        if (runs.some((r) => r.status === "running")) return json({ code: "23505" }, 409);
        const run: Run = { id: uuid(nextRun++), status: "running", started_at: serverNow, window: body.run_window };
        runs.push(run);
        return json([{ id: run.id }], 201);
      }
      if (method === "PATCH") {
        if (url.searchParams.get("started_at")) {
          const cutoff = decodeURIComponent(url.searchParams.get("started_at")!.replace("lt.", ""));
          for (const r of runs) if (r.status === "running" && r.started_at < cutoff) r.status = "failed";
          return new Response(null, { status: 204 });
        }
        const id = url.searchParams.get("id")!.replace("eq.", "");
        const run = runs.find((r) => r.id === id && r.status === "running");
        if (body.status === "no_change") {
          if (!run) return json([]);
          run.status = "no_change";
          return json([{ id }]);
        }
        if (run) run.status = "failed";
        return new Response(null, { status: 204 });
      }
    }
    if (path === "rpc/apply_mic_scenario_update") {
      stats.rpcCalls += 1;
      hooks.beforeRpc?.();
      const run = runs.find((r) => r.id === body.p_run_id)!;
      if (run.status === "evaluated") return json([{ result_status: "already_applied" }]);
      if (body.p_expected_current_updated_at !== current.updated_at) return json({ message: "MIC_SCENARIO_STALE_DECISION" }, 400);
      const changed = (body.p_state_snapshots as State[]).some((snap) => {
        const live = states.get(snap.domain);
        return !live || Object.keys(snap).some((key) => JSON.stringify(live[key]) !== JSON.stringify(snap[key]));
      });
      if (changed) return json({ message: "MIC_SCENARIO_STATE_CHANGED_DURING_EVALUATION" }, 400);
      if (runs.some((r) => r.status === "evaluated" && r.fingerprint === body.p_input_fingerprint)) {
        return json({ code: "23505", message: "mic_scenario_runs_fingerprint_uidx" }, 409);
      }
      run.status = "evaluated";
      run.fingerprint = body.p_input_fingerprint;
      current.updated_at = serverNow;
      current.source_state_run_ids = (body.p_state_snapshots as State[]).map((s) => s.source_evaluation_run_id as string);
      current.input_fingerprint = body.p_input_fingerprint;
      current.source_scenario_run_id = run.id;
      return json([{ result_status: "applied" }]);
    }
    stats.otherEndpoints.push(`${method} ${path}`);
    throw new Error(`unexpected ${method} ${input}`);
  }) as unknown as typeof fetch;

  return {
    states, runs, current, stats, hooks,
    setClock: (iso: string) => { serverNow = `${iso}.000Z`; },
    // One Cron invocation at the given (server) time.
    invoke: (iso: string) => {
      serverNow = `${iso}.000Z`;
      return evaluateScenario(ctx, "sk-openai", T(iso), impl);
    },
    counts: () => ({
      evaluated: runs.filter((r) => r.status === "evaluated").length,
      no_change: runs.filter((r) => r.status === "no_change").length,
      failed: runs.filter((r) => r.status === "failed").length,
      running: runs.filter((r) => r.status === "running").length,
    }),
  };
}

const batch = (run: number, at: string): State[] => [stateRow("rates", run, at), stateRow("macro", run + 1, at), stateRow("equity_index", run + 2, at)];

test("[A][B] a full Wednesday of slots: AI runs once per State batch, not once per Cron invocation", async () => {
  // States last evaluated 2026-09-29 21:15 (the real 21:15 batch).
  const sim = createSim(batch(10, "2026-09-29T21:15:00"));
  const results = [];
  results.push(await sim.invoke("2026-09-30T01:25:00")); // first Scenario for this State set
  results.push(await sim.invoke("2026-09-30T06:25:00")); // no new State run
  results.push(await sim.invoke("2026-09-30T09:25:00")); // no new State run
  assert.deepEqual(results.map((r) => r.status), ["evaluated", "no_change", "no_change"]);
  assert.equal(results[0].reason, "initial_scenario");
  assert.equal(results[1].reason, "no_new_state_evaluation");
  assert.equal(sim.stats.openAiCalls, 1);

  // 21:15: rates + equity_index get new evaluation runs; macro unchanged.
  sim.states.set("rates", stateRow("rates", 20, "2026-09-30T21:15:00"));
  sim.states.set("equity_index", stateRow("equity_index", 22, "2026-09-30T21:15:00"));
  const evening = await sim.invoke("2026-09-30T21:25:00");
  assert.equal(evening.status, "evaluated");
  assert.equal(evening.reason, "new_state_evaluation:equity_index,rates");
  // 22:15: macro (e-Stat) gets a new run.
  sim.states.set("macro", stateRow("macro", 21, "2026-09-30T22:15:00"));
  const late = await sim.invoke("2026-09-30T22:25:00");
  assert.equal(late.status, "evaluated");
  assert.equal(late.reason, "new_state_evaluation:macro");

  assert.equal(sim.stats.openAiCalls, 3, "5 invocations, 3 State batches -> 3 AI calls");
  assert.equal(sim.stats.usageRows, 3);
  assert.deepEqual(sim.counts(), { evaluated: 3, no_change: 2, failed: 0, running: 0 });
  assert.deepEqual(sim.stats.models, ["gpt-5.6-luna", "gpt-5.6-luna", "gpt-5.6-luna"], "no Sol without an escalation reason");
});

test("[B] the same State set invoked 200 more times: zero further AI, zero usage, one run row each", async () => {
  const sim = createSim(batch(10, "2026-09-29T21:15:00"));
  await sim.invoke("2026-09-30T01:25:00");
  for (let i = 0; i < 200; i++) {
    const result = await sim.invoke(`2026-09-30T${String(2 + Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:30`);
    assert.equal(result.status, "no_change");
  }
  assert.equal(sim.stats.openAiCalls, 1);
  assert.equal(sim.stats.usageRows, 1);
  assert.equal(sim.stats.rpcCalls, 1);
  assert.equal(sim.counts().no_change, 200);
});

test("[C] quality-only State updates (same run ids) never trigger AI", async () => {
  const sim = createSim(batch(10, "2026-09-29T21:15:00"));
  await sim.invoke("2026-09-30T01:25:00");
  // no_change refreshes by the State evaluator: fetch/observation/quality move, run ids stay.
  sim.states.set("rates", stateRow("rates", 10, "2026-09-29T21:15:00", { data_confidence: 0.6, observation_status: "stale" }));
  sim.states.set("macro", stateRow("macro", 11, "2026-09-29T21:15:00", { coverage_status: "partial" }));
  const result = await sim.invoke("2026-09-30T06:25:00");
  assert.equal(result.status, "no_change");
  assert.equal(sim.stats.openAiCalls, 1);
});

test("[D] fewer than two usable States: no AI, even with brand-new State runs", async () => {
  const states = [
    stateRow("rates", 10, "2026-09-29T21:15:00", { data_confidence: 0.2 }),
    stateRow("macro", 11, "2026-09-29T21:15:00", { coverage_status: "unavailable" }),
    stateRow("equity_index", 12, "2026-09-29T21:15:00"),
  ];
  const sim = createSim(states);
  const result = await sim.invoke("2026-09-30T01:25:00");
  assert.deepEqual([result.status, result.reason], ["no_change", "insufficient_usable_states"]);
  assert.equal(sim.stats.openAiCalls, 0);
  assert.equal(sim.stats.usageRows, 0);
  assert.equal(sim.stats.rpcCalls, 0);
});

test("[E] two invocations at once (overlapping Cron): one claims, the other skips; a single AI call, a single commit", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const sim = createSim(batch(10, "2026-09-29T21:15:00"), {
    openAi: async () => { await gate; return new Response(JSON.stringify(responsePayload(validOutput())), { status: 200 }); },
  });
  const first = sim.invoke("2026-09-30T01:25:00");
  await new Promise((r) => setTimeout(r, 10)); // first holds the running claim, waiting on OpenAI
  const second = await sim.invoke("2026-09-30T01:25:30");
  assert.equal(second.status, "skipped_duplicate");
  release();
  assert.equal((await first).status, "evaluated");
  assert.equal(sim.stats.openAiCalls, 1);
  assert.equal(sim.stats.rpcCalls, 1);
  assert.deepEqual(sim.counts(), { evaluated: 1, no_change: 0, failed: 0, running: 0 });
});

test("[F] a fresh running run blocks the invocation safely; a stale (>15 min) one is reconciled and the work proceeds", async () => {
  const fresh = createSim(batch(10, "2026-09-29T21:15:00"));
  fresh.runs.push({ id: uuid(1), status: "running", started_at: "2026-09-30T01:20:00.000Z", window: "market:x" });
  const blocked = await fresh.invoke("2026-09-30T01:25:00");
  assert.equal(blocked.status, "skipped_duplicate");
  assert.equal(fresh.stats.openAiCalls, 0);

  const stale = createSim(batch(10, "2026-09-29T21:15:00"));
  stale.runs.push({ id: uuid(1), status: "running", started_at: "2026-09-30T01:00:00.000Z", window: "market:x" });
  const recovered = await stale.invoke("2026-09-30T01:25:00");
  assert.equal(recovered.status, "evaluated");
  assert.equal(stale.runs[0].status, "failed", "the crashed run is closed as failed");
  assert.equal(stale.stats.openAiCalls, 1);
});

test("[G][I] a State changes during evaluation: the write fails closed, nothing is committed, and the next Cron slot recovers", async () => {
  const sim = createSim(batch(10, "2026-09-29T21:15:00"));
  // A State evaluator commits a new rates run between the AI call and the RPC.
  sim.hooks.beforeRpc = () => {
    sim.states.set("rates", stateRow("rates", 30, "2026-09-30T01:20:00"));
    sim.hooks.beforeRpc = undefined;
  };
  const failed = await sim.invoke("2026-09-30T01:25:00");
  assert.equal(failed.status, "failed");
  assert.match(failed.error ?? "", /STATE_CHANGED_DURING_EVALUATION/);
  assert.equal(sim.current.source_scenario_run_id, null, "Scenario current untouched");
  assert.equal(sim.stats.usageRows, 1, "the real AI call is still accounted for");

  // Next slot: rebuilt from the new State set.
  const next = await sim.invoke("2026-09-30T06:25:00");
  assert.equal(next.status, "evaluated");
  assert.equal(sim.current.source_state_run_ids.includes(uuid(30)), true);
  assert.equal(sim.stats.openAiCalls, 2, "a retry costs one more call; bounded by the slots per day");
});

test("[H][I] Scenario failure leaves State alone and the next slot retries", async () => {
  let calls = 0;
  const sim = createSim(batch(10, "2026-09-29T21:15:00"), {
    openAi: () => {
      calls += 1;
      return Promise.resolve(calls === 1 ? new Response("upstream", { status: 500 }) : new Response(JSON.stringify(responsePayload(validOutput())), { status: 200 }));
    },
  });
  const before = JSON.stringify([...sim.states.values()]);
  const failed = await sim.invoke("2026-09-30T01:25:00");
  assert.equal(failed.status, "failed");
  assert.equal(JSON.stringify([...sim.states.values()]), before, "State rows unchanged");
  assert.equal(sim.stats.stateWrites, 0, "no write to State / ingestion tables");
  assert.equal(sim.current.source_scenario_run_id, null);
  assert.equal(sim.counts().running, 0, "the failed run is terminal, not left running");

  const recovered = await sim.invoke("2026-09-30T06:25:00");
  assert.equal(recovered.status, "evaluated");
  assert.equal(sim.counts().failed, 1);
  assert.equal(sim.stats.otherEndpoints.length, 0);
});

test("AI calls per invocation are bounded (Luna + at most one Sol) and only State batches cause them", async () => {
  const sim = createSim(batch(10, "2026-09-29T21:15:00"));
  let before = 0;
  for (let slot = 0; slot < 5; slot++) {
    sim.states.set("rates", stateRow("rates", 100 + slot, `2026-09-30T0${slot}:15:00`));
    await sim.invoke(`2026-09-30T0${slot}:25:00`);
    assert.ok(sim.stats.openAiCalls - before <= 2);
    before = sim.stats.openAiCalls;
  }
  assert.equal(sim.stats.openAiCalls, 5, "five slots each with a new State run -> five Luna calls at most");
});
