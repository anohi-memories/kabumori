import assert from "node:assert/strict";
import test from "node:test";
import { buildFedStatementDiff } from "./mic_fed_statement_diff.ts";
import {
  buildFedStatementAiUsageEvent,
  buildFedStatementDiffPipeline,
  buildFedStatementDiffRow,
  hasFedStatementAiInterpretation,
  mockLunaInterpretation,
  persistFedStatementAiInterpretation,
  persistFedStatementDiff,
} from "./mic_fed_statement_diff_persistence.ts";
import { FED_STATEMENT_LUNA_MODEL } from "./mic_fed_statement_ai_logic.ts";
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
  assert.equal(pipeline.row.changed_paragraph_count, 0);
  assert.equal(pipeline.row.material_change_count, 0);
  assert.deepEqual(pipeline.row.semantic_buckets, []);
  assert.equal(pipeline.row.deterministic_diff.comparisonStatus, "baseline_only");
  assert.equal(pipeline.row.deterministic_diff.skipReason, "first_statement_no_baseline");
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
  const row = buildFedStatementDiffRow(current, previous, pipeline.diff);
  assert.equal(row.material_change_count, 1);
  assert.equal(row.model, null);
  assert.equal(row.deterministic_diff.addedParagraphs.length, 0);
  assert.equal(row.ai_interpretation, null);
  assert.equal(row.ai_usage_receipt, null);
  assert.equal(Object.hasOwn(row, "normalizedText"), false);
  assert.equal(Object.hasOwn(row.deterministic_diff, "normalizedText"), false);
});

test("AI usage contract is linked to the diff table with web search disabled", () => {
  const usage = buildFedStatementAiUsageEvent("00000000-0000-0000-0000-000000000099", 12, 8, 0.001);
  assert.deepEqual(usage, {
    feature: "mic_fed_statement_diff",
    model: FED_STATEMENT_LUNA_MODEL,
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
    if (!init?.method) return Promise.resolve(new Response("[]", { status: 200 }));
    return Promise.resolve(new Response('[{"id":"00000000-0000-0000-0000-000000000099"}]', { status: 201 }));
  }) as typeof fetch;
  const result = await persistFedStatementDiff({ supabaseUrl: "https://example.supabase.co", secretKey: "test" }, pipeline.row, fetchImpl);
  assert.equal(result.outcome, "inserted");
  assert.equal(calls.length, 2);
  assert.match(calls[1].headers.get("Prefer") ?? "", /resolution=ignore-duplicates/);
  assert.equal(calls[1].url.endsWith("/rest/v1/mic_fed_statement_diffs"), true);
});

test("formal comparison replaces the single baseline row in place", async () => {
  const pipeline = await buildFedStatementDiffPipeline(current, previous);
  const calls: Request[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push(new Request(input, init));
    if (!init?.method) {
      return Promise.resolve(new Response('[{"id":"00000000-0000-0000-0000-000000000099","previous_event_id":null,"diff_hash":"baseline","prompt_version":"fed-statement-diff-v2","ai_interpretation":null,"ai_usage_receipt":null}]'));
    }
    return Promise.resolve(new Response('[{"id":"00000000-0000-0000-0000-000000000099"}]'));
  }) as typeof fetch;
  const result = await persistFedStatementDiff({ supabaseUrl: "https://example.supabase.co", secretKey: "test" }, pipeline.row, fetchImpl);
  assert.equal(result.outcome, "replaced_baseline");
  assert.equal(calls[1].method, "PATCH");
  assert.match(calls[1].url, /id=eq\.00000000-0000-0000-0000-000000000099/);
  assert.match(calls[1].url, /ai_interpretation=is\.null/);
  assert.match(calls[1].url, /ai_usage_receipt=is\.null/);
  assert.equal((await calls[1].json()).previous_event_id, previous.eventId);
});

test("same current event never creates a second active diff row", async () => {
  const pipeline = await buildFedStatementDiffPipeline(current, previous);
  const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.method, undefined);
    return Promise.resolve(new Response(JSON.stringify([{
      id: "00000000-0000-0000-0000-000000000099",
      previous_event_id: previous.eventId,
      diff_hash: pipeline.row.diff_hash,
      prompt_version: pipeline.row.prompt_version,
    }])));
  }) as typeof fetch;
  const result = await persistFedStatementDiff({ supabaseUrl: "https://example.supabase.co", secretKey: "test" }, pipeline.row, fetchImpl);
  assert.equal(result.outcome, "duplicate");
});

test("diff persistence recomputes when the prompt version changes", async () => {
  const pipeline = await buildFedStatementDiffPipeline(current, previous);
  const calls: Request[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push(new Request(input, init));
    if (!init?.method) return Promise.resolve(new Response(JSON.stringify([{
      id: "00000000-0000-0000-0000-000000000099",
      previous_event_id: previous.eventId,
      diff_hash: pipeline.row.diff_hash,
      prompt_version: "old-version",
    }])));
    return Promise.resolve(new Response('[{"id":"00000000-0000-0000-0000-000000000099"}]'));
  }) as typeof fetch;
  const result = await persistFedStatementDiff({ supabaseUrl: "https://example.supabase.co", secretKey: "test" }, pipeline.row, fetchImpl);
  assert.equal(result.outcome, "recomputed");
  assert.equal(calls[1].method, "PATCH");
});

test("diff recompute fails if an AI receipt was saved after lookup", async () => {
  const pipeline = await buildFedStatementDiffPipeline(current, previous);
  const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) => {
    if (!init?.method) return Promise.resolve(new Response(JSON.stringify([{
      id: "00000000-0000-0000-0000-000000000099",
      previous_event_id: previous.eventId,
      diff_hash: "old-hash",
      prompt_version: pipeline.row.prompt_version,
      ai_interpretation: null,
      ai_usage_receipt: null,
    }])));
    return Promise.resolve(new Response("[]"));
  }) as typeof fetch;
  await assert.rejects(
    () => persistFedStatementDiff({ supabaseUrl: "https://example.supabase.co", secretKey: "test" }, pipeline.row, fetchImpl),
    /FED_STATEMENT_DIFF_CONCURRENT_UPDATE/,
  );
});

test("AI interpretation state is exact to diff hash and prompt version", async () => {
  const calls: Request[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push(new Request(input, init));
    return Promise.resolve(new Response(JSON.stringify([{
      id: "00000000-0000-0000-0000-000000000099",
      diff_hash: "diff-hash",
      prompt_version: "prompt-v2",
      ai_interpretation: { summary: "saved" },
    }])));
  }) as typeof fetch;
  const has = await hasFedStatementAiInterpretation(
    { supabaseUrl: "https://example.supabase.co", secretKey: "test" },
    "00000000-0000-0000-0000-000000000099",
    "diff-hash",
    "prompt-v2",
    fetchImpl,
  );
  assert.equal(has, true);
  assert.match(calls[0].url, /diff_hash,prompt_version,ai_interpretation/);
});

test("AI result patches only the exact empty formal diff row", async () => {
  const pipeline = await buildFedStatementDiffPipeline(current, previous);
  const calls: Request[] = [];
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push(new Request(input, init));
    return Promise.resolve(new Response('[{"id":"00000000-0000-0000-0000-000000000099"}]'));
  }) as typeof fetch;
  const saved = await persistFedStatementAiInterpretation(
    { supabaseUrl: "https://example.supabase.co", secretKey: "test" },
    {
      diffId: "00000000-0000-0000-0000-000000000099",
      diffHash: pipeline.row.diff_hash,
      promptVersion: pipeline.row.prompt_version,
      claimMarker: "fed-ai-claim:test-token",
      interpretation: mockLunaInterpretation(pipeline.aiInput!),
      generatedAt: "2026-09-23T00:00:00.000Z",
      inputTokens: 321,
      outputTokens: 45,
      costUsd: 0.0000546,
    },
    fetchImpl,
  );
  assert.equal(saved, true);
  assert.equal(calls[0].method, "PATCH");
  assert.match(calls[0].url, /ai_interpretation=is\.null/);
  assert.match(calls[0].url, /model=eq\.fed-ai-claim/);
  const body = await calls[0].json();
  assert.equal(body.model, FED_STATEMENT_LUNA_MODEL);
  assert.equal(body.ai_usage_receipt.input_tokens, 321);
  assert.equal(body.ai_usage_receipt.output_tokens, 45);
  assert.equal(body.ai_usage_receipt.cost_usd, 0.0000546);
  assert.equal(body.ai_usage_receipt.diff_hash, pipeline.row.diff_hash);
  assert.equal(body.ai_usage_receipt.prompt_version, pipeline.row.prompt_version);
  assert.equal(body.ai_usage_recorded_at, null);
});

test("diff recompute cannot discard a pending durable AI usage receipt", async () => {
  const pipeline = await buildFedStatementDiffPipeline(current, previous);
  let patchCalls = 0;
  const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "PATCH") patchCalls += 1;
    return Promise.resolve(new Response(JSON.stringify([{
      id: "00000000-0000-0000-0000-000000000099",
      previous_event_id: previous.eventId,
      diff_hash: "old-hash",
      prompt_version: pipeline.row.prompt_version,
      ai_interpretation: { summary: "saved" },
      ai_usage_receipt: { input_tokens: 321 },
      ai_usage_recorded_at: null,
    }])));
  }) as typeof fetch;
  await assert.rejects(
    () => persistFedStatementDiff({ supabaseUrl: "https://example.supabase.co", secretKey: "test" }, pipeline.row, fetchImpl),
    /FED_STATEMENT_DIFF_PENDING_AI_USAGE/,
  );
  assert.equal(patchCalls, 0);
});

test("multiple active rows for one current event fail closed", async () => {
  const pipeline = await buildFedStatementDiffPipeline(current, previous);
  const fetchImpl = (() => Promise.resolve(new Response('[{"id":"1"},{"id":"2"}]'))) as typeof fetch;
  await assert.rejects(
    () => persistFedStatementDiff({ supabaseUrl: "https://example.supabase.co", secretKey: "test" }, pipeline.row, fetchImpl),
    /FED_STATEMENT_DIFF_MULTIPLE_ACTIVE_ROWS/,
  );
});

test("pure diff used by persistence retains hashes and FK ids", async () => {
  const diff = await buildFedStatementDiff(previous, current);
  const row = buildFedStatementDiffRow(current, previous, diff);
  assert.equal(row.current_event_id, current.eventId);
  assert.equal(row.previous_event_id, previous.eventId);
  assert.equal(row.current_document_hash, current.documentHash);
  assert.match(row.diff_hash, /^[0-9a-f]{64}$/);
});
