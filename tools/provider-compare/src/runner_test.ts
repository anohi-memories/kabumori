import assert from "node:assert/strict";
import test from "node:test";
import { loadCases } from "./fixtures.ts";
import { averagesOf, loadLedgerSnapshot } from "./ledger_snapshot.ts";
import { BudgetGuard } from "./budget.ts";
import { runComparison, type Report } from "./runner.ts";
import { createMockProvider } from "./providers/mock.ts";
import { createRecordedProvider, recordedOutput } from "./providers/recorded.ts";
import { ProviderFailure } from "./retry.ts";
import { SecretLeakError } from "./redact.ts";
import type { Provider } from "./types.ts";
import type { TaskId } from "./tasks.ts";

const cases = (await loadCases()).slice(0, 6);
const averages = averagesOf(await loadLedgerSnapshot());
const CLOCK = () => "2026-10-09T00:00:00.000Z";

function mirror(label = "claude (mock)"): Provider {
  const byId = new Map(cases.map((c) => [c.caseId, c]));
  return createMockProvider({
    name: "anthropic", model: "claude-haiku-5-5", label,
    responder: (request) => {
      const fixture = byId.get(request.caseId);
      return { text: (fixture ? recordedOutput(request.taskId, fixture) : null) ?? "{\"candidates\":[]}", usage: { inputTokens: 1000, outputTokens: 100 } };
    },
  });
}

const TASKS: TaskId[] = ["judgement_primary", "generation_fact"];

async function run(mode: "mock" | "dry-run" | "live", providers: Provider[], budget = new BudgetGuard(mode === "live" ? "live" : mode, { maxCalls: 1000, maxUsd: 100 }, true), extra: object = {}) {
  return await runComparison({
    cases, providers, estimateSpecs: providers.map((p) => p.name === "recorded" ? null : { model: p.model, effort: "low" as const }),
    tasks: TASKS, mode, budget, averages, now: CLOCK, ...extra,
  });
}

test("mock runs are reproducible byte for byte (stable order, injected clock, no wall-clock fields)", async () => {
  const providers = () => [createRecordedProvider(cases, averages), mirror()];
  const first = JSON.stringify(await run("mock", providers()));
  const second = JSON.stringify(await run("mock", providers()));
  assert.equal(first, second);
  assert.equal((JSON.parse(first) as Report).generatedAt, "2026-10-09T00:00:00.000Z");
});

test("entries come out sorted by task, case, provider regardless of the order providers were given", async () => {
  const a = await run("mock", [createRecordedProvider(cases, averages), mirror()]);
  const b = await run("mock", [mirror(), createRecordedProvider(cases, averages)]);
  assert.deepEqual(a.entries.map((e) => `${e.taskId}|${e.caseId}|${e.label}`), b.entries.map((e) => `${e.taskId}|${e.caseId}|${e.label}`));
});

test("a mirror of production agrees with production on every judged case and scores the same as it", async () => {
  const report = await run("mock", [createRecordedProvider(cases, averages), mirror()]);
  const rows = report.summary.filter((row) => row.taskId === "judgement_primary");
  assert.equal(rows.length, 2);
  for (const row of rows) assert.equal(row.agreeWithRecorded, 1, row.label);
  assert.equal(rows[0].agreeWithExpected, rows[1].agreeWithExpected);
});

test("dry-run never calls a provider and marks every estimate as an estimate", async () => {
  const spy: Provider = {
    name: "anthropic", model: "claude-sonnet-5-5", label: "spy",
    run: () => { throw new Error("dry-run must not call run()"); },
  };
  const report = await run("dry-run", [createRecordedProvider(cases, averages), spy]);
  const estimates = report.entries.filter((e) => e.label === "spy");
  assert.ok(estimates.length > 0);
  for (const entry of estimates) {
    assert.equal(entry.estimated, true);
    assert.equal(entry.stopReason, "estimate");
    assert.ok(entry.costUsd > 0);
    assert.equal(entry.metric, null);
  }
  assert.equal(report.budget.calls, 0);
});

test("the estimate is the same ledger-based token count for every provider, so a vendor never looks cheaper by guessing", async () => {
  const gpt: Provider = { name: "openai", model: "gpt-6-luna", label: "gpt", run: () => { throw new Error("no"); } };
  const claude: Provider = { name: "anthropic", model: "claude-haiku-5-5", label: "claude", run: () => { throw new Error("no"); } };
  const report = await runComparison({
    cases, providers: [gpt, claude], estimateSpecs: [{ model: "gpt-6-luna", effort: "low" }, { model: "claude-haiku-5-5", effort: "low", thinking: "off" }],
    tasks: ["judgement_primary"], mode: "dry-run", budget: new BudgetGuard("dry-run", { maxCalls: 0, maxUsd: 0 }, false), averages, now: CLOCK,
  });
  const g = report.entries.find((e) => e.label === "gpt")!;
  const c = report.entries.find((e) => e.label === "claude")!;
  assert.equal(g.usage.inputTokens, c.usage.inputTokens);
  assert.equal(g.usage.outputTokens, c.usage.outputTokens);
  assert.equal(g.costUsd, c.costUsd, "Haiku 5.5 and gpt-6-luna have the same list price, so thinking-off costs the same");
});

test("live mode stops the whole run at the call limit and says why; earlier results are kept", async () => {
  const budget = new BudgetGuard("live", { maxCalls: 3, maxUsd: 100 }, true);
  const provider = createMockProvider({ name: "anthropic", model: "claude-haiku-5-5", label: "paid", responder: () => ({ text: "{\"importance\":\"important\",\"reason\":\"r\"}" }), estimateUsd: 0.001 });
  const report = await run("live", [provider], budget);
  assert.equal(report.stoppedBy, "BUDGET_MAX_CALLS");
  assert.equal(report.entries.length, 3);
  assert.equal(report.budget.calls, 3);
});

test("a retried request spends budget attempts too", async () => {
  const budget = new BudgetGuard("live", { maxCalls: 4, maxUsd: 100 }, true);
  let n = 0;
  const flaky = createMockProvider({
    name: "anthropic", model: "claude-haiku-5-5", label: "flaky",
    responder: () => (++n % 2 === 1 ? new ProviderFailure("HTTP_529", 529, "overloaded") : { text: "{\"importance\":\"important\",\"reason\":\"r\"}" }),
  });
  const report = await run("live", [flaky], budget);
  assert.equal(report.stoppedBy, "BUDGET_MAX_CALLS");
  assert.equal(report.entries.length, 2, "4 attempts = 2 requests of 2 attempts each");
  assert.ok(report.entries.every((e) => e.attempts === 2));
});

test("a provider failure is a result row, not a crash, and does not stop the run", async () => {
  const failing = createMockProvider({ name: "anthropic", model: "claude-haiku-5-5", label: "down", responder: () => new ProviderFailure("HTTP_400", 400, "bad") });
  const report = await run("mock", [failing]);
  assert.ok(report.entries.length > 0);
  assert.ok(report.entries.every((e) => !e.ok && e.error?.status === 400));
  assert.equal(report.summary.find((row) => row.label === "down")?.okRate, 0);
});

test("a key that leaks into a result makes the run throw instead of writing it out", async () => {
  const leaky = createMockProvider({ name: "anthropic", model: "claude-haiku-5-5", label: "leaky", responder: () => ({ text: "{\"echo\":\"my-unusual-secret-value\"}" }) });
  await assert.rejects(run("mock", [leaky], undefined, { knownSecrets: ["my-unusual-secret-value"] }), SecretLeakError);
  const clean = createMockProvider({ name: "anthropic", model: "claude-haiku-5-5", label: "clean", responder: () => ({ text: "{}" }) });
  await assert.doesNotReject(run("mock", [clean], undefined, { knownSecrets: ["my-unusual-secret-value"] }));
});

test("cases a task has nothing to run on are listed as skipped, not run with invented input", async () => {
  const report = await runComparison({
    cases: (await loadCases()).filter((c) => c.recorded.judgement.importance === "no_post"),
    providers: [createRecordedProvider(await loadCases(), averages)], estimateSpecs: [null],
    tasks: ["generation_draft"], mode: "mock", budget: new BudgetGuard("mock", { maxCalls: 0, maxUsd: 0 }, false), averages, now: CLOCK,
  });
  assert.equal(report.entries.length, 0);
  assert.ok(report.skipped.length >= 2);
});

test("web search runs on the four daily topics and reports source metrics", async () => {
  const search = createMockProvider({
    name: "anthropic", model: "claude-sonnet-5-5", label: "search",
    responder: () => ({ text: "{\"candidates\":[]}", usage: { inputTokens: 13000, outputTokens: 200, webSearchRequests: 1 } }),
  });
  const report = await runComparison({
    cases, providers: [search], estimateSpecs: [null], tasks: ["web_search"], mode: "mock",
    budget: new BudgetGuard("mock", { maxCalls: 0, maxUsd: 0 }, false), averages, now: CLOCK,
  });
  assert.equal(report.entries.length, 4);
  assert.ok(report.entries.every((e) => e.caseId.startsWith("topic:")));
  assert.ok(report.entries.every((e) => (e.metric as { candidateCount: number }).candidateCount === 0));
  assert.ok(report.entries[0].costUsd >= 0.01, "a search is billed at $10 per 1,000 on top of tokens");
});
