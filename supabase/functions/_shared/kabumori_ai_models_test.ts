// Kabumori AI model registry: resolution, the Responses API parameters, the audit tuple, cost estimation and the
// inventory text. Offline: no OpenAI call, no network, no environment.
import assert from "node:assert/strict";
import test from "node:test";
import {
  auditDiagnostics,
  auditTuple,
  describeKabumoriAiModels,
  estimateCallCostUsd,
  estimateModelCostUsd,
  KABUMORI_AI_CONFIG_VERSION,
  KABUMORI_AI_MODELS,
  KabumoriAiRoleError,
  MARKET_REPORT_FACT_ROLE,
  MARKET_REPORT_GENERATE_ROLE,
  MODEL_PRICING,
  resolveKabumoriAiRole,
  responsesApiParams,
} from "./kabumori_ai_models.ts";

test("the two market-report roles resolve to the verified model with the intended reasoning", () => {
  const generate = resolveKabumoriAiRole("kabumori.market_report.generate");
  const fact = resolveKabumoriAiRole("kabumori.market_report.fact");
  assert.deepEqual([generate.model, generate.reasoning.effort], ["gpt-6.1-sol", "medium"]);
  assert.deepEqual([fact.model, fact.reasoning.effort], ["gpt-6.1-sol", "low"]);
  assert.equal(generate.role, MARKET_REPORT_GENERATE_ROLE);
  assert.equal(fact.role, MARKET_REPORT_FACT_ROLE);
  assert.ok(generate.workload.length > 10 && fact.workload.length > 10);
  assert.deepEqual(Object.keys(KABUMORI_AI_MODELS).sort(), [MARKET_REPORT_FACT_ROLE, MARKET_REPORT_GENERATE_ROLE].sort(), "only the market-report roles");
});

test("only effort values the model supports are configured (none and minimal are rejected by the API)", () => {
  const supported = new Set(["low", "medium", "high", "xhigh", "max"]);
  for (const config of Object.values(KABUMORI_AI_MODELS)) {
    assert.ok(supported.has(config.reasoning.effort), `${config.role}: ${config.reasoning.effort}`);
    assert.ok(Number.isInteger(config.maxOutputTokens) && config.maxOutputTokens >= 1_000 && config.maxOutputTokens <= 128_000);
  }
});

test("an unknown role throws a fixed code: there is no silent default model", () => {
  assert.throws(() => resolveKabumoriAiRole("kabumori.market_report.unknown"), KabumoriAiRoleError);
  assert.throws(() => resolveKabumoriAiRole("social.text.generate"), /KABUMORI_AI_ROLE_UNKNOWN:social\.text\.generate/);
  assert.throws(() => resolveKabumoriAiRole("x\nINJECT"), /^Error: KABUMORI_AI_ROLE_UNKNOWN:x\?INJECT$/);
  assert.throws(() => resolveKabumoriAiRole(""), /KABUMORI_AI_ROLE_UNKNOWN/);
});

test("the registry cannot be changed at run time (no override that bypasses review)", () => {
  const generate = resolveKabumoriAiRole(MARKET_REPORT_GENERATE_ROLE) as { model: string; reasoning: { effort: string } };
  assert.ok(Object.isFrozen(KABUMORI_AI_MODELS) && Object.isFrozen(generate) && Object.isFrozen(generate.reasoning));
  assert.throws(() => { generate.model = "other"; }, TypeError);
  assert.throws(() => { generate.reasoning.effort = "none"; }, TypeError);
  assert.ok(Object.isFrozen(MODEL_PRICING) && Object.isFrozen(MODEL_PRICING["gpt-6.1-sol"]));
});

test("Responses API parameters: exactly model, reasoning.effort and max_output_tokens, copied (not shared)", () => {
  assert.deepEqual(responsesApiParams(MARKET_REPORT_GENERATE_ROLE), {
    model: "gpt-6.1-sol", reasoning: { effort: "medium" }, max_output_tokens: 16_000,
  });
  assert.deepEqual(responsesApiParams(MARKET_REPORT_FACT_ROLE), {
    model: "gpt-6.1-sol", reasoning: { effort: "low" }, max_output_tokens: 4_000,
  });
  const params = responsesApiParams(MARKET_REPORT_FACT_ROLE);
  params.reasoning.effort = "high";
  assert.equal(resolveKabumoriAiRole(MARKET_REPORT_FACT_ROLE).reasoning.effort, "low", "a caller cannot edit the registry through the params");
});

test("audit tuple: logical role, actual model and configuration version", () => {
  assert.deepEqual(auditTuple(MARKET_REPORT_GENERATE_ROLE), {
    logical_role: "kabumori.market_report.generate", actual_model: "gpt-6.1-sol", config_version: KABUMORI_AI_CONFIG_VERSION,
  });
  assert.match(KABUMORI_AI_CONFIG_VERSION, /^kabumori-ai-models\/\d{4}-\d{2}-\d{2}\.\d+$/);
  const flat = auditDiagnostics();
  assert.deepEqual(flat, {
    ai_config_version: KABUMORI_AI_CONFIG_VERSION,
    ai_generate_role: "kabumori.market_report.generate", ai_generate_model: "gpt-6.1-sol", ai_generate_reasoning: "medium",
    ai_fact_role: "kabumori.market_report.fact", ai_fact_model: "gpt-6.1-sol", ai_fact_reasoning: "low",
  });
  assert.ok(Object.values(flat).every((value) => typeof value === "string"), "report_diagnostics holds text values");
});

test("cost: the verified official standard price, per request, upper bound (no cached-input discount)", () => {
  assert.equal(MODEL_PRICING["gpt-6.1-sol"].standard.inputPerMillion, 2);
  assert.equal(MODEL_PRICING["gpt-6.1-sol"].standard.cachedInputPerMillion, 0.1);
  assert.equal(MODEL_PRICING["gpt-6.1-sol"].standard.outputPerMillion, 10);
  assert.equal(estimateCallCostUsd(MARKET_REPORT_GENERATE_ROLE, 100_000, 0), 0.2, "100K input tokens at $2 per 1M");
  assert.equal(estimateCallCostUsd(MARKET_REPORT_GENERATE_ROLE, 0, 1_000_000), 10);
  assert.equal(estimateCallCostUsd(MARKET_REPORT_FACT_ROLE, 13_580, 2_631), 0.05347);
  assert.equal(estimateCallCostUsd(MARKET_REPORT_FACT_ROLE, 0, 0), 0);
});

test("cost: a request above 272K input tokens uses the long-context price; at the threshold it does not", () => {
  const threshold = MODEL_PRICING["gpt-6.1-sol"].longContextAboveInputTokens;
  assert.equal(threshold, 272_000);
  assert.equal(estimateCallCostUsd(MARKET_REPORT_GENERATE_ROLE, threshold, 1_000_000), Number(((threshold * 2 + 10_000_000) / 1e6).toFixed(6)));
  assert.equal(estimateCallCostUsd(MARKET_REPORT_GENERATE_ROLE, threshold + 1, 1_000_000), Number((((threshold + 1) * 4 + 15_000_000) / 1e6).toFixed(6)));
});

test("cost: the old model's price is gone and an unpriced model throws instead of costing nothing", () => {
  assert.deepEqual(Object.keys(MODEL_PRICING), ["gpt-6.1-sol"]);
  assert.throws(() => estimateModelCostUsd("gpt-5.6-luna", 1_000, 1_000), /KABUMORI_AI_PRICE_UNKNOWN:gpt-5\.6-luna/);
  assert.throws(() => estimateModelCostUsd("some model\nname", 1, 1), /^Error: KABUMORI_AI_PRICE_UNKNOWN:some\?model\?name$/);
  assert.equal(estimateModelCostUsd("gpt-6.1-sol", 1_000, 200), 0.004);
});

test("inventory text names each role, its model, reasoning, the configuration version and the price", () => {
  const text = describeKabumoriAiModels();
  const lines = text.split("\n");
  assert.equal(lines[0], `Kabumori AI models (config ${KABUMORI_AI_CONFIG_VERSION})`);
  assert.ok(lines.includes("Market Report Generate: gpt-6.1-sol / reasoning medium / max output 16000 tokens  [kabumori.market_report.generate]"));
  assert.ok(lines.includes("Market Report Fact: gpt-6.1-sol / reasoning low / max output 4000 tokens  [kabumori.market_report.fact]"));
  assert.ok(text.includes("$2 in / $0.1 cached / $10 out per 1M tokens"));
  assert.ok(text.includes("verified 2026-10-07"));
  assert.equal(text, describeKabumoriAiModels(), "deterministic");
});

test("the registry module is pure: no network, environment or file access in its code", async () => {
  const source = await Deno.readTextFile(new URL("./kabumori_ai_models.ts", import.meta.url));
  const code = source.split("\n").filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*") && !line.trim().startsWith("/*")).join("\n");
  assert.doesNotMatch(code, /\bfetch\s*\(|Deno\.(env|readTextFile|readFile|open|run|Command)|process\.env|import\s*\(|XMLHttpRequest|WebSocket/);
});
