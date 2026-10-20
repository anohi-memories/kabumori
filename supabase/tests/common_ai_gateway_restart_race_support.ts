// G6-07 / G6-08 (2026-10-20): the orchestration side of the separate-process harness, shared by
// common_ai_gateway_restart_race_pg_test.ts (G6-07) and common_ai_gateway_fence_review_pg_test.ts (G6-08): spawning the
// worker processes (common_ai_gateway_restart_race_worker.ts), pausing / resuming / SIGKILLing them, and reading the
// database (ai_calls, ledger, provider requests). Not a test file by itself.
import assert from "node:assert/strict";

export const HOST = Deno.env.get("GRR_PGHOST");
export const PORT = Deno.env.get("GRR_PGPORT");
export const SUPER = Deno.env.get("GRR_PGSUPER");
export const DB = Deno.env.get("GRR_DB");
export const CONFIG = Deno.env.get("GRR_DENO_CONFIG");
export const enabled = !!HOST && !!PORT && !!SUPER && !!DB && !!CONFIG && /^\/(private\/)?tmp\//.test(HOST);
export const opts = { ignore: !enabled, sanitizeOps: false, sanitizeResources: false };
export const WORKER = new URL("./common_ai_gateway_restart_race_worker.ts", import.meta.url).pathname;

export const USER_A = "00000000-0000-4000-8000-0000000000a1";
export const USER_B = "00000000-0000-4000-8000-0000000000b2";
// Fake JWT-shaped session tokens of the fake G5 (not real tokens).
export const JWT_A1 = "g6r-user-a.session-1.sig";
export const JWT_A2 = "g6r-user-a.session-2.sig";
export const JWT_B1 = "g6r-user-b.session-1.sig";

export async function psql(statement: string): Promise<{ ok: boolean; out: string; err: string }> {
  const output = await new Deno.Command("psql", {
    args: ["-X", "-h", HOST!, "-p", PORT!, "-U", SUPER!, "-d", DB!, "-Atq", "-v", "ON_ERROR_STOP=1", "-c", statement],
    env: { LC_ALL: "C" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes).trim();
  return { ok: output.success, out: decode(output.stdout), err: decode(output.stderr) };
}
export async function rows(sql: string): Promise<string> {
  const r = await psql(sql);
  assert.ok(r.ok, r.err);
  return r.out;
}

export type Result = { ok: boolean; code?: string; data?: unknown; audit?: { callKey: string; attempts: number; costBasis: string } | null };
export type Candidate = { callKey: string; classification: string | null; outcome: string; detail?: string };
export type Recovery = { candidates: Candidate[]; recovered: { released: number; marked_unknown: number } | null };
export type Gw = {
  revision?: string;
  credential?: string;
  app?: "postona" | "kabumori";
  feature?: string;
  brand?: string | null;
  pauseAt?: string | null;
  faults?: Record<string, "lost" | "down">;
  providerReplies?: string[];
  rpcTimeoutMs?: number;
  trace?: boolean;
  ownerHeld?: boolean;
};
export let seq = 0;
/** One separate process. `done` resolves with its RESULT line, or with the signal that killed it. */
export function spawn(job: Record<string, unknown>) {
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
export function gateway(operationId: string, g: Gw = {}) {
  const app = g.app ?? "postona";
  return spawn({
    role: "gateway", revision: g.revision ?? "r1", credential: g.credential ?? JWT_A1, app, feature: g.feature ?? (app === "postona" ? "consult" : "market_report"),
    operationId, brand: g.brand === undefined ? (app === "postona" ? "brand_x" : null) : g.brand, pauseAt: g.pauseAt ?? null,
    faults: g.faults, providerReplies: g.providerReplies, rpcTimeoutMs: g.rpcTimeoutMs, trace: g.trace, ownerHeld: g.ownerHeld,
  });
}
export async function answer(p: ReturnType<typeof spawn>): Promise<Result> {
  const d = await p.done;
  assert.equal(d.code, 0, d.err);
  return d.result as Result;
}
export const codeOf = (r: Result) => (r.ok ? "OK" : r.code!);
export async function recover(o: { mode?: "advise" | "apply"; apps?: "all" | "postona"; revision?: string; abandonAfterSeconds?: number } = {}): Promise<Recovery> {
  const p = spawn({ role: "recover", revision: o.revision ?? "r1", apps: o.apps ?? "all", mode: o.mode ?? "apply", abandonAfterSeconds: o.abandonAfterSeconds ?? 1800 });
  const d = await p.done;
  assert.equal(d.code, 0, d.err);
  return d.result as Recovery;
}
/** Wait until the worker reports that it stopped at its pause point. */
export async function paused(p: ReturnType<typeof spawn>, point: string): Promise<void> {
  for (let i = 0; i < 600; i++) {
    if ((await rows(`select count(*) from g6r_fake.events where worker = '${p.name}' and point = '${point}'`)) === "1") return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${p.name} never paused at ${point}: ${(await p.done).err}`);
}
export const resume = (p: ReturnType<typeof spawn>) => rows(`insert into g6r_fake.gates (worker) values ('${p.name}')`);
export async function crash(p: ReturnType<typeof spawn>): Promise<void> {
  p.child.kill("SIGKILL");
  const d = await p.done;
  assert.deepEqual([d.signal, d.result], ["SIGKILL", null], "the process died without answering");
}

export async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
/** The call key, recomputed here from the tenant (app + person + brand) and the operation (the gateway's definition). */
export async function keyOf(op: string, who: { user?: string | null; brand?: string | null; app?: "postona" | "kabumori"; feature?: string } = {}) {
  const app = who.app ?? "postona";
  const user = who.user === undefined ? USER_A : who.user;
  const brand = who.brand === undefined ? "brand_x" : who.brand;
  const subject = user === null ? { kind: "system", app } : { kind: "user", app, userId: user, brand: brand === null ? null : { app, slug: brand } };
  const tenantTag = await sha256(JSON.stringify([app, subject]));
  return "h5m2_" + await sha256(JSON.stringify([tenantTag, `${app}:${who.feature ?? (app === "postona" ? "consult" : "market_report")}`, op]));
}
export const sends = async (op: string) => Number(await rows(`select count(*) from g6r_fake.provider_requests where operation_id = '${op}'`));
export const state = async (key: string) => await rows(`select coalesce((select state from ai_calls.consumer_calls where call_key = '${key}'), '-')`);
export const ledger = async (key: string) => await rows(`select coalesce(string_agg(status, ',' order by attempt, created_at), '-') from ai_ledger.reservations where request_id = '${key}'`);
export const audit = async (key: string) => JSON.parse(await rows(`select coalesce(audit::text, 'null') from ai_calls.consumer_calls where call_key = '${key}'`));
export const ledgerCost = async (key: string) => Number(await rows(`select coalesce(sum(estimated_cost_usd), 0) from ai_ledger.usage_events where request_id = '${key}'`));
export const finalised = async (key: string) => Number(await rows(`select count(*) from ai_ledger.reservations where request_id = '${key}' and status in ('settled', 'unknown')`));
export const snapshot = () =>
  rows(`select coalesce(string_agg(call_key || ':' || state, ',' order by call_key), '-') || '|' ||
    (select coalesce(string_agg(request_id || ':' || attempt || ':' || status, ',' order by request_id, attempt, created_at), '-') from ai_ledger.reservations) || '|' ||
    (select count(*) from ai_ledger.usage_events) || '|' || (select count(*) from g6r_fake.provider_requests) from ai_calls.consumer_calls`);
export const age = (key: string, seconds: number) =>
  rows(`set session_replication_role = replica; update ai_calls.consumer_calls set created_at = created_at - interval '${seconds} seconds' where call_key = '${key}'`);
/** As if the process had waited that long after mark_sent / after reserve. */
export const ageLedger = (key: string, seconds: number) =>
  rows(`set session_replication_role = replica;
    update ai_ledger.reservations set sent_at = sent_at - interval '${seconds} seconds' where request_id = '${key}' and status = 'sent';
    update ai_ledger.reservations set expires_at = now() - interval '1 second' where request_id = '${key}' and status = 'reserved'`);
/** The ledger and the audit of a closed row agree: attempts = finalised attempts, cost never below the ledger. */
export async function auditMatchesLedger(key: string, label: string) {
  const a = await audit(key);
  assert.equal(a.attempts, await finalised(key), `${label}: audit attempts = finalised ledger attempts`);
  assert.ok(a.estimatedCostUsd >= (await ledgerCost(key)) - 1e-9, `${label}: audit cost never below the ledger`);
  assert.equal(await rows(`select count(*) from ai_ledger.usage_events where request_id = '${key}'`), String(await finalised(key)), `${label}: one usage event per finalised attempt`);
}

/** The ledger policies and the fake G5 (sessions, entitlements, brand owners + owner epochs) every harness test file starts from. */
export async function setupFixtures(): Promise<void> {
  await rows(`insert into ai_ledger.budget_policies
    (policy_key, scope_provider, scope_model, scope_application, scope_feature, scope_subject_kind, per_user, period, max_calls, max_estimated_usd, max_usd_per_call)
    values ('grr.postona.consult', 'openai', 'gpt-6-luna', 'postona', 'consult', 'user', true, 'day', 200, 5, 0.05),
           ('grr.postona.post', 'openai', 'gpt-6-luna', 'postona', 'post_generation', 'user', true, 'day', 200, 5, 0.2),
           ('grr.kabumori.report', 'anthropic', 'claude-haiku-5-5', 'kabumori', 'market_report', 'system', false, 'day', 200, 5, 0.05)`);
  await rows(`insert into g6r_fake.sessions values ('${JWT_A1}', '${USER_A}', 'sa1', 'active'), ('${JWT_A2}', '${USER_A}', 'sa2', 'active'), ('${JWT_B1}', '${USER_B}', 'sb1', 'active');
    insert into g6r_fake.entitlements values ('${USER_A}', 'postona:x_autopost'), ('${USER_B}', 'postona:x_autopost');
    insert into g6r_fake.brands values ('brand_x', '${USER_A}', 7, 1), ('brand_y', '${USER_A}', 3, 1), ('brand_b', '${USER_B}', 5, 1), ('brand_t', '${USER_A}', 9, 1), ('brand_e', '${USER_A}', 11, 1)`);
}
