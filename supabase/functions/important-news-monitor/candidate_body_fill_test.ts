// deno-lint-ignore-file require-await
// PR #129 R2 / F9: the guarded in-place body fill, against a fully mocked PostgREST table. No network, no database.
import assert from "node:assert/strict";
import test from "node:test";
import { fillMissingCandidateBody, storedStatementStates } from "./candidate_body_fill.ts";

type Row = { id: string; status: string; body_summary: string | null; source_name: string; content_hash: string; importance: string };

/** Minimal PostgREST double: applies id / status / source_name / or(body_summary null|empty) filters of a PATCH atomically. */
function mockTable(rows: Row[], hooks: { beforePatch?: (rows: Row[]) => void; failWith?: number; wrongBody?: boolean } = {}) {
  const calls: Array<{ url: URL; body: Record<string, unknown> }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url, body });
    assert.equal(init?.method, "PATCH");
    if (hooks.failWith) return new Response("err", { status: hooks.failWith });
    hooks.beforePatch?.(rows);
    const p = url.searchParams;
    const emptyBody = p.get("or") === "(body_summary.is.null,body_summary.eq.)";
    const matched = rows.filter((row) =>
      (!p.get("id") || `eq.${row.id}` === p.get("id")) &&
      (!p.get("status") || `eq.${row.status}` === p.get("status")) &&
      (!p.get("source_name") || `eq.${row.source_name}` === p.get("source_name")) &&
      (!emptyBody || row.body_summary === null || row.body_summary === "")
    );
    for (const row of matched) row.body_summary = hooks.wrongBody ? "other" : String(body.body_summary);
    return new Response(JSON.stringify(matched.map((row) => ({ id: row.id, status: row.status, body_summary: row.body_summary }))), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const row = (over: Partial<Row>): Row => ({
  id: "r1", status: "pending_judgement", body_summary: null, source_name: "market_macro", content_hash: "h-title-only", importance: "no_post", ...over,
});
const BODY = "【FOMC声明】3.75〜4%";

test("F9: only a pending, body-less market_macro row is changed; body is written and read back", async () => {
  const table = [row({})];
  const { fetchImpl } = mockTable(table);
  assert.equal(await fillMissingCandidateBody("https://x.test", "k", "r1", BODY, fetchImpl), "filled");
  assert.equal(table[0].body_summary, BODY);
  assert.equal(table[0].content_hash, "h-title-only", "content_hash is left as the headline-only hash");
  assert.equal(table[0].status, "pending_judgement");
});

test("F9: judged / generating / published / failed / duplicate rows are never touched, and nothing else is written", async () => {
  for (const status of ["no_post", "generating", "published", "generation_failed", "ready_for_generation", "duplicate", "failed"]) {
    const table = [row({ status, importance: "important" })];
    const before = JSON.stringify(table);
    const { fetchImpl, calls } = mockTable(table);
    assert.equal(await fillMissingCandidateBody("https://x.test", "k", "r1", BODY, fetchImpl), "skipped", status);
    assert.equal(JSON.stringify(table), before, status);
    assert.deepEqual(Object.keys(calls[0].body), ["body_summary"]);
  }
});

test("F9: a row of another lane or a row that already has a body is not changed; a second fill is idempotent", async () => {
  const other = [row({ source_name: "tdnet" })];
  assert.equal(await fillMissingCandidateBody("https://x.test", "k", "r1", BODY, mockTable(other).fetchImpl), "skipped");
  assert.equal(other[0].body_summary, null);
  const filled = [row({ body_summary: "既存の本文" })];
  assert.equal(await fillMissingCandidateBody("https://x.test", "k", "r1", BODY, mockTable(filled).fetchImpl), "skipped");
  assert.equal(filled[0].body_summary, "既存の本文");
  const table = [row({})];
  const { fetchImpl } = mockTable(table);
  assert.equal(await fillMissingCandidateBody("https://x.test", "k", "r1", BODY, fetchImpl), "filled");
  assert.equal(await fillMissingCandidateBody("https://x.test", "k", "r1", "second body", fetchImpl), "skipped");
  assert.equal(table[0].body_summary, BODY);
});

test("F9: judgement winning the race (status moved between lookup and update) leaves the row alone", async () => {
  const table = [row({})];
  const { fetchImpl } = mockTable(table, { beforePatch: (rows) => { rows[0].status = "no_post"; } });
  assert.equal(await fillMissingCandidateBody("https://x.test", "k", "r1", BODY, fetchImpl), "skipped");
  assert.equal(table[0].body_summary, null);
});

test("F9: a write failure is raised (reported and retried next run), an unexpected read-back is an error, an empty body is skipped", async () => {
  await assert.rejects(fillMissingCandidateBody("https://x.test", "k", "r1", BODY, mockTable([row({})], { failWith: 500 }).fetchImpl), /BODY_FILL_FAILED/u);
  await assert.rejects(fillMissingCandidateBody("https://x.test", "k", "r1", BODY, mockTable([row({})], { wrongBody: true }).fetchImpl), /READBACK_MISMATCH/u);
  const table = [row({})];
  const { fetchImpl, calls } = mockTable(table);
  assert.equal(await fillMissingCandidateBody("https://x.test", "k", "r1", "   ", fetchImpl), "skipped");
  assert.equal(calls.length, 0);
});

test("F9: stored state — other lanes are reported as having a body so they are neither fetched for nor updated", async () => {
  const rows: Record<string, { id: string; status: string; body_summary: string | null; source_name: string }> = {
    "https://a": { id: "1", status: "pending_judgement", body_summary: null, source_name: "market_macro" },
    "https://b": { id: "2", status: "pending_judgement", body_summary: null, source_name: "breaking_market" },
    "https://c": { id: "3", status: "published", body_summary: "x", source_name: "market_macro" },
  };
  const states = await storedStatementStates(
    ["a", "b", "c", "d"].map((n) => ({ sourceUrl: `https://${n}`, normalizedUrl: `https://${n}` })),
    async (url) => rows[url] ?? null,
  );
  assert.deepEqual(states.get("https://a"), { id: "1", status: "pending_judgement", hasBody: false });
  assert.equal(states.get("https://b")?.hasBody, true);
  assert.equal(states.get("https://c")?.hasBody, true);
  assert.equal(states.has("https://d"), false);
});
