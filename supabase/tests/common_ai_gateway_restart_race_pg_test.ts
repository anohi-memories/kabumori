// G6-07 (2026-10-20): restart and concurrent recovery across SEPARATE OS PROCESSES, on the REAL ledger, ai_calls and
// maintenance migrations in a disposable socket-only PostgreSQL. Each gateway call (process A) and each recovery run
// (process B) is its own `deno run` of common_ai_gateway_restart_race_worker.ts; a crash is a SIGKILL of that process
// while it waits at one step. Everything is observed in the database: ai_calls rows, ledger reservations and usage
// events, and every request a (fake) provider received (written down before it is answered, so it survives the kill).
// Run by common_ai_gateway_restart_race_pg_run.sh.
import assert from "node:assert/strict";

const HOST = Deno.env.get("GRR_PGHOST");
const PORT = Deno.env.get("GRR_PGPORT");
const SUPER = Deno.env.get("GRR_PGSUPER");
const DB = Deno.env.get("GRR_DB");
const CONFIG = Deno.env.get("GRR_DENO_CONFIG");
const enabled = !!HOST && !!PORT && !!SUPER && !!DB && !!CONFIG && /^\/(private\/)?tmp\//.test(HOST);
const opts = { ignore: !enabled, sanitizeOps: false, sanitizeResources: false };
const WORKER = new URL("./common_ai_gateway_restart_race_worker.ts", import.meta.url).pathname;

const USER_A = "00000000-0000-4000-8000-0000000000a1";
const USER_B = "00000000-0000-4000-8000-0000000000b2";
// Fake JWT-shaped session tokens of the fake G5 (not real tokens).
const JWT_A1 = "g6r-user-a.session-1.sig";
const JWT_A2 = "g6r-user-a.session-2.sig";
const JWT_B1 = "g6r-user-b.session-1.sig";

async function psql(statement: string): Promise<{ ok: boolean; out: string; err: string }> {
  const output = await new Deno.Command("psql", {
    args: ["-X", "-h", HOST!, "-p", PORT!, "-U", SUPER!, "-d", DB!, "-Atq", "-v", "ON_ERROR_STOP=1", "-c", statement],
    env: { LC_ALL: "C" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes).trim();
  return { ok: output.success, out: decode(output.stdout), err: decode(output.stderr) };
}
async function rows(sql: string): Promise<string> {
  const r = await psql(sql);
  assert.ok(r.ok, r.err);
  return r.out;
}

type Result = { ok: boolean; code?: string; data?: unknown; audit?: { callKey: string; attempts: number; costBasis: string } | null };
type Candidate = { callKey: string; classification: string | null; outcome: string; detail?: string };
type Recovery = { candidates: Candidate[]; recovered: { released: number; marked_unknown: number } | null };
type Gw = {
  revision?: string;
  credential?: string;
  app?: "postona" | "kabumori";
  feature?: string;
  brand?: string | null;
  pauseAt?: string | null;
};
let seq = 0;
/** One separate process. `done` resolves with its RESULT line, or with the signal that killed it. */
function spawn(job: Record<string, unknown>) {
  const name = `w${++seq}`;
  const child = new Deno.Command("deno", {
    args: ["run", "--cached-only", "--frozen", "--config", CONFIG!, "--deny-net", "--deny-write", "--allow-run=psql",
      "--allow-env=GRR_PGHOST,GRR_PGPORT,GRR_PGSUPER,GRR_DB,ANTHROPIC_WEBHOOK_SIGNING_KEY,ANTHROPIC_CUSTOM_HEADERS", WORKER, JSON.stringify({ ...job, name })],
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const done = child.output().then((o) => {
    const out = new TextDecoder().decode(o.stdout);
    const line = out.split("\n").find((l) => l.startsWith("RESULT "));
    return { signal: o.signal, code: o.code, result: line ? JSON.parse(line.slice(7)) : null, err: new TextDecoder().decode(o.stderr) };
  });
  return { name, child, done };
}
function gateway(operationId: string, g: Gw = {}) {
  const app = g.app ?? "postona";
  return spawn({
    role: "gateway", revision: g.revision ?? "r1", credential: g.credential ?? JWT_A1, app, feature: g.feature ?? (app === "postona" ? "consult" : "market_report"),
    operationId, brand: g.brand === undefined ? (app === "postona" ? "brand_x" : null) : g.brand, pauseAt: g.pauseAt ?? null,
  });
}
async function answer(p: ReturnType<typeof spawn>): Promise<Result> {
  const d = await p.done;
  assert.equal(d.code, 0, d.err);
  return d.result as Result;
}
const codeOf = (r: Result) => (r.ok ? "OK" : r.code!);
async function recover(o: { mode?: "advise" | "apply"; apps?: "all" | "postona"; revision?: string; abandonAfterSeconds?: number } = {}): Promise<Recovery> {
  const p = spawn({ role: "recover", revision: o.revision ?? "r1", apps: o.apps ?? "all", mode: o.mode ?? "apply", abandonAfterSeconds: o.abandonAfterSeconds ?? 1800 });
  const d = await p.done;
  assert.equal(d.code, 0, d.err);
  return d.result as Recovery;
}
/** Wait until the worker reports that it stopped at its pause point. */
async function paused(p: ReturnType<typeof spawn>, point: string): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if ((await rows(`select count(*) from g6r_fake.events where worker = '${p.name}' and point = '${point}'`)) === "1") return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${p.name} never paused at ${point}: ${(await p.done).err}`);
}
const resume = (p: ReturnType<typeof spawn>) => rows(`insert into g6r_fake.gates (worker) values ('${p.name}')`);
async function crash(p: ReturnType<typeof spawn>): Promise<void> {
  p.child.kill("SIGKILL");
  const d = await p.done;
  assert.deepEqual([d.signal, d.result], ["SIGKILL", null], "the process died without answering");
}

async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
/** The call key, recomputed here from the tenant (app + person + brand) and the operation (the gateway's definition). */
async function keyOf(op: string, who: { user?: string | null; brand?: string | null; app?: "postona" | "kabumori"; feature?: string } = {}) {
  const app = who.app ?? "postona";
  const user = who.user === undefined ? USER_A : who.user;
  const brand = who.brand === undefined ? "brand_x" : who.brand;
  const subject = user === null ? { kind: "system", app } : { kind: "user", app, userId: user, brand: brand === null ? null : { app, slug: brand } };
  const tenantTag = await sha256(JSON.stringify([app, subject]));
  return "h5m2_" + await sha256(JSON.stringify([tenantTag, `${app}:${who.feature ?? (app === "postona" ? "consult" : "market_report")}`, op]));
}
const sends = async (op: string) => Number(await rows(`select count(*) from g6r_fake.provider_requests where operation_id = '${op}'`));
const state = async (key: string) => await rows(`select coalesce((select state from ai_calls.consumer_calls where call_key = '${key}'), '-')`);
const ledger = async (key: string) => await rows(`select coalesce(string_agg(status, ',' order by attempt, created_at), '-') from ai_ledger.reservations where request_id = '${key}'`);
const audit = async (key: string) => JSON.parse(await rows(`select coalesce(audit::text, 'null') from ai_calls.consumer_calls where call_key = '${key}'`));
const ledgerCost = async (key: string) => Number(await rows(`select coalesce(sum(estimated_cost_usd), 0) from ai_ledger.usage_events where request_id = '${key}'`));
const finalised = async (key: string) => Number(await rows(`select count(*) from ai_ledger.reservations where request_id = '${key}' and status in ('settled', 'unknown')`));
const snapshot = () =>
  rows(`select coalesce(string_agg(call_key || ':' || state, ',' order by call_key), '-') || '|' ||
    (select coalesce(string_agg(request_id || ':' || attempt || ':' || status, ',' order by request_id, attempt, created_at), '-') from ai_ledger.reservations) || '|' ||
    (select count(*) from ai_ledger.usage_events) || '|' || (select count(*) from g6r_fake.provider_requests) from ai_calls.consumer_calls`);
const age = (key: string, seconds: number) =>
  rows(`set session_replication_role = replica; update ai_calls.consumer_calls set created_at = created_at - interval '${seconds} seconds' where call_key = '${key}'`);
/** As if the process had waited that long after mark_sent / after reserve. */
const ageLedger = (key: string, seconds: number) =>
  rows(`set session_replication_role = replica;
    update ai_ledger.reservations set sent_at = sent_at - interval '${seconds} seconds' where request_id = '${key}' and status = 'sent';
    update ai_ledger.reservations set expires_at = now() - interval '1 second' where request_id = '${key}' and status = 'reserved'`);
/** The ledger and the audit of a closed row agree: attempts = finalised attempts, cost never below the ledger. */
async function auditMatchesLedger(key: string, label: string) {
  const a = await audit(key);
  assert.equal(a.attempts, await finalised(key), `${label}: audit attempts = finalised ledger attempts`);
  assert.ok(a.estimatedCostUsd >= (await ledgerCost(key)) - 1e-9, `${label}: audit cost never below the ledger`);
  assert.equal(await rows(`select count(*) from ai_ledger.usage_events where request_id = '${key}'`), String(await finalised(key)), `${label}: one usage event per finalised attempt`);
}

Deno.test({ name: "setup: ledger policies, fake G5 (sessions, brand owners + owner epochs, entitlements)", ...opts }, async () => {
  await rows(`insert into ai_ledger.budget_policies
    (policy_key, scope_provider, scope_model, scope_application, scope_feature, scope_subject_kind, per_user, period, max_calls, max_estimated_usd, max_usd_per_call)
    values ('grr.postona.consult', 'openai', 'gpt-6-luna', 'postona', 'consult', 'user', true, 'day', 200, 5, 0.05),
           ('grr.postona.post', 'openai', 'gpt-6-luna', 'postona', 'post_generation', 'user', true, 'day', 200, 5, 0.2),
           ('grr.kabumori.report', 'anthropic', 'claude-haiku-5-5', 'kabumori', 'market_report', 'system', false, 'day', 200, 5, 0.05)`);
  await rows(`insert into g6r_fake.sessions values ('${JWT_A1}', '${USER_A}', 'sa1', 'active'), ('${JWT_A2}', '${USER_A}', 'sa2', 'active'), ('${JWT_B1}', '${USER_B}', 'sb1', 'active');
    insert into g6r_fake.entitlements values ('${USER_A}', 'postona:x_autopost'), ('${USER_B}', 'postona:x_autopost');
    insert into g6r_fake.brands values ('brand_x', '${USER_A}', 7, 1), ('brand_y', '${USER_A}', 3, 1), ('brand_b', '${USER_B}', 5, 1), ('brand_t', '${USER_A}', 9, 1), ('brand_e', '${USER_A}', 11, 1)`);
});

const POINTS = [
  ["claim", "after:ai_calls_claim"],
  ["reserve", "after:ai_ledger_reserve"],
  ["marksent", "after:ai_ledger_mark_sent"],
  ["provider", "provider"],
  ["settle", "after:ai_ledger_settle"],
  ["complete", "after:ai_calls_complete"],
] as const;

Deno.test({ name: "six crash points: live processes are never touched by recovery; after SIGKILL a restart never resends, recovery closes each row once (also while restarts race it), the ledger stays the truth", ...opts }, async () => {
  const ops = POINTS.map(([label]) => `op-gwr-crash-${label}`);
  const keys = await Promise.all(ops.map((op) => keyOf(op)));
  const a = POINTS.map(([, point], i) => gateway(ops[i], { pauseAt: point }));
  await Promise.all(a.map((p, i) => paused(p, POINTS[i][1])));

  // 1. Two recovery processes while the six gateway processes are alive (young rows): nothing changes.
  const before = await snapshot();
  const live = await Promise.all([recover({ abandonAfterSeconds: 300 }), recover({ abandonAfterSeconds: 300 })]);
  assert.equal(await snapshot(), before, "recovery wrote nothing while the calls were live");
  assert.ok(live.every((r) => r.candidates.every((c) => !keys.includes(c.callKey))));

  // 2. The six processes die (SIGKILL) where they waited.
  for (const p of a) await crash(p);
  assert.deepEqual(await Promise.all(keys.map(state)), ["acquired", "acquired", "acquired", "acquired", "acquired", "complete"]);
  assert.deepEqual(await Promise.all(keys.map(ledger)), ["-", "reserved", "sent", "sent", "settled", "settled"]);
  assert.deepEqual(await Promise.all(ops.map(sends)), [0, 0, 0, 1, 1, 1], "requests the provider received");

  // 3. Restarted processes (same person, same operation): the open ones are IN_PROGRESS, the recorded one replays; nothing is sent.
  const restarted = await Promise.all(ops.map((op) => answer(gateway(op))));
  assert.deepEqual(restarted.map(codeOf), ["IN_PROGRESS", "IN_PROGRESS", "IN_PROGRESS", "IN_PROGRESS", "IN_PROGRESS", "OK"]);
  assert.deepEqual(await Promise.all(ops.map(sends)), [0, 0, 0, 1, 1, 1]);

  // 4. Time passes (rows past the SQL age, sent attempts past the sent grace, unsent holds expired); then two recovery
  //    processes and five restarted gateway processes all run at the same time.
  for (const k of keys.slice(0, 5)) {
    await age(k, 1900);
    await ageLedger(k, 1000);
  }
  const racing = ops.slice(0, 5).map((op) => gateway(op));
  const [r1, r2] = await Promise.all([recover(), recover()]);
  const raced = await Promise.all(racing.map(answer));
  assert.ok(raced.every((r) => ["IN_PROGRESS", "UNKNOWN"].includes(codeOf(r))), JSON.stringify(raced.map(codeOf)));
  assert.deepEqual(await Promise.all(ops.map(sends)), [0, 0, 0, 1, 1, 1], "no restart sent anything");

  const all = [...r1.candidates, ...r2.candidates].filter((c) => keys.includes(c.callKey));
  for (const k of keys.slice(0, 5)) assert.equal(all.filter((c) => c.callKey === k && c.outcome === "ABANDONED").length, 1, `${k} closed exactly once`);
  const cls = Object.fromEntries(all.filter((c) => c.outcome === "ABANDONED").map((c) => [c.callKey, c.classification]));
  assert.deepEqual(keys.slice(0, 5).map((k) => cls[k]), ["NOT_SENT_PROVEN", "NOT_SENT_PROVEN", "POSSIBLY_SENT", "POSSIBLY_SENT", "RESULT_LOST"]);
  assert.equal(r1.recovered!.released + r2.recovered!.released, 1, "the expired unsent hold was released once");
  assert.equal(r1.recovered!.marked_unknown + r2.recovered!.marked_unknown, 2, "the two long-sent attempts became unknown once each");
  assert.deepEqual(await Promise.all(keys.map(ledger)), ["-", "released", "unknown", "unknown", "settled", "settled"]);
  for (const [i, k] of keys.slice(0, 5).entries()) {
    assert.equal(await state(k), "abandoned");
    await auditMatchesLedger(k, POINTS[i][0]);
  }
  // Every attempt that reached the provider is billed exactly once; mark_sent without a request is billed at its upper bound.
  assert.equal(await rows(`select count(*) from ai_ledger.usage_events where request_id in (${keys.map((k) => `'${k}'`).join(",")})`), "4");

  // 5. After recovery: every restart answers from the row and sends nothing.
  const after = await Promise.all(ops.map((op) => answer(gateway(op))));
  assert.deepEqual(after.map(codeOf), ["UNKNOWN", "UNKNOWN", "UNKNOWN", "UNKNOWN", "UNKNOWN", "OK"]);
  assert.deepEqual(await Promise.all(ops.map(sends)), [0, 0, 0, 1, 1, 1]);
  // NOT_SENT_PROVEN is provable (no request ever reached a provider) but can only be closed as UNKNOWN (BLOCKED_SQL_NO_NOT_SENT_CLOSE).
  assert.deepEqual([after[0].audit?.costBasis, after[1].audit?.costBasis], ["no_request", "no_request"]);
});

Deno.test({ name: "an in-flight valid attempt (live process, row past the SQL age): recovery WAITS, then the call finishes normally", ...opts }, async () => {
  const inFlight = gateway("op-gwr-live-provider", { feature: "post_generation", pauseAt: "provider" });
  const between = gateway("op-gwr-live-settled", { feature: "post_generation", pauseAt: "after:ai_ledger_settle" });
  await Promise.all([paused(inFlight, "provider"), paused(between, "after:ai_ledger_settle")]);
  const k1 = await keyOf("op-gwr-live-provider", { feature: "post_generation" });
  const k2 = await keyOf("op-gwr-live-settled", { feature: "post_generation" });
  await age(k1, 400);
  await age(k2, 400);
  const before = await snapshot();
  const [b1, b2] = await Promise.all([recover({ abandonAfterSeconds: 300 }), recover({ abandonAfterSeconds: 300 })]);
  const seen = [...b1.candidates, ...b2.candidates];
  assert.deepEqual(seen.filter((c) => c.callKey === k1).map((c) => c.outcome), ["WAIT_LEDGER_OPEN", "WAIT_LEDGER_OPEN"], "the attempt in flight is open in the ledger");
  assert.deepEqual(seen.filter((c) => c.callKey === k2).map((c) => c.outcome), ["WAIT_MAY_BE_RUNNING", "WAIT_MAY_BE_RUNNING"], "settled, but the 3-attempt policy may still be running");
  assert.equal(await snapshot(), before, "recovery wrote nothing");
  await resume(inFlight);
  await resume(between);
  assert.deepEqual([codeOf(await answer(inFlight)), codeOf(await answer(between))], ["OK", "OK"]);
  assert.deepEqual([await state(k1), await ledger(k1), await state(k2), await ledger(k2)], ["complete", "settled", "complete", "settled"]);
  assert.deepEqual([await sends("op-gwr-live-provider"), await sends("op-gwr-live-settled")], [1, 1]);
  await auditMatchesLedger(k1, "in flight");
  await auditMatchesLedger(k2, "between steps");
  const third = await recover({ abandonAfterSeconds: 300 });
  assert.ok(third.candidates.every((c) => c.callKey !== k1 && c.callKey !== k2));
});

Deno.test({ name: "a frozen process fenced by recovery and then resumed: it sends nothing new, its late writes are refused, the tombstone stays true to the ledger", ...opts }, async () => {
  const cases = [
    ["claim", "after:ai_calls_claim", 0],
    ["reserve", "after:ai_ledger_reserve", 0],
    ["provider", "provider", 1],
    ["settle", "after:ai_ledger_settle", 1],
  ] as const;
  const ops = cases.map(([label]) => `op-gwr-frozen-${label}`);
  const keys = await Promise.all(ops.map((op) => keyOf(op)));
  const procs = cases.map(([, point], i) => gateway(ops[i], { pauseAt: point }));
  await Promise.all(procs.map((p, i) => paused(p, cases[i][1])));
  // Frozen past every bound (a stalled VM, a hung runtime): recovery fences them.
  for (const k of keys) {
    await age(k, 1900);
    await ageLedger(k, 1000);
  }
  const fenced = await recover();
  assert.deepEqual(keys.map((k) => fenced.candidates.find((c) => c.callKey === k)?.outcome), ["ABANDONED", "ABANDONED", "ABANDONED", "ABANDONED"]);
  const tombstones = await Promise.all(keys.map(audit));
  for (const p of procs) await resume(p);
  const late = await Promise.all(procs.map(answer));
  assert.deepEqual(late.map(codeOf), ["UNKNOWN", "UNKNOWN", "UNKNOWN", "UNKNOWN"], "a fenced call answers UNKNOWN");
  assert.deepEqual(await Promise.all(ops.map(sends)), cases.map(([, , n]) => n), "no request after the fence");
  assert.deepEqual(await Promise.all(keys.map(audit)), tombstones, "the tombstones are unchanged");
  // The one fenced after its claim reserved, found the claim closed and released the hold (never marked sent, never billed).
  assert.deepEqual(await Promise.all(keys.map(ledger)), ["released", "released", "unknown", "settled"]);
  for (const [i, k] of keys.entries()) await auditMatchesLedger(k, `${cases[i][0]} after resume`);
  // The provider answered the in-flight one after the fence: the ledger keeps the upper bound (never the lower measured cost).
  assert.equal(await rows(`select cost_basis from ai_ledger.usage_events where request_id = '${keys[2]}'`), "upper_bound");
  const replay = await Promise.all(ops.map((op) => answer(gateway(op))));
  assert.deepEqual(replay.map(codeOf), ["UNKNOWN", "UNKNOWN", "UNKNOWN", "UNKNOWN"]);
  assert.deepEqual(await Promise.all(ops.map(sends)), cases.map(([, , n]) => n));
});

const callCounts = () => rows(`select (select count(*) from ai_calls.consumer_calls) || '|' || (select count(*) from ai_ledger.reservations)`);
const storedCode = async (key: string) => await rows(`select coalesce(result ->> 'code', 'ok') from ai_calls.consumer_calls where call_key = '${key}'`);

Deno.test({ name: "tenants across processes: the same operation id of another person, brand and app is its own row; a recovery process for one app never closes another app's rows", ...opts }, async () => {
  const op = "op-gwr-shared-1";
  const kx = await keyOf(op);
  const kb = await keyOf(op, { user: USER_B, brand: "brand_b" });
  const kk = await keyOf(op, { user: null, brand: null, app: "kabumori" });
  const ky = await keyOf(op, { brand: "brand_y" });
  assert.equal(new Set([kx, kb, kk, ky]).size, 4);
  // A (brand_x), B (brand_b) and the Kabumori system job (Anthropic) die while their provider request is in flight.
  const killed = [gateway(op, { pauseAt: "provider" }), gateway(op, { credential: JWT_B1, brand: "brand_b", pauseAt: "provider" }), gateway(op, { app: "kabumori", pauseAt: "provider" })];
  await Promise.all(killed.map((p) => paused(p, "provider")));
  for (const p of killed) await crash(p);
  // A's same operation on its other brand is another operation; A on B's brand is refused by G5 before any claim.
  assert.equal(codeOf(await answer(gateway(op, { brand: "brand_y" }))), "OK");
  const counts = await callCounts();
  assert.equal(codeOf(await answer(gateway(op, { brand: "brand_b" }))), "AUTH_DENIED");
  assert.equal(await callCounts(), counts, "a refused tenant claims and reserves nothing");
  assert.equal(await rows(`select provider || ':' || count(*) from g6r_fake.provider_requests where operation_id = '${op}' group by provider order by provider`), "anthropic:1\nopenai:3");

  for (const k of [kx, kb, kk]) {
    await age(k, 1900);
    await ageLedger(k, 1000);
  }
  // A recovery process configured for POSTONA only: the Kabumori row has no policy there and is left alone.
  const postonaOnly = await recover({ apps: "postona" });
  const by = (r: Recovery, k: string) => r.candidates.find((c) => c.callKey === k)?.outcome;
  assert.deepEqual([by(postonaOnly, kx), by(postonaOnly, kb), by(postonaOnly, kk)], ["ABANDONED", "ABANDONED", "UNREGISTERED"]);
  assert.deepEqual([await state(kx), await state(kb), await state(kk), await state(ky)], ["abandoned", "abandoned", "acquired", "complete"]);
  const full = await recover();
  assert.deepEqual([by(full, kk), full.candidates.find((c) => c.callKey === kk)?.classification], ["ABANDONED", "POSSIBLY_SENT"]);
  // Each row kept its own tenant, and its audit is its own ledger's.
  assert.equal(await rows(`select string_agg(coalesce(user_id::text, 'system') || ':' || application || ':' || coalesce(brand_ref, '-'), ',' order by call_key) from ai_calls.consumer_calls where call_key in ('${kx}', '${kb}', '${kk}', '${ky}')`),
    [[kx, `${USER_A}:postona:brand_x`], [kb, `${USER_B}:postona:brand_b`], [kk, "system:kabumori:-"], [ky, `${USER_A}:postona:brand_y`]].sort((p, q) => p[0] < q[0] ? -1 : 1).map((p) => p[1]).join(","));
  for (const k of [kx, kb, kk, ky]) await auditMatchesLedger(k, k);
  // Every tenant's restart answers from its own row, and nothing is sent again.
  const replays = await Promise.all([gateway(op), gateway(op, { credential: JWT_B1, brand: "brand_b" }), gateway(op, { app: "kabumori" }), gateway(op, { brand: "brand_y" })].map(answer));
  assert.deepEqual(replays.map(codeOf), ["UNKNOWN", "UNKNOWN", "UNKNOWN", "OK"]);
  assert.deepEqual(replays.map((r) => r.audit?.callKey), [kx, kb, kk, ky]);
  assert.equal(await sends(op), 4);
});

Deno.test({ name: "authority across processes: an owner-epoch change or a brand transfer while a process waits before sending stops it; a revoked session cannot replay; a new session of the same person can", ...opts }, async () => {
  // a) The brand's owner epoch changes (same owner) between reserve and send.
  const ka = await keyOf("op-gwr-epoch", { brand: "brand_t" });
  const a = gateway("op-gwr-epoch", { brand: "brand_t", pauseAt: "after:ai_ledger_reserve" });
  await paused(a, "after:ai_ledger_reserve");
  await rows(`update g6r_fake.brands set lifecycle = lifecycle + 1 where slug = 'brand_t'`);
  await resume(a);
  assert.equal(codeOf(await answer(a)), "AUTH_REVOKED_BEFORE_SEND");
  assert.deepEqual([await sends("op-gwr-epoch"), await ledger(ka), await state(ka), await storedCode(ka)], [0, "released", "complete", "POLICY_DENIED"]);
  // Restarted under the new epoch (still the owner): the stored refusal replays, nothing is sent.
  assert.equal(codeOf(await answer(gateway("op-gwr-epoch", { brand: "brand_t" }))), "NOT_SENT");

  // b) The brand moves to B between reserve and send: A is stopped, cannot replay, and B's same operation id is B's own call.
  const ke = await keyOf("op-gwr-transfer", { brand: "brand_e" });
  const t = gateway("op-gwr-transfer", { brand: "brand_e", pauseAt: "after:ai_ledger_reserve" });
  await paused(t, "after:ai_ledger_reserve");
  await rows(`update g6r_fake.brands set owner = '${USER_B}', owner_epoch = owner_epoch + 1 where slug = 'brand_e'`);
  await resume(t);
  assert.equal(codeOf(await answer(t)), "AUTH_REVOKED_BEFORE_SEND");
  const counts = await callCounts();
  assert.equal(codeOf(await answer(gateway("op-gwr-transfer", { brand: "brand_e" }))), "AUTH_DENIED");
  assert.equal(await callCounts(), counts);
  const nb = await answer(gateway("op-gwr-transfer", { credential: JWT_B1, brand: "brand_e" }));
  assert.deepEqual([codeOf(nb), nb.audit?.callKey === ke, await sends("op-gwr-transfer"), await storedCode(ke)], ["OK", false, 1, "POLICY_DENIED"]);

  // c) A process dies in flight; the session is revoked; the old JWT cannot replay (refused before any claim), recovery
  //    still closes the row, and a NEW session of the same person replays UNKNOWN without sending.
  const ks = await keyOf("op-gwr-session");
  const s = gateway("op-gwr-session", { pauseAt: "provider" });
  await paused(s, "provider");
  await crash(s);
  await rows(`update g6r_fake.sessions set state = 'revoked' where jwt = '${JWT_A1}'`);
  try {
    const before = await snapshot();
    assert.equal(codeOf(await answer(gateway("op-gwr-session"))), "AUTH_DENIED");
    assert.equal(await snapshot(), before, "a revoked session reads and writes nothing");
    await age(ks, 1900);
    await ageLedger(ks, 1000);
    assert.equal((await recover()).candidates.find((c) => c.callKey === ks)?.outcome, "ABANDONED");
    const fresh = await answer(gateway("op-gwr-session", { credential: JWT_A2 }));
    assert.deepEqual([codeOf(fresh), fresh.audit?.callKey, await sends("op-gwr-session")], ["UNKNOWN", ks, 1]);
  } finally {
    await rows(`update g6r_fake.sessions set state = 'active' where jwt = '${JWT_A1}'`);
  }
});

Deno.test({ name: "policy revision drift across a crash: no resend under either revision; the tombstone carries the recovery-time revision (call-time revision is not stored: BLOCKED)", ...opts }, async () => {
  const k = await keyOf("op-gwr-revision");
  const a = gateway("op-gwr-revision", { revision: "r1", pauseAt: "provider" });
  await paused(a, "provider");
  await crash(a);
  // The operator moved to r2: a restarted r2 process sees another operation under the same id.
  assert.equal(codeOf(await answer(gateway("op-gwr-revision", { revision: "r2" }))), "OPERATION_REUSED");
  await age(k, 1900);
  await ageLedger(k, 1000);
  assert.equal((await recover({ revision: "r2" })).candidates.find((c) => c.callKey === k)?.outcome, "ABANDONED");
  assert.equal((await audit(k)).policyVersion, "r2", "the coordinator can only write the revision it runs with");
  const [r2, r1] = await Promise.all([answer(gateway("op-gwr-revision", { revision: "r2" })), answer(gateway("op-gwr-revision", { revision: "r1" }))]);
  assert.deepEqual([codeOf(r2), codeOf(r1)], ["OPERATION_REUSED", "UNKNOWN"]);
  assert.equal(await sends("op-gwr-revision"), 1);
  await auditMatchesLedger(k, "revision drift");
});
