import assert from "node:assert/strict";
import test from "node:test";
import { fetchRecentKabumoriFingerprints } from "./kabumori_recent_fingerprints.ts";
import { fingerprintText } from "./cross_brand_dedupe.ts";

test("a known published Kabumori post can be read and represented as a real fingerprint, without ever returning the raw text", async () => {
  const realText = "日経平均は本日、前日比で反発しました。";
  const fetchImpl: typeof fetch = async () =>
    Response.json([{ generated_text: realText, created_at: "2026-09-10T09:00:00.000Z" }]);
  const fingerprints = await fetchRecentKabumoriFingerprints({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "fixture-service-role-key",
    fetchImpl,
  });
  assert.equal(fingerprints.length, 1);
  assert.equal(fingerprints[0].brandId, "kabumori");
  assert.equal(fingerprints[0].publishedAt, "2026-09-10T09:00:00.000Z");
  assert.equal(fingerprints[0].normalizedTextSha256, await fingerprintText(realText));
  assert.equal(JSON.stringify(fingerprints).includes(realText), false, "raw post text must never appear in the returned value");
});

test("queries only succeeded, brand_id=kabumori, non-null generated_text rows, most recent first", async () => {
  let capturedUrl = "";
  const fetchImpl: typeof fetch = async (input) => {
    capturedUrl = String(input);
    return Response.json([]);
  };
  await fetchRecentKabumoriFingerprints({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "fixture-service-role-key",
    fetchImpl,
  });
  const url = new URL(capturedUrl);
  assert.equal(url.pathname, "/rest/v1/post_execution_logs");
  assert.equal(url.searchParams.get("status"), "eq.succeeded");
  assert.equal(url.searchParams.get("brand_id"), "eq.kabumori");
  assert.equal(url.searchParams.get("generated_text"), "not.is.null");
  assert.equal(url.searchParams.get("order"), "created_at.desc");
});

test("skips rows with missing/empty generated_text or created_at without throwing", async () => {
  const fetchImpl: typeof fetch = async () =>
    Response.json([
      { generated_text: null, created_at: "2026-09-10T09:00:00.000Z" },
      { generated_text: "", created_at: "2026-09-10T09:00:00.000Z" },
      { generated_text: "有効な本文です。", created_at: null },
      { generated_text: "もう一つの有効な本文。", created_at: "2026-09-11T09:00:00.000Z" },
    ]);
  const fingerprints = await fetchRecentKabumoriFingerprints({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "fixture-service-role-key",
    fetchImpl,
  });
  assert.equal(fingerprints.length, 1);
  assert.equal(fingerprints[0].publishedAt, "2026-09-11T09:00:00.000Z");
});

test("fails safe (empty array, never throws) on a non-ok response, a network failure, or an unparseable body", async () => {
  const notOk = await fetchRecentKabumoriFingerprints({
    supabaseUrl: "https://example.supabase.co", serviceRoleKey: "k",
    fetchImpl: async () => new Response("error", { status: 500 }),
  });
  assert.deepEqual(notOk, []);

  const networkFailure = await fetchRecentKabumoriFingerprints({
    supabaseUrl: "https://example.supabase.co", serviceRoleKey: "k",
    fetchImpl: async () => { throw new Error("network down"); },
  });
  assert.deepEqual(networkFailure, []);

  const unparseable = await fetchRecentKabumoriFingerprints({
    supabaseUrl: "https://example.supabase.co", serviceRoleKey: "k",
    fetchImpl: async () => new Response("not json", { status: 200 }),
  });
  assert.deepEqual(unparseable, []);
});

test("this module never imports the legacy token loader, OAuth module, or any Vault-related file", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./kabumori_recent_fingerprints.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from\s+["'][^"']*(token_loader|x_oauth2_post|oauth_connection)\.ts["']/u);
});
