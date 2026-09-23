import assert from "node:assert/strict";
import test from "node:test";
import { executeFedStatementAiAction, FED_STATEMENT_AI_CLAIM_TTL_MS } from "./mic_fed_statement_ai_action.ts";
import { computeFedStatementDiffHash, FED_STATEMENT_DIFF_PROMPT_VERSION, type FedStatementDeterministicDiff } from "./mic_fed_statement_diff.ts";
import { FED_STATEMENT_LUNA_MODEL, type FedStatementAiRequestResult } from "./mic_fed_statement_ai_logic.ts";
import type { FedStatementAiInput, FedStatementAiOutput } from "./mic_fed_statement_diff.ts";
import type { RestContext } from "./mic_writer_logic.ts";

const DIFF_ID = "00000000-0000-4000-8000-000000000001";
const JULY_ID = "00000000-0000-4000-8000-000000000002";
const SEPTEMBER_ID = "00000000-0000-4000-8000-000000000003";
const JULY_HASH = "b".repeat(64);
const SEPTEMBER_HASH = "c".repeat(64);
const context: RestContext = { supabaseUrl: "https://example.supabase.co", secretKey: "test-key" };
const policyDecisionChange = {
  previousDecision: "hold" as const,
  currentDecision: "hike" as const,
  previousRange: { lower: 3.5, upper: 3.75 },
  currentRange: { lower: 3.75, upper: 4 },
  lowerChangeBps: 25,
  upperChangeBps: 25,
  material: true,
};
const diffBase: Omit<FedStatementDeterministicDiff, "diffHash"> = {
  comparisonStatus: "compared",
  skipReason: null,
  unchangedParagraphs: [],
  addedParagraphs: [],
  removedParagraphs: [],
  modifiedParagraphs: [{ previous: "The Committee decided to maintain the target range.", current: "The Committee decided to raise the target range." }],
  changes: [{
    type: "modified",
    previous: "The Committee decided to maintain the target range.",
    current: "The Committee decided to raise the target range.",
    buckets: ["policy stance"],
    material: true,
  }],
  policyDecisionChange,
  buckets: ["policy stance"],
  material: true,
};
const DIFF_HASH = await computeFedStatementDiffHash(diffBase);

const validOutput: FedStatementAiOutput = {
  summary: "政策金利の誘導目標が25bp引き上げられました。",
  changes: [{
    bucket: "policy stance",
    direction: "more_hawkish",
    previous: "3.50–3.75%",
    current: "3.75–4.00%",
    interpretation: "目標レンジの引き上げを示します。",
    confidence: 0.9,
  }],
  overall_bias_change: "more_hawkish",
  confidence: 0.9,
};

function makeFixture() {
  const diff: Record<string, unknown> = {
    id: DIFF_ID,
    current_event_id: SEPTEMBER_ID,
    previous_event_id: JULY_ID,
    current_document_hash: SEPTEMBER_HASH,
    previous_document_hash: JULY_HASH,
    diff_hash: DIFF_HASH,
    meeting_date: "2026-09-16",
    previous_meeting_date: "2026-07-29",
    changed_paragraph_count: 1,
    material_change_count: 2,
    semantic_buckets: ["policy stance"],
    prompt_version: FED_STATEMENT_DIFF_PROMPT_VERSION,
    deterministic_diff: { ...diffBase, diffHash: DIFF_HASH },
    ai_interpretation: null,
    model: null,
    generated_at: null,
    updated_at: "2026-09-23T12:00:00.000Z",
  };
  const event = (id: string, date: string, hash: string, decision: string, url: string, lower: number, upper: number) => ({
    id,
    event_type: "central_bank_decision",
    source_key: "fed",
    source_name: "Federal Reserve",
    source_url: url,
    raw_payload: {
      central_bank: "Fed",
      source_key: "fed",
      meeting_date: date,
      decision,
      statement_url: url,
      document_hash: hash,
      rates: {
        FED_FUNDS_TARGET_LOWER: { new_rate: lower },
        FED_FUNDS_TARGET_UPPER: { new_rate: upper },
      },
    },
  });
  const events = new Map([
    [JULY_ID, event(JULY_ID, "2026-07-29", JULY_HASH, "hold", "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260729a.htm", 3.5, 3.75)],
    [SEPTEMBER_ID, event(SEPTEMBER_ID, "2026-09-16", SEPTEMBER_HASH, "hike", "https://www.federalreserve.gov/newsevents/pressreleases/monetary20260916a.htm", 3.75, 4)],
  ]);
  let aiCalls = 0;
  const aiInputs: FedStatementAiInput[] = [];
  const usageRows: Record<string, unknown>[] = [];
  let failResultSave = false;
  let failUsageInsert = false;
  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const table = url.pathname.split("/").at(-1);
    if (method === "GET" && table === "mic_fed_statement_diffs") return Promise.resolve(new Response(JSON.stringify([diff])));
    if (method === "GET" && table === "market_events") {
      const id = url.searchParams.get("id")?.replace(/^eq\./, "");
      return Promise.resolve(new Response(JSON.stringify(id && events.has(id) ? [events.get(id)] : [])));
    }
    if (method === "PATCH" && table === "mic_fed_statement_diffs") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const filterModel = url.searchParams.get("model");
      if ((filterModel === "is.null" && diff.model !== null) ||
        (filterModel?.startsWith("eq.") && filterModel.slice(3) !== diff.model) ||
        (diff.ai_interpretation !== null || diff.generated_at !== null)) {
        return Promise.resolve(new Response("[]"));
      }
      if (Object.hasOwn(body, "ai_interpretation")) {
        if (failResultSave) return Promise.resolve(new Response("save failed", { status: 500 }));
        const modelMatch = filterModel?.replace(/^eq\./, "");
        if (modelMatch !== diff.model) return Promise.resolve(new Response("[]"));
        diff.ai_interpretation = body.ai_interpretation;
        diff.model = body.model;
        diff.prompt_version = body.prompt_version;
        diff.generated_at = body.generated_at;
        return Promise.resolve(new Response(JSON.stringify([{ id: DIFF_ID }])));
      }
      if (filterModel === "is.null" || filterModel?.startsWith("eq.")) {
        diff.model = body.model;
        return Promise.resolve(new Response(JSON.stringify([{ id: DIFF_ID }])));
      }
      return Promise.resolve(new Response("[]"));
    }
    if (method === "POST" && table === "ai_usage_events") {
      if (failUsageInsert) return Promise.resolve(new Response("usage failed", { status: 503 }));
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      usageRows.push(body);
      return Promise.resolve(new Response(JSON.stringify([{ id: 51 }])));
    }
    return Promise.resolve(new Response("unexpected request", { status: 500 }));
  }) as typeof fetch;
  const requestAi = (input: FedStatementAiInput): Promise<FedStatementAiRequestResult> => {
    aiCalls += 1;
    aiInputs.push(input);
    return Promise.resolve({ output: validOutput, model: FED_STATEMENT_LUNA_MODEL, inputTokens: 310, outputTokens: 55, costUsd: 0.0000585 });
  };
  return {
    diff,
    events,
    usageRows,
    fetchImpl,
    requestAi,
    aiInputs,
    aiCalls: () => aiCalls,
    failResultSave: (value: boolean) => failResultSave = value,
    failUsageInsert: (value: boolean) => failUsageInsert = value,
  };
}

function execute(fixture: ReturnType<typeof makeFixture>) {
  return executeFedStatementAiAction(context, DIFF_ID, "test-openai-key", {
    fetchImpl: fixture.fetchImpl,
    requestAi: fixture.requestAi,
    now: () => new Date("2026-09-23T12:00:00.000Z"),
  });
}

test("Fed ingest persists material diff without any model execution", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const ingestBody = source.slice(source.indexOf("async function runSource("), source.indexOf("Deno.serve("));
  assert.match(ingestBody, /persistFedStatementDiff/);
  assert.doesNotMatch(ingestBody, /requestFedStatementInterpretation|executeFedStatementAiAction|persistFedStatementAiUsage/);
});

test("explicit action interprets an exact material diff and writes linked usage", async () => {
  const fixture = makeFixture();
  const result = await execute(fixture);
  assert.equal(result.status, "interpreted");
  assert.equal(fixture.aiCalls(), 1);
  assert.deepEqual(fixture.diff.ai_interpretation, validOutput);
  assert.equal(fixture.diff.model, FED_STATEMENT_LUNA_MODEL);
  assert.equal(fixture.diff.generated_at, "2026-09-23T12:00:00.000Z");
  assert.equal(fixture.usageRows.length, 1);
  assert.equal(fixture.usageRows[0].feature, "mic_fed_statement_diff");
  assert.equal(fixture.usageRows[0].related_table, "mic_fed_statement_diffs");
  assert.equal(fixture.usageRows[0].related_id, DIFF_ID);
  assert.equal(fixture.usageRows[0].web_search_calls, 0);
  assert.deepEqual(fixture.aiInputs[0].semanticBuckets, ["policy stance"]);
  assert.equal(fixture.aiInputs[0].changes.length, 1);
  assert.equal(Object.hasOwn(fixture.aiInputs[0], "normalizedText"), false);
});

test("non-material diff is rejected without model execution", async () => {
  const fixture = makeFixture();
  fixture.diff.material_change_count = 0;
  await assert.rejects(() => execute(fixture), /FED_AI_MATERIAL_DIFF_REQUIRED/);
  assert.equal(fixture.aiCalls(), 0);
  assert.equal(fixture.usageRows.length, 0);
});

test("missing previous event is rejected without model execution", async () => {
  const fixture = makeFixture();
  fixture.diff.previous_event_id = null;
  await assert.rejects(() => execute(fixture), /FED_AI_PREVIOUS_EVENT_REQUIRED/);
  assert.equal(fixture.aiCalls(), 0);
});

test("baseline-only row is rejected without model execution", async () => {
  const fixture = makeFixture();
  (fixture.diff.deterministic_diff as Record<string, unknown>).comparisonStatus = "baseline_only";
  await assert.rejects(() => execute(fixture), /FED_AI_MATERIAL_DIFF_REQUIRED/);
  assert.equal(fixture.aiCalls(), 0);
});

test("already interpreted diff returns without another model call", async () => {
  const fixture = makeFixture();
  fixture.diff.ai_interpretation = validOutput;
  fixture.diff.model = FED_STATEMENT_LUNA_MODEL;
  fixture.diff.generated_at = "2026-09-23T11:00:00.000Z";
  const result = await execute(fixture);
  assert.equal(result.status, "already_interpreted");
  assert.equal(fixture.aiCalls(), 0);
  assert.equal(fixture.usageRows.length, 0);
});

test("completed interpretation wins over an old claim marker", async () => {
  const fixture = makeFixture();
  fixture.diff.ai_interpretation = validOutput;
  fixture.diff.model = `fed-ai-claim:${Date.now() - FED_STATEMENT_AI_CLAIM_TTL_MS * 2}:00000000-0000-4000-8000-000000000009`;
  fixture.diff.generated_at = "2026-09-23T11:00:00.000Z";
  const result = await execute(fixture);
  assert.equal(result.status, "already_interpreted");
  assert.equal(fixture.aiCalls(), 0);
});

test("fresh claim is not reclaimed", async () => {
  const fixture = makeFixture();
  fixture.diff.model = `fed-ai-claim:${Date.parse("2026-09-23T11:59:59.999Z")}:00000000-0000-4000-8000-000000000009`;
  const result = await execute(fixture);
  assert.equal(result.status, "in_progress");
  assert.equal(fixture.aiCalls(), 0);
});

test("stale claim is atomically reclaimed", async () => {
  const fixture = makeFixture();
  fixture.diff.model = `fed-ai-claim:${Date.parse("2026-09-23T11:40:00.000Z")}:00000000-0000-4000-8000-000000000009`;
  const result = await execute(fixture);
  assert.equal(result.status, "interpreted");
  assert.equal(fixture.aiCalls(), 1);
  assert.equal(fixture.usageRows.length, 1);
  assert.match(String(fixture.diff.model), /^gpt-6-luna$/);
});

test("legacy claim without embedded time uses existing updated_at", async () => {
  const fixture = makeFixture();
  fixture.diff.model = "fed-ai-claim:legacy-worker-id";
  fixture.diff.updated_at = "2026-09-23T11:40:00.000Z";
  const result = await execute(fixture);
  assert.equal(result.status, "interpreted");
  assert.equal(fixture.aiCalls(), 1);
});

test("simultaneous stale-claim recovery has exactly one winner", async () => {
  const fixture = makeFixture();
  fixture.diff.model = `fed-ai-claim:${Date.parse("2026-09-23T11:40:00.000Z")}:00000000-0000-4000-8000-000000000009`;
  const results = await Promise.all([execute(fixture), execute(fixture)]);
  assert.equal(fixture.aiCalls(), 1);
  assert.equal(fixture.usageRows.length, 1);
  assert.equal(results.filter((result) => result.status === "interpreted").length, 1);
  assert.ok(results.some((result) => result.status === "in_progress" || result.status === "already_interpreted"));
});

test("two concurrent actions acquire only one atomic claim", async () => {
  const fixture = makeFixture();
  const results = await Promise.all([execute(fixture), execute(fixture)]);
  assert.equal(fixture.aiCalls(), 1);
  assert.equal(fixture.usageRows.length, 1);
  assert.equal(results.filter((result) => result.status === "interpreted").length, 1);
  assert.ok(results.some((result) => result.status === "in_progress" || result.status === "already_interpreted"));
});

test("invalid AI output is not saved and does not create usage", async () => {
  const fixture = makeFixture();
  fixture.requestAi = () => Promise.resolve({
    output: { ...validOutput, overall_bias_change: "unsafe" } as unknown as typeof validOutput,
    model: FED_STATEMENT_LUNA_MODEL,
    inputTokens: 1,
    outputTokens: 1,
    costUsd: 0,
  });
  await assert.rejects(() => execute(fixture), /FED_AI_OUTPUT_INVALID/);
  assert.equal(fixture.aiCalls(), 0);
  assert.equal(fixture.diff.ai_interpretation, null);
  assert.equal(fixture.diff.generated_at, null);
  assert.match(String(fixture.diff.model), /^fed-ai-claim:/);
  assert.equal(fixture.usageRows.length, 0);
});

test("transport failure retains claim to prevent immediate duplicate call", async () => {
  const fixture = makeFixture();
  const requestAi = fixture.requestAi;
  fixture.requestAi = (input) => {
    requestAi(input);
    return Promise.reject(new Error("transport failure"));
  };
  await assert.rejects(() => execute(fixture), /FED_AI_EXECUTION_FAILED/);
  assert.match(String(fixture.diff.model), /^fed-ai-claim:/);
  assert.equal(fixture.aiCalls(), 1);
  const second = await execute(fixture);
  assert.equal(second.status, "in_progress");
  assert.equal(fixture.aiCalls(), 1);
});

test("timeout retains claim to prevent immediate duplicate call", async () => {
  const fixture = makeFixture();
  const requestAi = fixture.requestAi;
  fixture.requestAi = (input) => {
    requestAi(input);
    return Promise.reject(new DOMException("request timed out", "TimeoutError"));
  };
  await assert.rejects(() => execute(fixture), /FED_AI_EXECUTION_FAILED/);
  assert.match(String(fixture.diff.model), /^fed-ai-claim:/);
  const second = await execute(fixture);
  assert.equal(second.status, "in_progress");
  assert.equal(fixture.aiCalls(), 1);
});

test("interpretation persistence failure does not immediately free the claim", async () => {
  const fixture = makeFixture();
  fixture.failResultSave(true);
  await assert.rejects(() => execute(fixture), /FED_AI_EXECUTION_FAILED/);
  assert.equal(fixture.diff.ai_interpretation, null);
  assert.match(String(fixture.diff.model), /^fed-ai-claim:/);
  assert.equal(fixture.usageRows.length, 0);
});

test("usage ledger failure does not cause another AI call", async () => {
  const fixture = makeFixture();
  fixture.failUsageInsert(true);
  await assert.rejects(() => execute(fixture), /FED_AI_EXECUTION_FAILED/);
  assert.deepEqual(fixture.diff.ai_interpretation, validOutput);
  assert.equal(fixture.diff.model, FED_STATEMENT_LUNA_MODEL);
  const result = await execute(fixture);
  assert.equal(result.status, "already_interpreted");
  assert.equal(fixture.aiCalls(), 1);
  assert.equal(fixture.usageRows.length, 0);
});

test("tampered deterministic hash is rejected without model execution", async () => {
  const fixture = makeFixture();
  (fixture.diff.deterministic_diff as Record<string, unknown>).diffHash = "d".repeat(64);
  await assert.rejects(() => execute(fixture), /FED_AI_DIFF_HASH_INVALID/);
  assert.equal(fixture.aiCalls(), 0);
});

test("foreign event URL is rejected without model execution", async () => {
  const fixture = makeFixture();
  const previous = fixture.events.get(JULY_ID)!;
  previous.source_url = "https://example.com/monetary20260729a.htm";
  await assert.rejects(() => execute(fixture), /FED_AI_EVENT_INVALID/);
  assert.equal(fixture.aiCalls(), 0);
});

test("legacy/malformed claim marker fails closed", async () => {
  const fixture = makeFixture();
  fixture.diff.model = "fed-ai-claim:someone-else";
  const result = await execute(fixture);
  assert.equal(result.status, "in_progress");
  assert.equal(fixture.aiCalls(), 0);
  assert.equal(fixture.usageRows.length, 0);
  assert.equal(FED_STATEMENT_DIFF_PROMPT_VERSION, fixture.diff.prompt_version);
});
