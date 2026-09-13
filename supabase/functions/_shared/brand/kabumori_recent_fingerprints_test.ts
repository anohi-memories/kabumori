import assert from "node:assert/strict";
import test from "node:test";
import { fetchRecentKabumoriFingerprints } from "./kabumori_recent_fingerprints.ts";
import { fingerprintText } from "./cross_brand_dedupe.ts";

const REPORT_RUN_TABLES = [
  "close_report_runs",
  "morning_report_runs",
  "us_premarket_report_runs",
];

function fetchOnlyFrom(table: string, rows: unknown[]): typeof fetch {
  return async (input) => {
    const url = new URL(String(input));
    return url.pathname === `/rest/v1/${table}`
      ? Response.json(rows)
      : Response.json([]);
  };
}

test("a known published Kabumori post (from close_report_runs) can be read and represented as a real fingerprint, without ever returning the raw text", async () => {
  const realText = "日経平均は本日、前日比で反発しました。";
  const fingerprints = await fetchRecentKabumoriFingerprints({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "fixture-service-role-key",
    fetchImpl: fetchOnlyFrom("close_report_runs", [{
      generated_text: realText,
      generated_at: "2026-09-10T09:00:00.000Z",
    }]),
  });
  assert.equal(fingerprints.length, 1);
  assert.equal(fingerprints[0].brandId, "kabumori");
  assert.equal(fingerprints[0].publishedAt, "2026-09-10T09:00:00.000Z");
  assert.equal(
    fingerprints[0].normalizedTextSha256,
    await fingerprintText(realText),
  );
  assert.equal(
    JSON.stringify(fingerprints).includes(realText),
    false,
    "raw post text must never appear in the returned value",
  );
});

test("reads from all three per-report-type run tables (close/morning/us-premarket) and merges them, most recent first", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/v1/close_report_runs") {
      return Response.json([{
        generated_text: "クローズレポート本文。",
        generated_at: "2026-09-09T07:00:00.000Z",
      }]);
    }
    if (url.pathname === "/rest/v1/morning_report_runs") {
      return Response.json([{
        generated_text: "モーニングレポート本文。",
        generated_at: "2026-09-11T23:20:00.000Z",
      }]);
    }
    if (url.pathname === "/rest/v1/us_premarket_report_runs") {
      return Response.json([]);
    }
    throw new Error(`unexpected table queried: ${url.pathname}`);
  };
  const fingerprints = await fetchRecentKabumoriFingerprints({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "k",
    fetchImpl,
  });
  assert.equal(fingerprints.length, 2);
  // morning_report (09-11) is more recent than close_report (09-09) -- must come first.
  assert.equal(fingerprints[0].publishedAt, "2026-09-11T23:20:00.000Z");
  assert.equal(fingerprints[1].publishedAt, "2026-09-09T07:00:00.000Z");
});

for (const table of REPORT_RUN_TABLES) {
  test(`queries ${table} for only succeeded, brand_id=kabumori, non-null generated_text rows, most recent first`, async () => {
    let capturedUrl = "";
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname === `/rest/v1/${table}`) capturedUrl = String(input);
      return Response.json([]);
    };
    await fetchRecentKabumoriFingerprints({
      supabaseUrl: "https://example.supabase.co",
      serviceRoleKey: "k",
      fetchImpl,
    });
    const url = new URL(capturedUrl);
    assert.equal(url.searchParams.get("status"), "eq.succeeded");
    assert.equal(url.searchParams.get("brand_id"), "eq.kabumori");
    assert.equal(url.searchParams.get("generated_text"), "not.is.null");
    assert.equal(url.searchParams.get("order"), "generated_at.desc");
  });
}

test("regression: never queries post_execution_logs, which has no generated_text column (the root cause of the first real invocation returning kabumori_posts_checked: 0)", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/v1/post_execution_logs") {
      throw new Error(
        "must never query post_execution_logs for generated text -- it has no such column",
      );
    }
    return Response.json([]);
  };
  await fetchRecentKabumoriFingerprints({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "k",
    fetchImpl,
  });
});

test("skips rows with missing/empty generated_text or generated_at without throwing", async () => {
  const fingerprints = await fetchRecentKabumoriFingerprints({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "fixture-service-role-key",
    fetchImpl: fetchOnlyFrom("close_report_runs", [
      { generated_text: null, generated_at: "2026-09-10T09:00:00.000Z" },
      { generated_text: "", generated_at: "2026-09-10T09:00:00.000Z" },
      { generated_text: "有効な本文です。", generated_at: null },
      {
        generated_text: "もう一つの有効な本文。",
        generated_at: "2026-09-11T09:00:00.000Z",
      },
    ]),
  });
  assert.equal(fingerprints.length, 1);
  assert.equal(fingerprints[0].publishedAt, "2026-09-11T09:00:00.000Z");
});

test("fails safe per table (empty for that table, never throws) on a non-ok response, a network failure, or an unparseable body -- and other tables are unaffected", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/v1/close_report_runs") {
      return new Response("error", { status: 500 });
    }
    if (url.pathname === "/rest/v1/morning_report_runs") {
      throw new Error("network down");
    }
    if (url.pathname === "/rest/v1/us_premarket_report_runs") {
      return new Response("not json", { status: 200 });
    }
    return Response.json([]);
  };
  const fingerprints = await fetchRecentKabumoriFingerprints({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "k",
    fetchImpl,
  });
  assert.deepEqual(fingerprints, []);
});

test("live strict mode fails closed if any legacy report-text source cannot be read", async () => {
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/rest/v1/morning_report_runs") {
      return new Response("unavailable", { status: 503 });
    }
    return Response.json([]);
  };
  await assert.rejects(
    () =>
      fetchRecentKabumoriFingerprints({
        supabaseUrl: "https://example.supabase.co",
        serviceRoleKey: "k",
        strict: true,
        fetchImpl,
      }),
    { message: "KABUMORI_FINGERPRINT_READ_FAILED" },
  );
});

test("this module never imports the legacy token loader, OAuth module, or any Vault-related file", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("./kabumori_recent_fingerprints.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /from\s+["'][^"']*(token_loader|x_oauth2_post|oauth_connection)\.ts["']/u,
  );
});
