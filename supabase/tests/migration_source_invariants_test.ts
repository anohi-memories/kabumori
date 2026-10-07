// deno test --no-config --allow-read supabase/tests/migration_source_invariants_test.ts
//
// Source-side invariants of supabase/migrations (no database, no network):
//   - every filename is <14-digit valid timestamp>_<name>.sql and its version is unique;
//   - the dependency order that fresh replay needs (found by audit 2026-09-30) holds;
//   - known versions (already applied to Production or reserved by open work) are
//     not reused for a different migration.
// History: two migrations were renamed by "source canonicalization" -- see
// docs/mic/migration-source-canonicalization-20260930.md.
import assert from "node:assert/strict";

const MIGRATIONS = new URL("../migrations/", import.meta.url);

type Migration = { file: string; version: string; name: string; sql: string };

const FILENAME = /^(\d{14})_([a-z0-9_]+)\.sql$/;

async function load(): Promise<Migration[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(MIGRATIONS)) if (entry.isFile) files.push(entry.name);
  files.sort();
  const out: Migration[] = [];
  for (const file of files) {
    const match = FILENAME.exec(file);
    assert.ok(match, `unparseable migration filename: ${file}`);
    out.push({ file, version: match[1], name: match[2], sql: await Deno.readTextFile(new URL(file, MIGRATIONS)) });
  }
  return out;
}

const code = (sql: string) => sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
const position = (migrations: Migration[], version: string) => migrations.findIndex((m) => m.version === version);

// Why a component is wrong, or null for a real UTC calendar timestamp. Each
// component is range-checked on its own (Date.UTC alone would silently roll an
// overflowing field over -- second 60 becomes minute +1 -- and blame the wrong
// component), then the whole is round-tripped through Date as a final guard.
function invalidTimestampReason(version: string): string | null {
  if (!/^\d{14}$/.test(version)) return "not 14 digits";
  const [y, mo, d, h, mi, s] = [
    version.slice(0, 4), version.slice(4, 6), version.slice(6, 8),
    version.slice(8, 10), version.slice(10, 12), version.slice(12, 14),
  ].map(Number);
  if (y < 2026 || y > 2027) return "implausible year";
  if (mo < 1 || mo > 12) return "invalid month";
  if (d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return "invalid day";
  if (h > 23) return "invalid hour";
  if (mi > 59) return "invalid minute";
  if (s > 59) return "invalid second";
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  const roundTrip = [
    date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(),
    date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(),
  ];
  return roundTrip.every((value, index) => value === [y, mo, d, h, mi, s][index]) ? null : "does not round-trip";
}

Deno.test("[F] every filename parses and its version is a real calendar timestamp (year..second)", async () => {
  for (const { file, version } of await load()) assert.equal(invalidTimestampReason(version), null, file);
});

Deno.test("[F] timestamp validation rejects each invalid component (no migration file is created)", () => {
  assert.equal(invalidTimestampReason("20260930123456"), null);
  assert.equal(invalidTimestampReason("20260930235959"), null, "last valid second of the day");
  assert.equal(invalidTimestampReason("20260930123460"), "invalid second");
  assert.equal(invalidTimestampReason("20260930123499"), "invalid second");
  assert.equal(invalidTimestampReason("20260930126000"), "invalid minute");
  assert.equal(invalidTimestampReason("20260930246000"), "invalid hour");
  assert.equal(invalidTimestampReason("20260931120000"), "invalid day");
  assert.equal(invalidTimestampReason("20260230120000"), "invalid day");
  assert.equal(invalidTimestampReason("20261330120000"), "invalid month");
  assert.equal(invalidTimestampReason("20260900120000"), "invalid day");
  assert.equal(invalidTimestampReason("2026093012345"), "not 14 digits");
  assert.equal(invalidTimestampReason("20250930123456"), "implausible year");
});

Deno.test("[A][B] no two migrations share a version (duplicate version count is 0)", async () => {
  const seen = new Map<string, string>();
  const duplicates: string[] = [];
  for (const { file, version } of await load()) {
    const other = seen.get(version);
    if (other) duplicates.push(`${version}: ${other} / ${file}`);
    seen.set(version, file);
  }
  assert.deepEqual(duplicates, []);
});

Deno.test("[F] lexicographic filename order is chronological order", async () => {
  const migrations = await load();
  const versions = migrations.map((m) => m.version);
  assert.deepEqual(versions, [...versions].sort());
});

Deno.test("canonical versions of the two renamed migrations, and the macro migration that keeps 20260922090000", async () => {
  const migrations = await load();
  const byName = new Map(migrations.map((m) => [m.name, m.version]));
  assert.equal(byName.get("mic_macro_indicators_phase1a"), "20260922090000", "macro keeps its version");
  assert.equal(byName.get("mic_central_bank_decision_event_type_phase2b3"), "20260922093000");
  assert.equal(byName.get("mic_estat_activation_and_gated_macro_cron"), "20260924093000");
  // The old versions must not come back for those migrations.
  assert.ok(!migrations.some((m) => m.version === "20260920061041"));
  assert.equal(migrations.filter((m) => m.version === "20260922090000").length, 1);
});

Deno.test("[C] the e-Stat source is registered before the migration that activates it", async () => {
  const migrations = await load();
  const seed = migrations.filter((m) =>
    /insert\s+into\s+public\.mic_source_registry[\s\S]*?'estat'/i.test(code(m.sql))
  );
  const activation = migrations.filter((m) => code(m.sql).includes("Expected exactly one estat source registry row"));
  assert.equal(seed.length, 1, "exactly one migration registers the estat source");
  assert.equal(activation.length, 1, "exactly one migration activates it");
  assert.ok(
    position(migrations, seed[0].version) < position(migrations, activation[0].version),
    `${seed[0].file} must sort before ${activation[0].file}`,
  );
  assert.equal(seed[0].name, "mic_macro_indicators_phase1b_estat_cpi");
  assert.equal(activation[0].name, "mic_estat_activation_and_gated_macro_cron");
});

Deno.test("Fed event-type migration stays after the Fed statement schema and before the diff schema", async () => {
  const migrations = await load();
  const at = (name: string) => position(migrations, migrations.find((m) => m.name === name)!.version);
  assert.ok(at("mic_fed_fomc_statement_phase2b2") < at("mic_central_bank_decision_event_type_phase2b3"));
  assert.ok(at("mic_central_bank_decision_event_type_phase2b3") < at("mic_fed_statement_diffs_phase2b5"));
});

Deno.test("[D] Phase 3A, the daily tip RPC and (when present) Phase 3C keep distinct, pinned versions", async () => {
  const migrations = await load();
  const byName = new Map(migrations.map((m) => [m.name, m.version]));
  assert.equal(byName.get("mic_scenario_layer_phase3a"), "20260928120000");
  assert.equal(byName.get("add_daily_kabumori_tip_rpc"), "20260928123000");
  // Phase 3C is not on main yet; if it arrives it must use its reserved version.
  const phase3c = byName.get("mic_scenario_automation_cron_phase3c");
  if (phase3c) assert.equal(phase3c, "20260930090000");
  assert.equal(migrations.filter((m) => m.version === "20260930090000").length <= 1, true);
  assert.notEqual(byName.get("mic_scenario_layer_phase3a"), byName.get("add_daily_kabumori_tip_rpc"));
});

// [E] Versions known to be in flight (open PRs, 2026-09-30) or already applied
// out of band. A repo migration may use one of these only for the SAME name.
// Extend this list when a new open PR adds a migration.
const RESERVED: Record<string, string> = {
  // PR 41 (Stage 3B) renumbered 2026-10-06 from the never-applied 20260927101423 / 20260927124300 so that it
  // sorts after the PR81 settings hardening its settings reader depends on.
  "20261006160000": "vault_account_brand_post_completion", // PR 41
  "20261006160100": "social_mobile_publish_settings_reader", // PR 41
  "20261006160200": "x_account_publish_authority", // PR 41
  "20260921115317": "important_news_search_diagnostics", // PR 3 (already on main)
  "20260930090000": "mic_scenario_automation_cron_phase3c", // reserved for MIC Phase 3C
  "20261001150000": "common_account_lifecycle_foundation", // common account v1 Phase 1 (source candidate)
  "20261002090000": "mic_jgb_nikkei_observation_grace_stage0", // MIC State freshness Stage 0
  "20261003090000": "social_mobile_publish_permission_boundary", // PR 76 corrective (source candidate)
  "20261007150000": "postona_social_accounts_multi_provider", // POSTONA multi-provider account schema candidate\n  "20261007173000": "ai_lab_topic_evergreen_capacity", // AI Lab topic-pool capacity fix (source candidate)
};

// Versions given up by open work: never reused by any migration.
const RETIRED = new Set(["20260927101423", "20260927124300"]); // PR 41, renumbered 2026-10-06

Deno.test("[E] retired versions are never reused", async () => {
  for (const { version, file } of await load()) assert.ok(!RETIRED.has(version), `${file} reuses retired ${version}`);
});

Deno.test("[E] versions reserved by open work are never used by a different migration", async () => {
  for (const { version, name, file } of await load()) {
    if (version in RESERVED) assert.equal(name, RESERVED[version], `${file} collides with reserved ${version}_${RESERVED[version]}`);
  }
});

Deno.test("the canonicalization did not reuse a version that was applied to Production under another name", async () => {
  // Production versions recorded in supabase_migrations (audit, read-only): the two new versions are not among them.
  const REMOTE = new Set([
    "20260912075354", "20260912235802", "20260913010947", "20260913230852", "20260913231013", "20260915130756",
    "20260918003438", "20260918003550", "20260919200538", "20260919222101", "20260922003120", "20260922024844",
    "20260923005453", "20260923084819", "20260924001508", "20260924024406",
  ]);
  const migrations = await load();
  for (const version of ["20260922093000", "20260924093000"]) {
    assert.ok(!REMOTE.has(version));
    assert.equal(migrations.filter((m) => m.version === version).length, 1);
  }
});
