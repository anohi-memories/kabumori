import assert from "node:assert/strict";
import test from "node:test";
import { loadCases } from "./fixtures.ts";
import { captureOpenAiRequest } from "./capture.ts";
import { fromOpenAiResponsesBody, NeutralConversionError } from "./neutral.ts";
import {
  buildTaskRequest,
  buildWebSearchRequests,
  recordedDraftText,
  recordedFinalText,
  SEARCH_REFERENCE_TIME,
  TASK_IDS,
} from "./tasks.ts";
import { BREAKING_MARKET_NEWS_DOMAINS } from "../../../supabase/functions/important-news-monitor/breaking_market_source_fetchers.ts";

test("capture records the body a production builder would send, without any network call", async () => {
  const captured = await captureOpenAiRequest(async (fetchImpl) => {
    await fetchImpl("https://api.openai.com/v1/responses", { method: "POST", body: JSON.stringify({ hello: "world" }) });
  });
  assert.deepEqual(captured.body, { hello: "world" });
  assert.equal(captured.url, "https://api.openai.com/v1/responses");
});

test("capture surfaces an unrelated failure and a call that never sends a request", async () => {
  await assert.rejects(captureOpenAiRequest(() => Promise.reject(new Error("other"))), /other/);
  await assert.rejects(captureOpenAiRequest(() => Promise.resolve()), /CAPTURE_NO_REQUEST/);
});

test("conversion keeps instructions, input, schema, effort, search tool and limits", () => {
  const request = fromOpenAiResponsesBody({
    instructions: "SYS",
    input: "{\"a\":1}",
    max_output_tokens: 700,
    reasoning: { effort: "low" },
    max_tool_calls: 1,
    text: { format: { type: "json_schema", name: "n", strict: true, schema: { type: "object" } } },
    tools: [{ type: "web_search", filters: { allowed_domains: ["a.com", "b.com"] }, search_context_size: "low" }],
  }, { taskId: "web_search", caseId: "c" });
  assert.deepEqual(request, {
    taskId: "web_search", caseId: "c", system: "SYS", user: "{\"a\":1}", maxOutputTokens: 700, effort: "low",
    schema: { name: "n", schema: { type: "object" } },
    webSearch: { allowedDomains: ["a.com", "b.com"], maxUses: 1 },
  });
});

test("conversion rejects malformed bodies instead of guessing", () => {
  for (const bad of [null, "x", {}, { instructions: "a" }, { instructions: "a", input: "b" }, { instructions: "a", input: "b", max_output_tokens: 0 },
    { instructions: "a", input: "b", max_output_tokens: 5, text: { format: { type: "text" } } }]) {
    assert.throws(() => fromOpenAiResponsesBody(bad, { taskId: "t", caseId: "c" }), NeutralConversionError);
  }
});

test("every task builds from the real production request builders for every fixture that has input for it", async () => {
  const cases = await loadCases();
  for (const taskId of TASK_IDS.filter((id) => id !== "web_search")) {
    let built = 0;
    for (const fixture of cases) {
      const request = await buildTaskRequest(taskId as Exclude<typeof taskId, "web_search">, fixture);
      if (request === null) continue;
      built += 1;
      assert.equal(request.taskId, taskId);
      assert.equal(request.caseId, fixture.caseId);
      assert.ok(request.system.length > 100, `${taskId} instructions`);
      assert.ok(request.schema?.schema, `${taskId} schema`);
      // the candidate's own title travels in the production input
      if (taskId === "judgement_primary") assert.ok(request.user.includes(fixture.candidate.title.slice(0, 20)));
    }
    assert.ok(built >= 15, `${taskId} built for ${built} cases`);
  }
});

test("the prompts are the production prompts (a string from each production builder is present)", async () => {
  const cases = await loadCases();
  const fixture = cases.find((c) => c.recorded.generation?.text) ?? cases[0];
  const primary = await buildTaskRequest("judgement_primary", fixture);
  assert.match(primary!.system, /日本株向け重要ニュース監視の判定担当/);
  assert.equal(primary!.effort, "low");
  const detail = await buildTaskRequest("judgement_detail", fixture);
  assert.equal(detail!.effort, "medium");
  assert.match(detail!.user, /luna_preliminary/);
  assert.ok(!primary!.user.includes("\"luna_preliminary\":{"));
  const fact = await buildTaskRequest("generation_fact", fixture);
  assert.match(fact!.system, /厳格なFactチェッカー/);
  const voice = await buildTaskRequest("generation_voice", fixture);
  assert.match(voice!.system, /Voiceチェッカー/);
});

test("Fact and Voice are given the post exactly as production stored it (label and source line included)", async () => {
  const cases = await loadCases();
  const fixture = cases.find((c) => c.recorded.generation?.text?.includes("出典:"))!;
  const fact = await buildTaskRequest("generation_fact", fixture);
  const sent = JSON.parse(fact!.user) as { generated_text: string };
  assert.equal(sent.generated_text, recordedFinalText(fixture));
  assert.match(recordedFinalText(fixture)!, /^【(?:重大)?速報】/);
  const draft = recordedDraftText(fixture)!;
  assert.ok(!draft.includes("出典:"));
  assert.ok(!/^【/.test(draft));
});

test("a no_post case has no draft task; a case with no stored post has no Fact / Voice task", async () => {
  const cases = await loadCases();
  const negative = cases.find((c) => c.recorded.judgement.importance === "no_post")!;
  assert.equal(await buildTaskRequest("generation_draft", negative), null);
  assert.equal(await buildTaskRequest("generation_fact", negative), null);
});

test("web search tasks are the four daily Japan topics with the news-outlet domain filter and a fixed clock", () => {
  const first = buildWebSearchRequests();
  const second = buildWebSearchRequests();
  assert.deepEqual(first, second);
  assert.deepEqual(first.map((r) => r.caseId).sort(), [
    "topic:boj_monetary_policy", "topic:fx_intervention_mof", "topic:japan_disaster_security_emergency", "topic:japan_market_session",
  ]);
  assert.equal(first.length, 4);
  for (const request of first) {
    assert.deepEqual(request.webSearch?.allowedDomains, BREAKING_MARKET_NEWS_DOMAINS);
    assert.equal(request.webSearch?.maxUses, 1);
    assert.ok(request.user.includes("October 9 2026"), "recency terms come from the fixed reference time");
  }
  assert.equal(SEARCH_REFERENCE_TIME.toISOString(), "2026-10-09T04:00:00.000Z");
});
