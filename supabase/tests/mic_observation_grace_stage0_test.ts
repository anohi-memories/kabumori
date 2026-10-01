// deno test --no-config --allow-read supabase/tests/mic_observation_grace_stage0_test.ts
//
// State freshness Stage 0: the observation-freshness values for JGB2Y / JGB10Y
// and NIKKEI225 must tolerate ordinary Japanese weekends and holiday clusters
// without calling them 'stale', and must still call a real outage 'stale'.
// The values are read from the migration itself; the classification mirrors
// v_mic_metric_observation_status (20260915090000):
//   age = now - observed_date 00:00 UTC
//   age <= lag -> fresh; age <= stale_after -> delayed_expected; else stale.
import assert from "node:assert/strict";

const MIGRATION = new URL("../migrations/20261002090000_mic_jgb_nikkei_observation_grace_stage0.sql", import.meta.url);
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

type Policy = { lagMinutes: number; staleAfterMinutes: number };
type Status = "fresh" | "delayed_expected" | "stale";

function classify(observedDate: string, now: number, policy: Policy): Status {
  const ageMinutes = (now - Date.parse(`${observedDate}T00:00:00Z`)) / MINUTE;
  if (ageMinutes <= policy.lagMinutes) return "fresh";
  if (ageMinutes <= policy.staleAfterMinutes) return "delayed_expected";
  return "stale";
}

// Before this migration (Production, read 2026-10-01): JGB had no per-metric
// values and fell back to 1440 / 3 x 1440; NIKKEI225 had 4320 / 7200.
const OLD_JGB: Policy = { lagMinutes: 1440, staleAfterMinutes: 4320 };
const OLD_NIKKEI: Policy = { lagMinutes: 4320, staleAfterMinutes: 7200 };

async function migrationCode(): Promise<string> {
  const sql = await Deno.readTextFile(MIGRATION);
  return sql.split("\n").map((line) => line.replace(/--.*$/, "")).join("\n");
}

async function newPolicies(): Promise<{ jgb: Policy; nikkei: Policy }> {
  const code = await migrationCode();
  const jgb = /set expected_observation_lag_minutes = (\d+),\s*observation_stale_after_minutes = (\d+),[\s\S]*?where metric_key in \('JGB2Y', 'JGB10Y'\)/.exec(code);
  const nikkei = /set observation_stale_after_minutes = (\d+),[\s\S]*?where metric_key = 'NIKKEI225'\s+and expected_observation_lag_minutes = (\d+)/.exec(code);
  assert.ok(jgb && nikkei, "migration statements not found");
  return {
    jgb: { lagMinutes: Number(jgb[1]), staleAfterMinutes: Number(jgb[2]) },
    nikkei: { lagMinutes: Number(nikkei[2]), staleAfterMinutes: Number(nikkei[1]) },
  };
}

// Business days with a row in the real MOF current-month file (September 2026),
// plus the neighbouring days. 09-21..09-23 are holidays: no row.
const JP_SESSIONS = [
  "2026-09-10", "2026-09-11", "2026-09-14", "2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18",
  "2026-09-24", "2026-09-25", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02",
];

// JGB: day D's yields are published on the next business day; the ingest runs
// at 06:00 and 09:00 UTC. Model: D's row is readable from the next session's
// 06:00 UTC ingest onwards.
function latestJgbRowAt(now: number): string {
  let latest = JP_SESSIONS[0];
  for (let i = 0; i + 1 < JP_SESSIONS.length; i++) {
    if (Date.parse(`${JP_SESSIONS[i + 1]}T06:00:00Z`) <= now) latest = JP_SESSIONS[i];
  }
  return latest;
}

// NIKKEI225 via FRED: the session's row is there the same day; the ingest that
// feeds the equity_index evaluator runs at 21:00 UTC (and 01:00 UTC).
function latestNikkeiRowAt(now: number): string {
  let latest = JP_SESSIONS[0];
  for (const session of JP_SESSIONS) if (Date.parse(`${session}T21:00:00Z`) <= now) latest = session;
  return latest;
}

function hours(from: string, to: string): number[] {
  const out: number[] = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += HOUR) out.push(t);
  return out;
}

Deno.test("migration values: JGB fresh <= 96 h / stale after 10 d; NIKKEI225 fresh <= 72 h / stale after 8 d", async () => {
  const { jgb, nikkei } = await newPolicies();
  assert.deepEqual(jgb, { lagMinutes: 96 * 60, staleAfterMinutes: 10 * 24 * 60 });
  assert.deepEqual(nikkei, { lagMinutes: 72 * 60, staleAfterMinutes: 8 * 24 * 60 });
  // mic_metric_domain_map_stale_after_gt_lag_check
  assert.ok(jgb.staleAfterMinutes > jgb.lagMinutes && nikkei.staleAfterMinutes > nikkei.lagMinutes);
  // Not the same value for both: JGB carries a next-business-day publication lag on top.
  assert.ok(jgb.staleAfterMinutes > nikkei.staleAfterMinutes);
});

Deno.test("migration touches only the three metric rows: no DDL, no other metric, no Cron / State / Scenario object", async () => {
  const code = await migrationCode();
  assert.deepEqual([...code.matchAll(/\b(update|insert|delete|alter|create|drop|truncate|grant|revoke)\b/gi)].map((m) => m[1].toLowerCase()), ["update", "update"]);
  assert.equal(/cron\.|market_state|mic_scenario|vault\./i.test(code), false);
  const keys = new Set([...code.matchAll(/'([A-Z0-9_]+)'/g)].map((m) => m[1]));
  assert.deepEqual([...keys].sort(), ["JGB10Y", "JGB2Y", "NIKKEI225"]);
  // Fails closed if the rows are not what was expected.
  assert.equal((code.match(/raise exception/g) ?? []).length, 2);
});

Deno.test("JGB across the real 2026-09-18 -> 09-24 holiday cluster: never stale now (it was stale before)", async () => {
  const { jgb } = await newPolicies();
  const timeline = hours("2026-09-15T00:00:00Z", "2026-10-02T23:00:00Z");
  const now = timeline.map((t) => classify(latestJgbRowAt(t), t, jgb));
  const before = timeline.map((t) => classify(latestJgbRowAt(t), t, OLD_JGB));
  assert.equal(now.includes("stale"), false, "holiday cluster and weekends are not outages");
  assert.ok(before.includes("stale"), "the old 3-day cutoff called them stale");
  // The longest age in the cluster: the 09-18 row on the morning of 09-25, just before 09-24's row is read.
  const worst = Date.parse("2026-09-25T05:59:00Z");
  assert.equal(latestJgbRowAt(worst), "2026-09-18");
  assert.equal(classify("2026-09-18", worst, jgb), "delayed_expected");
  assert.equal(classify("2026-09-18", worst, OLD_JGB), "stale");
});

Deno.test("JGB at the rates evaluator slots (06:15 / 09:15 UTC): fresh on ordinary days and after a weekend", async () => {
  const { jgb } = await newPolicies();
  // Tue 09-15 .. Fri 09-18 and Mon 09-28 .. Fri 10-02: ordinary sessions.
  for (const day of ["2026-09-15", "2026-09-16", "2026-09-17", "2026-09-18", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"]) {
    for (const slot of ["06:15", "09:15"]) {
      const t = Date.parse(`${day}T${slot}:00Z`);
      assert.equal(classify(latestJgbRowAt(t), t, jgb), "fresh", `${day} ${slot}`);
    }
  }
  // Monday 09-28 06:15: Friday 09-25's row, 78 h old.
  const monday = Date.parse("2026-09-28T06:15:00Z");
  assert.equal(latestJgbRowAt(monday), "2026-09-25");
  assert.equal(classify("2026-09-25", monday, OLD_JGB), "stale", "every Monday used to be stale");
  // Before: not even an ordinary weekday was 'fresh' (30 h > 24 h).
  const tuesday = Date.parse("2026-09-29T06:15:00Z");
  assert.equal(classify(latestJgbRowAt(tuesday), tuesday, OLD_JGB), "delayed_expected");
});

Deno.test("JGB: a real outage is still reported, and an old history-file fallback is still stale", async () => {
  const { jgb } = await newPolicies();
  const lastRow = "2026-09-30";
  assert.equal(classify(lastRow, Date.parse("2026-10-09T23:00:00Z"), jgb), "delayed_expected", "9.96 days");
  assert.equal(classify(lastRow, Date.parse("2026-10-10T00:01:00Z"), jgb), "stale", "just over 10 days");
  // Production before the adapter fix: the 08-31 row on 2026-10-01 (32 days) stays stale under the new values too.
  assert.equal(classify("2026-08-31", Date.parse("2026-10-01T21:15:00Z"), jgb), "stale");
});

Deno.test("NIKKEI225 at the equity_index evaluator slots across the same cluster: never stale now (it was stale before)", async () => {
  const { nikkei } = await newPolicies();
  // Slots: 21:15 UTC Mon-Fri and 01:15 UTC Tue-Sat.
  const slots = hours("2026-09-15T00:00:00Z", "2026-10-02T23:00:00Z")
    .map((t) => [t + 15 * MINUTE, new Date(t)] as const)
    .filter(([, d]) => (d.getUTCHours() === 21 && d.getUTCDay() >= 1 && d.getUTCDay() <= 5) || (d.getUTCHours() === 1 && d.getUTCDay() >= 2 && d.getUTCDay() <= 6))
    .map(([t]) => t);
  assert.ok(slots.length > 20);
  const now = slots.map((t) => classify(latestNikkeiRowAt(t), t, nikkei));
  const before = slots.map((t) => classify(latestNikkeiRowAt(t), t, OLD_NIKKEI));
  assert.equal(now.includes("stale"), false);
  assert.ok(before.includes("stale"), "5 days was shorter than the 6-day cluster");
  // The slot that used to go stale: Wed 09-23 21:15 UTC, newest row still 09-18 (5.9 days).
  const worst = Date.parse("2026-09-23T21:15:00Z");
  assert.equal(latestNikkeiRowAt(worst), "2026-09-18");
  assert.equal(classify("2026-09-18", worst, OLD_NIKKEI), "stale");
  assert.equal(classify("2026-09-18", worst, nikkei), "delayed_expected");
  // Ordinary days are unchanged: fresh.
  const ordinary = Date.parse("2026-09-29T21:15:00Z");
  assert.equal(classify(latestNikkeiRowAt(ordinary), ordinary, nikkei), "fresh");
  assert.equal(classify(latestNikkeiRowAt(ordinary), ordinary, OLD_NIKKEI), "fresh");
});

Deno.test("NIKKEI225: year-end worst ordinary gap (Fri 12-29 -> Thu 01-04) is tolerated; a longer silence is stale", async () => {
  const { nikkei } = await newPolicies();
  // Evaluated Wed 01-03 21:15 UTC with the 12-29 row: 5.9 days. Thu 01-04 20:59 before the new row: 6.87 days.
  assert.equal(classify("2023-12-29", Date.parse("2024-01-04T20:59:00Z"), nikkei), "delayed_expected");
  assert.equal(classify("2023-12-29", Date.parse("2024-01-04T20:59:00Z"), OLD_NIKKEI), "stale");
  assert.equal(classify("2026-09-18", Date.parse("2026-09-26T00:01:00Z"), nikkei), "stale", "just over 8 days");
  // Shorter than JGB on purpose.
  const { jgb } = await newPolicies();
  assert.equal(classify("2026-09-18", Date.parse("2026-09-26T00:01:00Z"), jgb), "delayed_expected");
});
