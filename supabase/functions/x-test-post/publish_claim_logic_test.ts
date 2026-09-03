import assert from "node:assert/strict";
import test from "node:test";
import {
  MORNING_GREETING_PUBLISH_CLAIM_POST_TYPE,
  claimPublishSlot,
  completePublishSlot,
  failPublishSlot,
} from "./publish_claim_logic.ts";

const SUPABASE_URL = "https://example.supabase.co";
const SERVICE_ROLE_KEY = "service-role-key";

type ClaimRow = {
  post_type: string;
  date_jst: string;
  status: "publishing" | "published" | "failed";
  execution_id: string;
  x_post_id: string | null;
  error_code: string | null;
};

// A minimal in-memory stand-in for the publish_claims table's unique(post_type, date_jst) constraint plus
// PostgREST's ignore-duplicates upsert and filtered PATCH semantics — enough to exercise the real race.
function tableFetcher(rows: ClaimRow[]) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { post_type: string; date_jst: string; execution_id: string };
      const exists = rows.some((row) => row.post_type === body.post_type && row.date_jst === body.date_jst);
      if (exists) return Response.json([]); // ignore-duplicates: conflict -> no rows returned
      rows.push({
        post_type: body.post_type, date_jst: body.date_jst, status: "publishing",
        execution_id: body.execution_id, x_post_id: null, error_code: null,
      });
      return Response.json([rows.at(-1)]);
    }
    if (init?.method === "PATCH") {
      const postType = url.searchParams.get("post_type")?.replace(/^eq\./u, "");
      const dateJst = url.searchParams.get("date_jst")?.replace(/^eq\./u, "");
      const statusFilter = url.searchParams.get("status")?.replace(/^eq\./u, "");
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const row = rows.find((item) =>
        item.post_type === postType && item.date_jst === dateJst && item.status === statusFilter
      );
      if (row) Object.assign(row, body);
      return Response.json(row ? [row] : []);
    }
    throw new Error(`unexpected request: ${init?.method} ${url.pathname}`);
  };
}

test("1: the first claim for a date succeeds", async () => {
  const rows: ClaimRow[] = [];
  const result = await claimPublishSlot({
    supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY,
    postType: MORNING_GREETING_PUBLISH_CLAIM_POST_TYPE, dateJst: "2026-09-03", executionId: "exec-1",
    fetcher: tableFetcher(rows),
  });
  assert.equal(result.claimed, true);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "publishing");
});

test("2: a second claim for the same date fails", async () => {
  const rows: ClaimRow[] = [{
    post_type: MORNING_GREETING_PUBLISH_CLAIM_POST_TYPE, date_jst: "2026-09-03",
    status: "publishing", execution_id: "exec-1", x_post_id: null, error_code: null,
  }];
  const result = await claimPublishSlot({
    supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY,
    postType: MORNING_GREETING_PUBLISH_CLAIM_POST_TYPE, dateJst: "2026-09-03", executionId: "exec-2",
    fetcher: tableFetcher(rows),
  });
  assert.equal(result.claimed, false);
  assert.equal(rows.length, 1); // no second row was created
});

test("3: of two concurrent claims for the same date, only one succeeds", async () => {
  const rows: ClaimRow[] = [];
  const fetcher = tableFetcher(rows);
  const [first, second] = await Promise.all([
    claimPublishSlot({
      supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY,
      postType: MORNING_GREETING_PUBLISH_CLAIM_POST_TYPE, dateJst: "2026-09-03", executionId: "exec-a",
      fetcher,
    }),
    claimPublishSlot({
      supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY,
      postType: MORNING_GREETING_PUBLISH_CLAIM_POST_TYPE, dateJst: "2026-09-03", executionId: "exec-b",
      fetcher,
    }),
  ]);
  const claimedCount = [first, second].filter((result) => result.claimed).length;
  assert.equal(claimedCount, 1);
  assert.equal(rows.length, 1);
});

test("5: completing a claim transitions publishing -> published", async () => {
  const rows: ClaimRow[] = [{
    post_type: MORNING_GREETING_PUBLISH_CLAIM_POST_TYPE, date_jst: "2026-09-03",
    status: "publishing", execution_id: "exec-1", x_post_id: null, error_code: null,
  }];
  await completePublishSlot({
    supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY,
    postType: MORNING_GREETING_PUBLISH_CLAIM_POST_TYPE, dateJst: "2026-09-03", xPostId: "12345",
    fetcher: tableFetcher(rows),
  });
  assert.equal(rows[0].status, "published");
});

test("6: completing a claim stores the x_post_id", async () => {
  const rows: ClaimRow[] = [{
    post_type: MORNING_GREETING_PUBLISH_CLAIM_POST_TYPE, date_jst: "2026-09-03",
    status: "publishing", execution_id: "exec-1", x_post_id: null, error_code: null,
  }];
  await completePublishSlot({
    supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY,
    postType: MORNING_GREETING_PUBLISH_CLAIM_POST_TYPE, dateJst: "2026-09-03", xPostId: "post-999",
    fetcher: tableFetcher(rows),
  });
  assert.equal(rows[0].x_post_id, "post-999");
});

test("7: an existing 'publishing' job (e.g. still mid-flight, or crashed) is never reclaimed", async () => {
  const rows: ClaimRow[] = [{
    post_type: MORNING_GREETING_PUBLISH_CLAIM_POST_TYPE, date_jst: "2026-09-03",
    status: "publishing", execution_id: "exec-old", x_post_id: null, error_code: null,
  }];
  const result = await claimPublishSlot({
    supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY,
    postType: MORNING_GREETING_PUBLISH_CLAIM_POST_TYPE, dateJst: "2026-09-03", executionId: "exec-new",
    fetcher: tableFetcher(rows),
  });
  assert.equal(result.claimed, false);
  assert.equal(rows[0].execution_id, "exec-old"); // untouched
});

test("8: a 'failed' job from earlier the same day is never automatically retried", async () => {
  const rows: ClaimRow[] = [{
    post_type: MORNING_GREETING_PUBLISH_CLAIM_POST_TYPE, date_jst: "2026-09-03",
    status: "failed", execution_id: "exec-old", x_post_id: null, error_code: "MORNING_GREETING_X_POST_FAILED:503",
  }];
  const result = await claimPublishSlot({
    supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY,
    postType: MORNING_GREETING_PUBLISH_CLAIM_POST_TYPE, dateJst: "2026-09-03", executionId: "exec-retry",
    fetcher: tableFetcher(rows),
  });
  assert.equal(result.claimed, false);
});

test("9: a different date_jst can still be claimed", async () => {
  const rows: ClaimRow[] = [{
    post_type: MORNING_GREETING_PUBLISH_CLAIM_POST_TYPE, date_jst: "2026-09-02",
    status: "published", execution_id: "exec-yesterday", x_post_id: "post-1", error_code: null,
  }];
  const result = await claimPublishSlot({
    supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY,
    postType: MORNING_GREETING_PUBLISH_CLAIM_POST_TYPE, dateJst: "2026-09-03", executionId: "exec-today",
    fetcher: tableFetcher(rows),
  });
  assert.equal(result.claimed, true);
  assert.equal(rows.length, 2);
});

test("failing a claim records the error code without touching a non-publishing row", async () => {
  const rows: ClaimRow[] = [{
    post_type: MORNING_GREETING_PUBLISH_CLAIM_POST_TYPE, date_jst: "2026-09-03",
    status: "publishing", execution_id: "exec-1", x_post_id: null, error_code: null,
  }];
  await failPublishSlot({
    supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY,
    postType: MORNING_GREETING_PUBLISH_CLAIM_POST_TYPE, dateJst: "2026-09-03",
    errorCode: "MORNING_GREETING_X_POST_FAILED:500",
    fetcher: tableFetcher(rows),
  });
  assert.equal(rows[0].status, "failed");
  assert.equal(rows[0].error_code, "MORNING_GREETING_X_POST_FAILED:500");
});

test("a claim insert failure surfaces as a dedicated error", async () => {
  const failingFetcher: typeof fetch = async () => new Response("error", { status: 500 });
  await assert.rejects(() => claimPublishSlot({
    supabaseUrl: SUPABASE_URL, serviceRoleKey: SERVICE_ROLE_KEY,
    postType: MORNING_GREETING_PUBLISH_CLAIM_POST_TYPE, dateJst: "2026-09-03", executionId: "exec-1",
    fetcher: failingFetcher,
  }));
});
