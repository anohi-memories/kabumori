import assert from "node:assert/strict";
import test from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ADMIN_BRANDS } from "./admin-brands.ts";
import { getPostHistory } from "./post-history.ts";
import { getRecentFailures } from "./recent-failures.ts";
import { chooseActiveBrand, type ActiveBrand } from "./selected-brand.ts";
import { getSystemStatus } from "./system-status.ts";
import { getTodayScheduledPosts } from "./today-scheduled-posts.ts";

type RecordedQuery = { table: string; calls: Array<{ method: string; args: unknown[] }> };

// Records every query chain and answers it with fixture rows for that table. Any builder method is
// accepted and recorded; awaiting the chain (or .maybeSingle()) resolves it.
function recordingSupabase(rowsByTable: Record<string, unknown[]>) {
  const queries: RecordedQuery[] = [];
  const client = {
    from(table: string) {
      const query: RecordedQuery = { table, calls: [] };
      queries.push(query);
      const rows = rowsByTable[table] ?? [];
      const builder: Record<string, unknown> = new Proxy(
        {},
        {
          get(_target, property) {
            if (property === "then") {
              return (resolve: (value: unknown) => void) => resolve({ data: rows, error: null });
            }
            if (property === "maybeSingle" || property === "single") {
              return async () => ({ data: rows[0] ?? null, error: null });
            }
            return (...args: unknown[]) => {
              query.calls.push({ method: String(property), args });
              return builder;
            };
          },
        },
      );
      return builder;
    },
  } as unknown as SupabaseClient;
  return { client, queries };
}

function activeBrand(id: string): ActiveBrand {
  const result = chooseActiveBrand({
    access: { kind: "global", brandIds: null },
    requestedBrandId: id,
    registry: ADMIN_BRANDS,
  });
  assert.ok(result.kind === "ok" && !result.selectionRejected);
  return result.active;
}

function brandFilters(query: RecordedQuery) {
  return query.calls.filter((call) => call.method === "eq" && call.args[0] === "brand_id");
}

function assertEveryQueryBrandFiltered(queries: RecordedQuery[], brandId: string) {
  assert.ok(queries.length > 0, "expected at least one query");
  for (const query of queries) {
    assert.deepEqual(
      brandFilters(query).map((call) => call.args[1]),
      [brandId],
      `${query.table} must be filtered by brand_id = ${brandId}`,
    );
  }
}

const KABUMORI_ONLY_TABLES = [
  "important_news_candidates",
  "important_news_monitor_settings",
  "morning_report_settings",
  "close_report_settings",
  "us_premarket_report_settings",
  "useful_tip_schedule_settings",
];

const LOG_ROW = {
  id: 1,
  scheduled_post_id: "sp-1",
  post_type: "brand_post",
  status: "succeeded",
  tip_id: null,
  useful_tip_id: null,
  important_news_candidate_id: "inc-1",
  x_post_id: "1900000000000000000",
  message: null,
  error_code: null,
  created_at: "2026-09-24T00:00:00Z",
};

test("AI Lab: today's schedule only queries AI Lab rows", async () => {
  const { client, queries } = recordingSupabase({
    scheduled_posts: [{ id: "sp-1", schedule_date: "2026-09-24", post_type: "brand_post", scheduled_for: "2026-09-24T00:00:00Z", status: "pending" }],
    post_execution_logs: [],
  });
  await getTodayScheduledPosts(client, activeBrand("ai_salaryman_lab").id, new Date("2026-09-24T01:00:00Z"));
  assert.deepEqual(queries.map((q) => q.table), ["scheduled_posts", "post_execution_logs"]);
  assertEveryQueryBrandFiltered(queries, "ai_salaryman_lab");
});

test("AI Lab: post history filters every query and never touches Important News", async () => {
  const brand = activeBrand("ai_salaryman_lab");
  const { client, queries } = recordingSupabase({
    post_execution_logs: [LOG_ROW],
    scheduled_posts: [{ id: "sp-1", scheduled_for: "2026-09-24T00:00:00Z", attempt_count: 1 }],
  });
  const result = await getPostHistory(client, brand, 5);
  assert.equal(result.error, false);
  assert.deepEqual(
    queries.map((q) => q.table).sort(),
    ["close_report_runs", "morning_report_runs", "post_execution_logs", "scheduled_posts", "us_premarket_report_runs"],
  );
  assertEveryQueryBrandFiltered(queries, "ai_salaryman_lab");
  assert.equal(result.posts[0]?.xPostUrl, "https://x.com/kaishain_ai_lab/status/1900000000000000000");
});

test("Kabumori: post history keeps the yume_daka X URL and its Important News lookup", async () => {
  const brand = activeBrand("kabumori");
  const { client, queries } = recordingSupabase({ post_execution_logs: [LOG_ROW] });
  const result = await getPostHistory(client, brand, 5);
  assert.equal(result.posts[0]?.xPostUrl, "https://x.com/yume_daka/status/1900000000000000000");
  assertEveryQueryBrandFiltered(queries.filter((q) => q.table !== "important_news_candidates"), "kabumori");
  assert.ok(queries.some((q) => q.table === "important_news_candidates"));
});

test("AI Lab: recent failures filters every query and skips Important News", async () => {
  const { client, queries } = recordingSupabase({
    post_execution_logs: [{ ...LOG_ROW, status: "failed", important_news_candidate_id: null }],
    morning_report_runs: [],
    scheduled_posts: [],
  });
  const result = await getRecentFailures(client, activeBrand("ai_salaryman_lab").id);
  assert.equal(result.error, false);
  assert.deepEqual(
    queries.map((q) => q.table).sort(),
    ["morning_report_runs", "post_execution_logs", "scheduled_posts"],
  );
  assertEveryQueryBrandFiltered(queries, "ai_salaryman_lab");
});

test("Kabumori: recent failures still reads Important News failures", async () => {
  const { client, queries } = recordingSupabase({});
  await getRecentFailures(client, activeBrand("kabumori").id);
  assert.ok(queries.some((q) => q.table === "important_news_candidates"));
  assertEveryQueryBrandFiltered(queries.filter((q) => q.table !== "important_news_candidates"), "kabumori");
});

test("AI Lab: system status reads only AI Lab posting_windows, read-only, with no Kabumori settings", async () => {
  const { client, queries } = recordingSupabase({
    posting_windows: [
      { post_type: "brand_post", slot_no: 1, is_active: true, start_time: "08:00:00", end_time: "09:00:00" },
      { post_type: "brand_post", slot_no: 2, is_active: false, start_time: "12:00:00", end_time: "13:00:00" },
    ],
  });
  const result = await getSystemStatus(client, activeBrand("ai_salaryman_lab").id);
  assert.deepEqual(queries.map((q) => q.table), ["posting_windows"]);
  assertEveryQueryBrandFiltered(queries, "ai_salaryman_lab");
  assert.ok(result.scopeNote);
  assert.equal(result.systems.length, 1);
  assert.equal(result.systems[0]?.state, "active");
  assert.deepEqual(result.systems.flatMap((system) => system.toggles), []);
  for (const table of KABUMORI_ONLY_TABLES) {
    assert.ok(!queries.some((q) => q.table === table), `${table} must not be read for AI Lab`);
  }
});

test("Kabumori: system status keeps its full view with posting_windows filtered to Kabumori", async () => {
  const { client, queries } = recordingSupabase({});
  const result = await getSystemStatus(client, activeBrand("kabumori").id);
  assert.equal(result.scopeNote, null);
  assert.equal(result.systems.length, 8);
  const postingWindows = queries.filter((q) => q.table === "posting_windows");
  assert.equal(postingWindows.length, 3);
  assertEveryQueryBrandFiltered(postingWindows, "kabumori");
});
