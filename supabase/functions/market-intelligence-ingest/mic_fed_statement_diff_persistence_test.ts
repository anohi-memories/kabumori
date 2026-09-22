import assert from "node:assert/strict";
import test from "node:test";
import { buildFedStatementDiff } from "./mic_fed_statement_diff.ts";
import {
  buildFedStatementAiUsageEvent,
  buildFedStatementDiffPipeline,
  buildFedStatementDiffRow,
  mockLunaInterpretation,
  persistFedStatementDiff,
} from "./mic_fed_statement_diff_persistence.ts";
import type { FedStatementRecord } from "./mic_fed_statement_diff.ts";

const previous: FedStatementRecord = {
  eventId: "00000000-0000-0000-0000-000000000001",
  centralBank: "Fed",
  meetingDate: "2026-07-29",
  documentHash: "a".repeat(64),
  statementUrl: "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260729a.htm",
  normalizedText: "Inflation remains elevated. The labor market is solid. The Committee will assess risks.",
  decision: "hold",
  targetRange: { lower: 3.75, upper: 4 },
};
const current: FedStatementRecord = {
  ...previous,
  eventId: "00000000-0000-0000-0000-000000000002",
  meetingDate: "2026-09-16",
  documentHash: "b".repeat(64),
  statementUrl: "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm",
  normalizedText: "Inflation remains elevated and persistent. The labor market is solid. The Committee will assess risks.",
};

test("first statement creates a baseline row and skips AI", async () => {
  const pipeline = await buildFedStatementDiffPipeline(current, null);
  assert.equal(pipeline.row.previous_event_id, null);
  assert.equal(pipeline.aiInput, null);
  assert.equal(pipeline.aiSkippedReason, "first_statement_no_baseline");
});

test("identical and punctuation-only changes skip AI", async () => {
  const identical = await buildFedStatementDiffPipeline({ ...current, eventId: "current-2", normalizedText: current.normalizedText }, current);
  assert.equal(identical.aiSkippedReason, "no_material_change");
  const punctuation = await buildFedStatementDiffPipeline({ ...current, eventId: "current-3", normalizedText: current.normalizedText.replaceAll(".", "!") }, current);
  assert.equal(punctuation.aiInput, null);
});

test("material wording change creates compact Luna candidate and persistence row", async () => {
  const pipeline = await buildFedStatementDiffPipeline(current, previous);
  assert.ok(pipeline.aiInput);
  assert.equal(pipeline.aiSkippedReason, null);
  const interpretation = mockLunaInterpretation(pipeline.aiInput!);
  const row = buildFedStatementDiffRow(current, previous, pipeline.diff, interpretation, "2026-09-22T00:00:00.000Z");
  assert.equal(row.material_change_count, 1);
  assert.equal(row.model, "luna");
  assert.equal(row.deterministic_diff.addedParagraphs.length, 0);
  assert.equal(row.ai_interpretation?.overall_bias_change, "neutral");
  assert.equal(Object.hasOwn(row, "normalizedText"), false);
  assert.equal(Object.hasOwn(row.deterministic_diff, "normalizedText"), false);
});

test("AI usage contract is linked to the diff table with web search disabled", () => {
  const usage = buildFedStatementAiUsageEvent("00000000-0000-0000-0000-000000000099", 12, 8, 0.001);
  assert.deepEqual(usage, {
    feature: "mic_fed_statement_diff",
    model: "luna",
    inputTokens: 12,
    outputTokens: 8,
    webSearchCalls: 0,
    costUsd: 0.001,
    relatedTable: "mic_fed_statement_diffs",
    relatedId: "00000000-0000-0000-0000-000000000099",
  });
});

test("diff insert uses idempotent ignore-duplicates semantics", async () => {
  const pipeline = await buildFedStatementDiffPipeline(current, previous);
  const calls: Request[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push(new Request(input, init));
    return Promise.resolve(new Response("[]", { status: 201 }));
  }) as typeof fetch;
  const result = await persistFedStatementDiff({ supabaseUrl: "https://example.supabase.co", secretKey: "test" }, pipeline.row, fetchImpl);
  assert.equal(result.duplicate, true);
  assert.match(calls[0].headers.get("Prefer") ?? "", /resolution=ignore-duplicates/);
  assert.equal(calls[0].url.endsWith("/rest/v1/mic_fed_statement_diffs"), true);
});

test("pure diff used by persistence retains hashes and FK ids", async () => {
  const diff = await buildFedStatementDiff(previous, current);
  const row = buildFedStatementDiffRow(current, previous, diff);
  assert.equal(row.current_event_id, current.eventId);
  assert.equal(row.previous_event_id, previous.eventId);
  assert.equal(row.current_document_hash, current.documentHash);
  assert.match(row.diff_hash, /^[0-9a-f]{64}$/);
});
