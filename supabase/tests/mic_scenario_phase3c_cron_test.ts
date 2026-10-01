// deno test --no-config --allow-read supabase/tests/mic_scenario_phase3c_cron_test.ts
//
// Phase 3C: the Scenario Cron slots must follow every State evaluator slot
// that can update rates / macro / equity_index, and must not fire without a
// State slot just before it. The State evaluator jobs are read from the
// migration files themselves (last definition of a job name wins, like
// cron.schedule's upsert), so a future State schedule change that is not
// mirrored here fails this test instead of silently leaving the Scenario
// stale.
import assertStrict from "node:assert/strict";

const assert = (value: unknown, message?: string) => assertStrict.ok(value, message);
const assertEquals = (actual: unknown, expected: unknown, message?: string) => assertStrict.deepEqual(actual, expected, message);

const MIGRATIONS = new URL("../migrations/", import.meta.url);
const PHASE3C = "20260930090000_mic_scenario_automation_cron_phase3c.sql";
const SCENARIO_DOMAINS = ["rates", "macro", "equity_index"];

type CronJob = { name: string; schedule: string; command: string };

async function readMigrations(): Promise<Array<{ file: string; sql: string }>> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(MIGRATIONS)) if (entry.isFile && entry.name.endsWith(".sql")) files.push(entry.name);
  files.sort();
  return Promise.all(files.map(async (file) => ({ file, sql: await Deno.readTextFile(new URL(file, MIGRATIONS)) })));
}

// Replays cron.schedule / cron.unschedule in file order.
function replayJobs(migrations: Array<{ sql: string }>): Map<string, CronJob> {
  const jobs = new Map<string, CronJob>();
  const statement = /cron\.(schedule|unschedule)\(\s*'([^']+)'(?:\s*,\s*'([^']+)'\s*,\s*\$\$([\s\S]*?)\$\$)?\s*\)/g;
  for (const { sql } of migrations) {
    // Comments must not be parsed as statements.
    const code = sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    for (const match of code.matchAll(statement)) {
      const [, kind, name, schedule, command] = match;
      if (kind === "unschedule") jobs.delete(name);
      else jobs.set(name, { name, schedule, command });
    }
    // PL/pgSQL form: `v_x constant text := $tag$ ... $tag$;` then
    // `perform cron.schedule('name', 'schedule', v_x)` (gated macro job).
    const constants = new Map<string, string>();
    for (const c of code.matchAll(/(\w+)\s+constant\s+text\s*:=\s*\$(\w+)\$([\s\S]*?)\$\2\$/g)) constants.set(c[1], c[3]);
    for (const p of code.matchAll(/perform\s+cron\.schedule\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*(\w+)\s*\)/g)) {
      const command = constants.get(p[3]);
      if (command) jobs.set(p[1], { name: p[1], schedule: p[2], command });
    }
  }
  return jobs;
}

function expandField(field: string, min: number, max: number): number[] {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    if (part === "*") for (let v = min; v <= max; v++) values.add(v);
    else if (/^\d+$/.test(part)) values.add(Number(part));
    else if (/^\d+-\d+$/.test(part)) {
      const [a, b] = part.split("-").map(Number);
      for (let v = a; v <= b; v++) values.add(v);
    } else throw new Error(`unsupported cron field ${field}`);
  }
  for (const v of values) assert(v >= min && v <= max, `${field} out of range`);
  return [...values].sort((x, y) => x - y);
}

// dow:hour:minute events of a 5-field cron (dom and month must be '*').
function events(schedule: string): Set<string> {
  const fields = schedule.trim().split(/\s+/);
  assertEquals(fields.length, 5, `5 fields: ${schedule}`);
  const [minute, hour, dom, month, dow] = fields;
  assertEquals([dom, month], ["*", "*"]);
  const out = new Set<string>();
  for (const d of expandField(dow, 0, 6)) {
    for (const h of expandField(hour, 0, 23)) for (const m of expandField(minute, 0, 59)) out.add(`${d}:${h}:${m}`);
  }
  return out;
}

const bodyDomains = (command: string): string[] => {
  const body = /body\s*:=\s*'(\{[^']*\})'/.exec(command)?.[1];
  const parsed = body ? JSON.parse(body) : {};
  return Array.isArray(parsed.domains) ? parsed.domains : [];
};

async function load() {
  const migrations = await readMigrations();
  const all = replayJobs(migrations);
  const state = [...all.values()].filter((job) =>
    job.command.includes("market-intelligence-state-evaluator") && bodyDomains(job.command).some((d) => SCENARIO_DOMAINS.includes(d))
  );
  const scenario = [...all.values()].filter((job) => job.command.includes("market-intelligence-scenario-evaluator"));
  return { migrations, all, state, scenario };
}

Deno.test("State evaluator jobs feeding the Scenario are found in the migrations (documented slot set)", async () => {
  const { state } = await load();
  const slots = new Map<string, Set<string>>();
  for (const job of state) {
    for (const domain of bodyDomains(job.command)) {
      if (!SCENARIO_DOMAINS.includes(domain)) continue;
      const set = slots.get(domain) ?? new Set<string>();
      for (const e of events(job.schedule)) set.add(e.split(":").slice(1).join(":"));
      slots.set(domain, set);
    }
  }
  // Production (2026-09-30): rates 01:15 06:15 09:15 21:15; macro 01:15 21:15 22:15; equity_index 01:15 21:15.
  const hm = (domain: string) => [...(slots.get(domain) ?? [])].sort();
  assertEquals(hm("rates"), ["1:15", "21:15", "6:15", "9:15"]);
  assertEquals(hm("macro"), ["1:15", "21:15", "22:15"]);
  assertEquals(hm("equity_index"), ["1:15", "21:15"]);
});

Deno.test("every State evaluator slot for the Scenario domains is followed by a Scenario slot 10 minutes later, same weekdays", async () => {
  const { state, scenario } = await load();
  assert(state.length > 0 && scenario.length > 0);
  const scenarioEvents = new Set<string>();
  for (const job of scenario) for (const e of events(job.schedule)) scenarioEvents.add(e);
  const stateEvents = new Set<string>();
  for (const job of state) for (const e of events(job.schedule)) stateEvents.add(e);
  for (const e of stateEvents) {
    const [d, h, m] = e.split(":").map(Number);
    assert(scenarioEvents.has(`${d}:${h}:${m + 10}`), `no Scenario slot after State slot ${e}`);
  }
});

Deno.test("no Scenario slot fires without a State slot 10 minutes before it (no pointless invocations)", async () => {
  const { state, scenario } = await load();
  const stateEvents = new Set<string>();
  for (const job of state) for (const e of events(job.schedule)) stateEvents.add(e);
  for (const job of scenario) {
    for (const e of events(job.schedule)) {
      const [d, h, m] = e.split(":").map(Number);
      assert(stateEvents.has(`${d}:${h}:${m - 10}`), `${job.name} slot ${e} has no State slot before it`);
    }
  }
});

Deno.test("at most 5 invocations per day and 25 per week", async () => {
  const { scenario } = await load();
  const all = new Set<string>();
  for (const job of scenario) for (const e of events(job.schedule)) all.add(e);
  const perDay = new Map<string, number>();
  for (const e of all) perDay.set(e.split(":")[0], (perDay.get(e.split(":")[0]) ?? 0) + 1);
  assert(Math.max(...perDay.values()) <= 5);
  assertEquals(all.size, 25);
});

Deno.test("Phase 3C migration: independent jobs, Vault name only, no request without the secret, nothing else touched", async () => {
  const sql = await Deno.readTextFile(new URL(PHASE3C, MIGRATIONS));
  const { scenario } = await load();
  assertEquals(scenario.map((job) => job.name).sort(), ["mic-scenario-after-state-0100", "mic-scenario-after-state-weekday"]);
  for (const job of scenario) {
    assert(job.name.startsWith("mic-scenario-"));
    assert(job.command.includes("name = 'mic_scenario_evaluator_cron_secret'"));
    assert(job.command.includes("having count(*) = 1"), "ambiguous Vault name must not select an arbitrary secret");
    assert(job.command.includes("count(*) filter (where decrypted_secret is not null and decrypted_secret <> '') = 1"));
    assert(/\bfrom secret\s*;?\s*$/.test(job.command.trim()), "request only from the secret CTE");
    assert(!job.command.includes("cross join"), "no other gate that could hide a never-running job");
    assert(job.command.includes("https://wsmznyzcvmuitkglfeuj.supabase.co/functions/v1/market-intelligence-scenario-evaluator"));
    assert(!job.command.includes("state-evaluator") && !job.command.includes("ingest"));
    assert(job.command.includes("timeout_milliseconds := 150000"));
    assert(job.command.includes("body := '{\"trigger\":\"cron\"}'::jsonb"));
    assert(job.command.includes("'X-Cron-Secret', secret.decrypted_secret"));
  }
  // Only cron.schedule of the two new names; no secret value, no unschedule/alter/delete.
  const code = sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
  assertEquals([...code.matchAll(/cron\.(\w+)\(/g)].map((m) => m[1]), ["schedule", "schedule"]);
  assert(!/unschedule|alter\s|delete\s|drop\s|insert\s|vault\.create_secret/i.test(code));
  assert(!/eyJ|sk_|[0-9a-f]{32}/.test(code), "no secret-looking literal");
  assert(/\bbegin\s*;[\s\S]*\bcommit\s*;/i.test(code), "both jobs must be one transaction");
  for (const name of ["mic-scenario-after-state-0100", "mic-scenario-after-state-weekday"]) {
    assert(code.includes(`where jobname = '${name}'`), `${name} must be checked before scheduling`);
    assert(code.includes(`Cron conflict for ${name}; existing job not modified`), `${name} conflict must fail closed`);
  }
  assert(code.includes("v_job.command is distinct from v_command"));
  assert(code.includes("v_job.active is distinct from true"));
  assert(code.includes("v_job.database is distinct from current_database()"));
  assert(code.includes("v_job.username is distinct from current_user"));
  // Existing MIC jobs stay exactly as before: no other job is defined by this file.
  const migrations = await readMigrations();
  const before = replayJobs(migrations.filter((m) => m.file !== PHASE3C));
  const after = replayJobs(migrations);
  for (const [name, job] of before) assertEquals(after.get(name), job, `${name} unchanged`);
});

Deno.test("cron expression expander sanity", () => {
  assertEquals([...events("25 6,9 * * 1-2")].sort(), ["1:6:25", "1:9:25", "2:6:25", "2:9:25"]);
  assertEquals(events("25 1 * * 2-6").size, 5);
});
