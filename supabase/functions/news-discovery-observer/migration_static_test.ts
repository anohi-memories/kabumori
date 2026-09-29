// Static guards on the observer migration: it may only create news_discovery_* objects, must not
// touch existing production tables, and must keep the privilege model (no client access).
import assert from "node:assert/strict";
import test from "node:test";
import { SEARCH_BUDGET_DEFAULTS } from "../_shared/news_discovery/search_config.ts";

const MIGRATION = new URL("../../migrations/20260929090000_news_discovery_observer.sql", import.meta.url);
const sql = await Deno.readTextFile(MIGRATION);
const code = sql.replace(/--[^\n]*/g, ""); // statements only (comments name existing tables on purpose)

test("creates only news_discovery_* tables, indexes and functions", () => {
  const created = [...code.matchAll(/create\s+(?:unique\s+)?(table|index|function|view|policy|trigger|type|sequence)\s+([a-z_.]+)/gi)]
    .map((m) => [m[1].toLowerCase(), m[2].toLowerCase()]);
  assert.ok(created.length >= 25);
  for (const [kind, name] of created) {
    assert.match(name, /^(public\.)?news_discovery_/, `${kind} ${name}`);
  }
});

test("never alters, drops or truncates anything, and never names existing production tables", () => {
  assert.doesNotMatch(code, /\b(alter\s+(?!table\s+public\.news_discovery_)|drop\s|truncate\s)/i);
  for (const existing of ["important_news_candidates", "important_news_monitor_runs", "ai_usage_events", "stocks_master",
    "tracked_stocks", "shadow", "social_accounts", "scheduled_posts", "cron."]) {
    assert.ok(!code.includes(existing), existing);
  }
});

test("RLS on every table; no grants to anon/authenticated; service_role may only SELECT tables", () => {
  const tables = [...code.matchAll(/create table (public\.news_discovery_[a-z_]+)/g)].map((m) => m[1]);
  assert.equal(tables.length, 7);
  for (const table of tables) assert.ok(code.includes(`alter table ${table} enable row level security`), table);
  assert.doesNotMatch(code, /grant[^;]*\bto\s+(anon|authenticated|public)\b/i);
  const tableGrants = [...code.matchAll(/grant\s+([a-z, ]+)\s+on\s+public\.news_discovery_/gi)].map((m) => m[1].trim().toLowerCase());
  assert.deepEqual(tableGrants, ["select"]);
  assert.doesNotMatch(code, /create policy/i);
});

test("every function is SECURITY DEFINER with a fixed empty search_path and service_role-only execute", () => {
  const functions = [...code.matchAll(/create function (public\.news_discovery_[a-z_]+)\(p jsonb\)([\s\S]*?)as \$\$/g)];
  assert.equal(functions.length, 7);
  for (const [, name, header] of functions) {
    assert.match(header, /security definer/, name);
    assert.match(header, /set search_path = ''/, name);
    assert.ok(code.includes(`${name}(jsonb)`), `${name} revoked/granted explicitly`);
  }
  assert.match(code, /revoke all on function[\s\S]*from public, anon, authenticated;/);
  assert.match(code, /grant execute on function[\s\S]*to service_role;/);
});

test("observer invariants and source policy are enforced by constraints", () => {
  // N3 v2: model calls are allowed only as part of a budgeted search.
  assert.match(code, /check \(ai_calls <= search_count\)/);
  assert.match(code, /check \(\(policy <> 'DIRECT_SOURCE'\) = discovery_only\)/);
  assert.match(code, /check \(not restricted_publisher or discovery_only\)/);
  assert.match(code, /not discovery_only or \(summary_hint is null and image_url is null and not title_display_allowed/);
  assert.match(code, /match_types = array\['WEAK_ALIAS'\]::text\[\]/);
  // Dedupe safety: title / URL are never unique (same-source same-title documents must survive).
  assert.doesNotMatch(code, /unique index[^;]*\((title|title_fingerprint|canonical_url|url_key)\b/i);
  assert.match(code, /unique index news_discovery_signals_source_external_uidx[\s\S]*where external_id is not null/);
  // M2: URL duplicates between concurrent runs are resolved under per-url_key locks taken in sorted
  // order (deadlock-free), not by a unique constraint.
  assert.match(code, /for v_key in select distinct x\.value ->> 'url_key'[\s\S]*?order by 1 loop\s*perform pg_advisory_xact_lock\(hashtext\('news_discovery_url'\), hashtext\(v_key\)\)/);
});

test("M1: run usage and persisted counts are derived from rows, not trusted from the client", () => {
  const finish = code.slice(code.indexOf("create function public.news_discovery_finish_run"), code.indexOf("create function public.news_discovery_reserve_search"));
  assert.match(finish, /from public\.news_discovery_searches s where s\.run_id = v_run/);
  assert.match(finish, /search_count = v_searches/);
  assert.match(finish, /ai_calls = greatest\(v_model,/);
  assert.match(finish, /search_useful_signal_count = v_persisted_useful/);
  assert.match(finish, /inserted_count = v_inserted/);
  const complete = code.slice(code.indexOf("create function public.news_discovery_complete_search"));
  assert.match(complete, /persisted_signal_count = v_persisted/);
});

test("header marks the file as a source candidate that must not be applied without review", () => {
  assert.match(sql.split("\n")[0], /SOURCE CANDIDATE ONLY/);
});

test("search budget: DB seed equals SEARCH_BUDGET_DEFAULTS; reserve is serialized and caps every reason", () => {
  const seed = code.match(/insert into public\.news_discovery_search_config[\s\S]*?values \(([^)]*)\)/);
  assert.ok(seed);
  const [soft, hard, rotation, cooldown, escalations] = seed[1].split(",").map((v) => Number(v.trim()));
  assert.deepEqual(
    { soft, hard, rotation, cooldown, escalations },
    {
      soft: SEARCH_BUDGET_DEFAULTS.daily_soft_budget,
      hard: SEARCH_BUDGET_DEFAULTS.daily_hard_limit,
      rotation: SEARCH_BUDGET_DEFAULTS.lane_rotation_interval_minutes,
      cooldown: SEARCH_BUDGET_DEFAULTS.search_key_cooldown_minutes,
      escalations: SEARCH_BUDGET_DEFAULTS.max_escalations_per_key_per_day,
    },
  );
  assert.match(code, /pg_advisory_xact_lock\(hashtext\('news_discovery_search_budget'\)\)/);
  // The hard cap is checked first, before any reason-specific rule.
  const reserve = code.slice(code.indexOf("create function public.news_discovery_reserve_search"));
  assert.ok(reserve.indexOf("'hard_cap'") < reserve.indexOf("'soft_budget'"));
  assert.match(code, /check \(daily_soft_budget <= daily_hard_limit\)/);
});
