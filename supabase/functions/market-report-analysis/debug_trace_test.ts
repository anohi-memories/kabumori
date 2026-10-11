// Test-phase debug traces (2026-10-07 morning: two failed analysis attempts left only fixed codes, because the
// generated bodies, the first generation's local findings and the 07:55 attempt were overwritten).
// Pins: every generation is kept whole and separately; a scheduled retry does not erase the first attempt; the
// serializer keeps content and drops credentials; a failed write never blocks, retries or costs a model call;
// and the prompt no longer hands the model a timing claim to copy. PR #99's behaviour and the Hard checks are
// asserted unchanged.
import assert from "node:assert/strict";
import test from "node:test";
import { type Deps, handleRequest } from "./handler.ts";
import { ANALYSIS_MODEL } from "./analysis_logic.ts";
import { buildAnalysisInput } from "./analysis_input.ts";
import {
  type GenerationRecord,
  generateSharedAnalysis,
  generationRequestBody,
  MAX_GENERATIONS,
  pointsEditorialWarnings,
  qualityRewriteHints,
  type Requester,
  X_POST_REWRITE_BELOW_CHARS,
} from "./analysis_logic.ts";
import {
  containsSecret,
  persistTraces,
  promptHash,
  redactValue,
  REDACTED,
  TRACE_TABLE,
  type TraceRow,
  traceRows,
} from "./debug_trace.ts";
import { loadFixture, inputOf, rich0917 } from "./test_support.ts";

const directory = new URL("./fixtures/", import.meta.url);
const dataFixture = JSON.parse(await Deno.readTextFile(new URL("close_2026-09-17_data_packet.json", directory)));
const newsRows = JSON.parse(await Deno.readTextFile(new URL("close_2026-09-17_news_rows.json", directory)));
const SUPABASE = "https://project-ref.supabase.co";
const SECRET = "cron-secret-for-tests";
const CYCLE = "11111111-1111-4111-8111-111111111111";
const PACKET = "33333333-3333-4333-8333-333333333333";
const analysisInput = () =>
  buildAnalysisInput({ dataPacket: dataFixture.payload, dataPacketId: dataFixture.id, dataContentHash: dataFixture.content_hash, newsRows });
const good = () => rich0917(analysisInput());
const bad = () => {
  const analysis = good();
  analysis.headline_ja = "日経平均とTOPIXがそろって上昇";
  return analysis;
};
const PASSED = { passed: true, issues: [] };

type Call = { url: string; method: string; body: unknown };

/** The handler with a scripted model: `generations` and `facts` are consumed in order. */
function harness(options: {
  attempt?: number;
  generations?: unknown[];
  facts?: Array<{ passed: boolean; issues: string[] }>;
  traceStatus?: number;
  traceThrows?: boolean;
} = {}) {
  const calls: Call[] = [];
  const traceRowsWritten: TraceRow[] = [];
  const generations = [...(options.generations ?? [good()])];
  const facts = [...(options.facts ?? [PASSED])];
  const fetchMock: typeof fetch = (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ url, method: init?.method ?? "GET", body });
    const json = (value: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(value), { status }));
    if (url === "https://api.openai.com/v1/responses") {
      const isFact = String(body?.instructions).includes("Factチェッカー");
      const payload = isFact ? facts.shift() ?? PASSED : generations.shift() ?? good();
      return json({ output: [{ content: [{ type: "output_text", text: JSON.stringify(payload) }] }], usage: { input_tokens: 900, output_tokens: 300 } });
    }
    const path = url.slice(`${SUPABASE}/rest/v1/`.length);
    if (path === TRACE_TABLE) {
      if (options.traceThrows) return Promise.reject(new Error("NETWORK_DOWN"));
      if ((options.traceStatus ?? 201) >= 400) return json({ message: "relation does not exist" }, options.traceStatus);
      traceRowsWritten.push(...(body as TraceRow[]));
      return Promise.resolve(new Response(null, { status: 201 }));
    }
    if (path.startsWith("market_holidays")) return json([{ holiday_date: "2026-09-21" }]);
    if (path === "rpc/claim_market_report_analysis") {
      return json([{ cycle_id: CYCLE, claim_token: "22222222-2222-4222-8222-222222222222", attempt: options.attempt ?? 1, outcome: "claimed", data_packet_id: dataFixture.id }]);
    }
    if (path.startsWith("market_data_packets")) return json([{ id: dataFixture.id, content_hash: dataFixture.content_hash, payload: dataFixture.payload, data_quality_status: "partial" }]);
    if (path.startsWith("important_news_candidates")) return json(newsRows);
    if (path === "rpc/complete_market_report_analysis") return json(PACKET);
    if (path === "rpc/fail_market_report_analysis") return json("failed");
    return Promise.reject(new Error(`UNEXPECTED_PATH:${path}`));
  };
  const deps: Deps = {
    env: (name) => ({
      SUPABASE_URL: SUPABASE, SUPABASE_SECRET_KEYS: JSON.stringify({ default: "service-secret" }),
      SEND_PUSH_NOTIFICATIONS_CRON_SECRET: SECRET, OPENAI_API_KEY: "openai-test-key",
    } as Record<string, string>)[name],
    fetch: fetchMock,
    now: () => new Date("2026-09-17T07:20:00Z"),
  };
  return { calls, deps, traceRowsWritten };
}
const request = () =>
  new Request("https://functions.local/market-report-analysis", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Cron-Secret": SECRET }, body: JSON.stringify({ mode: "close" }),
  });
const openAiCalls = (calls: Call[]) => calls.filter((call) => call.url === "https://api.openai.com/v1/responses").length;

function scripted(steps: Array<{ step: "generate" | "fact"; payload?: unknown; fail?: boolean }>): Requester {
  return (step) => {
    const next = steps.shift();
    assert.ok(next, `unexpected ${step} call`);
    assert.equal(next.step, step);
    if (next.fail) return Promise.reject(new Error("ANALYSIS_OPENAI_GENERATE_FAILED:503"));
    return Promise.resolve({ payload: next.payload, inputTokens: 1000, outputTokens: 400 });
  };
}
const now = () => new Date("2026-09-17T07:20:30Z");

test("1. generation 1 local reject: its candidate and the local findings stay after generation 2 ran", async () => {
  const sink: GenerationRecord[] = [];
  const outcome = await generateSharedAnalysis(
    analysisInput(),
    scripted([{ step: "generate", payload: bad() }, { step: "generate", payload: good() }, { step: "fact", payload: PASSED }]),
    now, sink,
  );
  assert.equal(outcome.ok, true);
  assert.equal(sink.length, 2);
  const [first, second] = sink;
  assert.deepEqual([first.generationIndex, first.stage, first.hardRejection, first.localPassed, first.selectedForDelivery], [1, "local", "local", false, false]);
  assert.equal((first.candidate as { headline_ja: string }).headline_ja, "日経平均とTOPIXがそろって上昇", "the model's own words are kept");
  assert.ok(first.localIssues.some((issue) => issue.includes("TOPIX")), first.localIssues.join("\n"));
  assert.equal(first.factRan, false);
  assert.deepEqual([second.generationIndex, second.stage, second.selectedForDelivery, second.localPassed, second.factPassed], [2, "delivered", true, true, true]);
  assert.equal(outcome.ok && outcome.trace.records, sink, "the outcome carries the same records");
});

test("2. generation 2 Fact reject: the candidate and the Fact issues are kept; the safe original is still delivered", async () => {
  const sink: GenerationRecord[] = [];
  const thin = good();
  thin.app_story = { ...thin.app_story!, japan_ja: "短い。", news_ja: "短い。" }; // safe, but thin enough to ask for one rewrite
  const timing = "「前回の引け以降に確認できたニュース」とする時間関係は入力で確認できません。";
  const outcome = await generateSharedAnalysis(
    analysisInput(),
    scripted([
      { step: "generate", payload: thin }, { step: "fact", payload: PASSED },
      { step: "generate", payload: good() }, { step: "fact", payload: { passed: false, issues: [timing] } },
    ]),
    now, sink,
  );
  assert.equal(outcome.ok, true);
  assert.equal(sink.length, 2);
  assert.deepEqual([sink[0].stage, sink[0].selectedForDelivery, sink[0].fallbackReason], ["delivered", true, "rewrite_rejected_fact"]);
  assert.deepEqual([sink[1].stage, sink[1].hardRejection, sink[1].factPassed, sink[1].selectedForDelivery], ["fact", "fact", false, false]);
  assert.deepEqual(sink[1].factIssues, [timing]);
  assert.equal((sink[1].candidate as { headline_ja: string }).headline_ja, good().headline_ja, "the rejected rewrite body is kept");
  assert.equal(outcome.ok && outcome.trace.deliveredGeneration, 1);
});

test("2b. both generations rejected (the 10/7 shape): both bodies and findings are readable, the better one is delivered", async () => {
  const sink: GenerationRecord[] = [];
  const outcome = await generateSharedAnalysis(
    analysisInput(),
    scripted([
      { step: "generate", payload: bad() },
      { step: "generate", payload: good() }, { step: "fact", payload: { passed: false, issues: ["本文に入力に無い時間関係がある"] } },
      // Generation 1 (wrong headline removed) had no verdict: it gets the one remaining Fact call.
      { step: "fact", payload: { passed: false, issues: ["見出しが一般的"] } },
    ]),
    now, sink,
  );
  // Delivery first (2026-10-07): both have advisory Fact findings; generation 2 needed no removal, so it is delivered.
  assert.equal(outcome.ok, true);
  assert.equal(outcome.ok && outcome.packet.fact.ai_status, "advisory");
  assert.deepEqual(sink.map((record) => [record.generationIndex, record.stage, record.hardRejection]), [[1, "local", "local"], [2, "delivered", "fact"]]);
  assert.ok(sink[0].localIssues.length > 0 && sink[0].candidate && sink[1].candidate);
  assert.deepEqual(sink[1].factIssues, ["本文に入力に無い時間関係がある"]);
  assert.deepEqual(sink[0].factIssues, ["見出しが一般的"]);
  assert.ok(sink[0].localWarnings.some((warning) => warning.startsWith("UNIT_REMOVED:TOPIX_MISLABEL@headline_ja")), sink[0].localWarnings.join("\n"));
  assert.deepEqual(sink.map((record) => record.selectedForDelivery), [false, true]);
  assert.equal(sink[1].fallbackReason, "fact_advisory");
  // Cumulative accounting: generation 1's record is settled again by its own (last) Fact call.
  assert.deepEqual(sink.map((record) => record.calls), [4, 3]);
});

test("3. two scheduled attempts of one cycle stay distinguishable: the retry does not erase the first", async () => {
  const written: TraceRow[] = [];
  for (const attempt of [1, 2]) {
    // Unparsable output twice: nothing coherent is left, the attempt fails (the only way a cycle is retried now).
    const { deps, traceRowsWritten } = harness({ attempt, generations: [{ broken: `attempt ${attempt} g1` }, { broken: `attempt ${attempt} g2` }] });
    const response = await handleRequest(request(), deps);
    assert.equal(((await response.json()) as { status: string }).status, "failed");
    written.push(...traceRowsWritten);
  }
  assert.equal(written.length, 4);
  const [a1g1, a1g2, a2g1, a2g2] = written;
  assert.deepEqual([a1g1.attempt, a1g1.generation_index, a1g2.attempt, a1g2.generation_index], [1, 1, 1, 2]);
  assert.deepEqual([a2g1.attempt, a2g1.generation_index, a2g2.attempt, a2g2.generation_index], [2, 1, 2, 2]);
  assert.notEqual(a1g1.invocation_id, a2g1.invocation_id, "each invocation has its own identity");
  assert.equal(a1g1.invocation_id, a1g2.invocation_id);
  assert.ok(written.every((row) => row.cycle_id === CYCLE && row.data_packet_id === dataFixture.id && row.report_packet_id === null));
  assert.deepEqual(a1g2.candidate, { broken: "attempt 1 g2" });
  assert.deepEqual(a2g2.candidate, { broken: "attempt 2 g2" });
});

test("4. a successful run records its trace: selected for delivery, linked to the stored packet", async () => {
  const { deps, traceRowsWritten, calls } = harness();
  const response = await handleRequest(request(), deps);
  assert.equal(response.status, 200);
  assert.equal(traceRowsWritten.length, 1);
  const [row] = traceRowsWritten;
  assert.deepEqual([row.stage, row.selected_for_delivery, row.report_packet_id, row.local_passed, row.fact_ran, row.fact_passed], ["delivered", true, PACKET, true, true, true]);
  assert.deepEqual([row.source, row.report_type, row.trading_date, row.subject_ref, row.model], ["shared_market_report", "close", "2026-09-17", null, ANALYSIS_MODEL]);
  assert.match(String(row.base_prompt_hash), /^[0-9a-f]{16}$/);
  assert.match(String(row.request_hash), /^[0-9a-f]{16}$/);
  assert.equal(openAiCalls(calls), 2);
  // The row is written after the packet is stored, never before.
  const urls = calls.map((call) => call.url.slice(`${SUPABASE}/rest/v1/`.length));
  assert.ok(urls.indexOf("rpc/complete_market_report_analysis") < urls.indexOf(TRACE_TABLE));
});

test("5/6. a failed trace write never fails or retries the report and never costs a model call", async () => {
  const reference = harness();
  assert.equal((await handleRequest(request(), reference.deps)).status, 200);
  for (const failure of [{ traceStatus: 404 }, { traceStatus: 500 }, { traceThrows: true }]) {
    const logged: string[] = [];
    const original = console.error;
    console.error = (message?: unknown) => { logged.push(String(message)); };
    try {
      const { deps, calls } = harness(failure);
      const response = await handleRequest(request(), deps);
      assert.equal(response.status, 200, JSON.stringify(failure));
      assert.equal(((await response.json()) as { status: string }).status, "completed");
      assert.equal(openAiCalls(calls), openAiCalls(reference.calls), "no extra model call");
      assert.equal(calls.filter((call) => call.url.endsWith(TRACE_TABLE)).length, 1, "written once, never retried");
      assert.equal(calls.filter((call) => call.url.endsWith("rpc/complete_market_report_analysis")).length, 1);
      assert.ok(logged.some((line) => line.startsWith("GENERATION_TRACE_WRITE_FAILED")), logged.join("|"));
    } finally {
      console.error = original;
    }
  }
});

test("5b. the same holds when the run itself failed: the failure is recorded, the trace error does not replace it", async () => {
  const { deps, calls } = harness({ generations: [{ broken: 1 }, { broken: 2 }], traceStatus: 500 });
  const original = console.error;
  console.error = () => {};
  try {
    const response = await handleRequest(request(), deps);
    const body = await response.json() as { status: string; error: string };
    assert.deepEqual([body.status, body.error], ["failed", "ANALYSIS_INVALID_OUTPUT"]);
    assert.equal(calls.filter((call) => call.url.endsWith("rpc/fail_market_report_analysis")).length, 1);
    assert.equal(openAiCalls(calls), 2);
  } finally {
    console.error = original;
  }
});

test("a model request that throws still leaves the generation that was in flight", async () => {
  const sink: GenerationRecord[] = [];
  await assert.rejects(generateSharedAnalysis(analysisInput(), scripted([{ step: "generate", fail: true }]), now, sink), /ANALYSIS_OPENAI_GENERATE_FAILED:503/);
  assert.deepEqual(sink.map((record) => [record.generationIndex, record.stage, record.errorCode, record.candidate]), [[1, "request_failed", "ANALYSIS_OPENAI_GENERATE_FAILED:503", null]]);
});

test("7. credentials are never written: keys and credential-shaped text are redacted, content stays", () => {
  const dirty = {
    headline_ja: "日経平均は上昇",
    x_post: { lead_ja: "本文 Bearer abcdefghijklmnop1234 を含む", points_ja: ["sk-proj_ABCDEFGHIJKLMNOPQRSTUVWX を含む点", "通常の点"] },
    nested: { Authorization: "Bearer zzzzzzzzzzzzzzzz", access_token: "t0k3n", apiKey: "k", password: "p", vault_secret: "v", ok: "keep" },
    jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.signaturepart",
    text: "api_key=abcd1234efgh と secret: hunter22",
  };
  const cleaned = redactValue(dirty) as typeof dirty;
  const serialized = JSON.stringify(cleaned);
  assert.equal(containsSecret(serialized), false, serialized);
  assert.equal(cleaned.headline_ja, "日経平均は上昇");
  assert.equal(cleaned.x_post.points_ja[1], "通常の点");
  assert.equal(cleaned.nested.Authorization, REDACTED);
  assert.equal(cleaned.nested.access_token, REDACTED);
  assert.equal(cleaned.nested.ok, "keep");
  assert.ok(cleaned.x_post.lead_ja.startsWith("本文 Bearer [redacted]"));
  assert.equal(containsSecret(JSON.stringify(dirty)), true, "the detector sees the raw secrets");
});

test("7b. a row that still carries a credential after the serializer is dropped, not written", async () => {
  const context = { reportType: "close" as const, tradingDate: "2026-09-17", cycleId: CYCLE, dataPacketId: dataFixture.id, invocationId: crypto.randomUUID(), attempt: 1, model: "m", basePromptHash: null };
  const record: GenerationRecord = {
    generationIndex: 1, stage: "local", hardRejection: "local", candidate: { x: "ok" }, localPassed: false,
    localIssues: ["指摘: Bearer abcdefghijklmnop1234"], localWarnings: [], factRan: false, factPassed: null, factIssues: [],
    selectedForDelivery: false, fallbackReason: null, removedUnits: [], deliveryIssues: [], errorCode: null, requestHash: null, calls: 1, inputTokens: 1, outputTokens: 1, costUsd: 0,
  };
  const rows = traceRows(context, [record]);
  assert.equal(containsSecret(JSON.stringify(rows)), false, "redacted on the way out");
  const written: TraceRow[] = [];
  assert.equal(await persistTraces((_table, batch) => { written.push(...batch); return Promise.resolve(); }, rows), true);
  assert.equal(written.length, 1);
  // A forged row that bypasses the serializer is refused by the writer.
  const forged = [{ ...rows[0], candidate: { header: "Bearer abcdefghijklmnop1234" } }];
  const logged: string[] = [];
  assert.equal(await persistTraces(() => Promise.reject(new Error("must not be called")), forged, (line) => logged.push(line)), false);
  assert.ok(logged[0].startsWith("GENERATION_TRACE_ROW_DROPPED"));
});

test("8. the generated report body itself is retained, structured, with every section of the candidate", async () => {
  const { deps, traceRowsWritten } = harness();
  await handleRequest(request(), deps);
  const candidate = traceRowsWritten[0].candidate as ReturnType<typeof good>;
  const expected = good();
  assert.equal(candidate.market_summary_ja, expected.market_summary_ja);
  assert.deepEqual(candidate.x_post.points_ja, expected.x_post.points_ja);
  assert.equal(candidate.app_story?.japan_ja, expected.app_story?.japan_ja);
  assert.equal(candidate.claims.length, expected.claims.length);
});

test("future personalized reports fit the shape: source and subject_ref are carried, nothing else assumed", () => {
  const [row] = traceRows(
    { source: "personalized_report", subjectRef: "report-123", reportType: "morning", tradingDate: "2026-10-07", cycleId: null, dataPacketId: null, invocationId: crypto.randomUUID(), attempt: 1, model: "m", basePromptHash: null },
    [{ generationIndex: 1, stage: "delivered", hardRejection: null, candidate: { overview_ja: "個人向け本文" }, localPassed: true, localIssues: [], localWarnings: [], factRan: false, factPassed: null, factIssues: [], selectedForDelivery: true, fallbackReason: null, removedUnits: [], deliveryIssues: [], errorCode: null, requestHash: null, calls: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 }],
  );
  assert.deepEqual([row.source, row.subject_ref], ["personalized_report", "report-123"]);
  assert.deepEqual(row.candidate, { overview_ja: "個人向け本文" }, "the generated text of a personal report is kept for QA");
});

test("prompt hash: stable per prompt, different when the instructions differ", async () => {
  const input = analysisInput();
  const a = await promptHash(String(generationRequestBody(input, []).instructions));
  assert.equal(a, await promptHash(String(generationRequestBody(input, []).instructions)));
  assert.notEqual(a, await promptHash(String(generationRequestBody(input, ["別の指摘"]).instructions)));
  assert.match(a, /^[0-9a-f]{16}$/);
});

test("14/15. prompt hygiene: no timing claim to copy, morning stays forward-looking, no finished examples added", async () => {
  const morningInput = inputOf(await loadFixture("morning_2026-10-02"));
  const closeInput = inputOf(await loadFixture("close_2026-10-01"));
  const morning = String(generationRequestBody(morningInput, []).instructions);
  const close = String(generationRequestBody(closeInput, []).instructions);
  for (const prompt of [morning, close]) {
    for (const copyable of ["前回の引け以降", "引け以降に確認", "確認できたニュース", "今日確認できたニュース"]) {
      assert.ok(!prompt.includes(copyable), `the prompt must not hand the model: ${copyable}`);
    }
    assert.ok(prompt.includes("ニュースがいつ取得・公表されたかには、入力に書かれた日時の範囲でしか触れません"));
  }
  assert.ok(morning.includes("今日の東京市場はまだ動いていないので、上昇した・下落したと言い切りません"), "morning stays forward-looking");
  assert.ok(morning.includes("今日の日本株で見る点を整理します"));
  assert.ok(close.includes("今日の値動きと、確認できる範囲の理由"));
  assert.ok(!morning.includes("取得の区切りや経過時間を、入力に無いまま書きません") === false, "the guard sentence names what not to write, without a copyable phrase");
});

test("9-13. PR #99 and the guards are unchanged: warnings stay telemetry, thresholds, ceiling, Hard, fallback", async () => {
  assert.deepEqual(pointsEditorialWarnings(["国際情勢のニュースを確認", "動きを見る", "情勢に注目"]), ["X_POINTS_GENERIC:3"]);
  assert.deepEqual(qualityRewriteHints(["X_POINTS_GENERIC:3", "X_POINTS_METRIC_RECAP:3", "X_POINTS_NEAR_DUPLICATE"]), []);
  assert.equal(X_POST_REWRITE_BELOW_CHARS, 300);
  assert.deepEqual(qualityRewriteHints(["X_POST_SHORTER_THAN_TARGET:387"]), []);
  assert.equal(MAX_GENERATIONS, 2);
  // Hard stays hard (the wrong headline never reaches the packet) and two bad generations cost at most four calls.
  const calls: string[] = [];
  const outcome = await generateSharedAnalysis(analysisInput(), (step, _body) => {
    calls.push(step);
    return Promise.resolve({ payload: step === "fact" ? { passed: false, issues: ["x"] } : bad(), inputTokens: 1, outputTokens: 1 });
  }, now);
  assert.ok(outcome.ok && !outcome.packet.headline_ja.includes("TOPIXがそろって"));
  assert.equal(outcome.ok && outcome.packet.fact.ai_status, "advisory");
  assert.deepEqual(calls, ["generate", "generate", "fact"]);
  // The safe original still wins over a rewrite the Fact check rejects, and says why.
  const sink: GenerationRecord[] = [];
  const thin = good();
  thin.app_story = { ...thin.app_story!, japan_ja: "短い。", news_ja: "短い。" };
  const fallback = await generateSharedAnalysis(analysisInput(), scripted([
    { step: "generate", payload: thin }, { step: "fact", payload: PASSED },
    { step: "generate", payload: good() }, { step: "fact", payload: { passed: false, issues: ["x"] } },
  ]), now, sink);
  assert.equal(fallback.ok, true);
  assert.deepEqual(fallback.ok && fallback.trace.deliveredGeneration, 1);
  assert.equal(sink[0].fallbackReason, "rewrite_rejected_fact");
});
