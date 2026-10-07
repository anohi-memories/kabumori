// Drift guard: the Kabumori shared market-report pipeline names its OpenAI models only through the registry
// (supabase/functions/_shared/kabumori_ai_models.ts, by logical role). A raw `gpt-…` literal in the runtime code of
// this pipeline would let a model change slip past the registry (no version bump, no price, no inventory).
//
// Scope, on purpose narrow: the Kabumori market-report runtime files below. NOT scanned: the registry itself, tests,
// fixtures and docs (they may name models), and every other product (POSTONA / social, important-news-monitor,
// MIC, personalized reports, x-test-post), which own their model policy elsewhere.
import assert from "node:assert/strict";
import test from "node:test";

const FUNCTIONS = new URL("../", import.meta.url);

/** A model id of the GPT family written as text: gpt-6.1-sol, gpt-5.6-luna, gpt-4o, ... */
const RAW_MODEL = /\bgpt-[0-9][0-9A-Za-z._-]*/g;

/** Runtime (non-test) files of the Kabumori shared market-report pipeline. */
async function pipelineFiles(): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of Deno.readDir(new URL("market-report-analysis/", FUNCTIONS))) {
    if (entry.isFile && entry.name.endsWith(".ts") && !entry.name.endsWith("_test.ts")) files.push(`market-report-analysis/${entry.name}`);
  }
  files.push(
    "_shared/market_report_packet.ts", "_shared/market_report_story.ts", "_shared/absence_claims.ts", "_shared/kabumori_voice.ts",
    "market-report-data-packet/session_logic.ts", "x-test-post/shared_market_report_consumer.ts",
  );
  return files.sort();
}

/** Offending `gpt-…` literals of one file, with line numbers, ignoring nothing: a comment that names a model also counts. */
export function rawModelLiterals(source: string): Array<{ line: number; literal: string }> {
  const found: Array<{ line: number; literal: string }> = [];
  source.split("\n").forEach((text, index) => {
    for (const match of text.matchAll(RAW_MODEL)) found.push({ line: index + 1, literal: match[0] });
  });
  return found;
}

test("the pipeline's runtime files hold no raw gpt-… model literal (roles go through the registry)", async () => {
  const offences: string[] = [];
  for (const file of await pipelineFiles()) {
    const source = await Deno.readTextFile(new URL(file, FUNCTIONS));
    for (const { line, literal } of rawModelLiterals(source)) {
      offences.push(`${file}:${line} hard-codes model "${literal}" — resolve it by logical role from _shared/kabumori_ai_models.ts instead`);
    }
  }
  assert.deepEqual(offences, [], `raw model literal(s) outside the Kabumori AI model registry:\n${offences.join("\n")}`);
});

test("the guard actually watches the model-bearing files (it would not pass by scanning nothing)", async () => {
  const files = await pipelineFiles();
  for (const required of ["market-report-analysis/analysis_logic.ts", "market-report-analysis/handler.ts", "market-report-analysis/index.ts"]) {
    assert.ok(files.includes(required), required);
  }
  for (const file of files) assert.ok((await Deno.readTextFile(new URL(file, FUNCTIONS))).length > 0, file);
});

test("detector: finds a literal and names the file and line; ignores the registry's roles and other words", () => {
  assert.deepEqual(rawModelLiterals('const model = "gpt-6.2-future";\nconst x = 1;'), [{ line: 1, literal: "gpt-6.2-future" }]);
  assert.deepEqual(rawModelLiterals("// was gpt-5.6-luna\nmodel: \"gpt-4o\""), [{ line: 1, literal: "gpt-5.6-luna" }, { line: 2, literal: "gpt-4o" }]);
  assert.deepEqual(rawModelLiterals('role: "kabumori.market_report.generate"; // the gpt family; MIC "gptq"'), []);
  assert.deepEqual(rawModelLiterals("ANALYSIS_MODEL = resolveKabumoriAiRole(MARKET_REPORT_GENERATE_ROLE).model;"), []);
});

test("the guard does not reach into other products (their model policy is theirs)", async () => {
  const files = await pipelineFiles();
  for (const foreign of ["important-news-monitor", "market-intelligence", "personalized-reports", "social", "_shared/social_ai_model_policy"]) {
    assert.ok(!files.some((file) => file.includes(foreign)), foreign);
  }
});

test("the guard fails when a literal is added: a copy of the entry point with one literal is caught", async () => {
  const source = await Deno.readTextFile(new URL("market-report-analysis/analysis_logic.ts", FUNCTIONS));
  assert.deepEqual(rawModelLiterals(source), [], "the real file is clean");
  const drifted = source.replace("export const ANALYSIS_MODEL", 'const DRIFT = "gpt-9.9-drift";\nexport const ANALYSIS_MODEL');
  const hits = rawModelLiterals(drifted);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].literal, "gpt-9.9-drift");
});
