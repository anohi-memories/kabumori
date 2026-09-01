import assert from "node:assert/strict";
import test from "node:test";

(globalThis as unknown as { Deno: unknown }).Deno = {
  serve: () => undefined,
  env: { get: () => undefined },
};

const { parseUsefulTipOutput, isUsefulTipOutputTruncated } = await import("./index.ts");

const valid = {
  fact_check_status: "passed",
  fact_check_notes: ["公式情報で確認済み"],
  needs_sol: false,
  source_urls: ["https://www.jpx.co.jp/example"],
  text: "日本語の本文です。\n改行も絵文字もOKです☺️📈",
};

test("valid JSON succeeds on the first parse attempt", () => {
  const result = parseUsefulTipOutput(JSON.stringify(valid));
  assert.equal(result.parseAttemptCount, 1);
  assert.deepEqual(result.value, valid);
});

test("json fenced JSON succeeds on the second parse attempt", () => {
  const result = parseUsefulTipOutput(`\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``);
  assert.equal(result.parseAttemptCount, 2);
  assert.deepEqual(result.value, valid);
});

test("unlabelled fenced JSON succeeds on the second parse attempt", () => {
  const result = parseUsefulTipOutput(`\`\`\`\n${JSON.stringify(valid)}\n\`\`\``);
  assert.equal(result.parseAttemptCount, 2);
});

test("invalid JSON gets the parse-specific error", () => {
  assert.throws(() => parseUsefulTipOutput("{invalid"), /USEFUL_TIP_JSON_PARSE_FAILED/);
});

test("missing required fields get the schema-specific error", () => {
  assert.throws(
    () => parseUsefulTipOutput(JSON.stringify({ text: "本文だけ" })),
    /USEFUL_TIP_SCHEMA_INVALID/,
  );
});

test("incorrect required field types get the schema-specific error", () => {
  assert.throws(
    () => parseUsefulTipOutput(JSON.stringify({ ...valid, source_urls: "https://www.jpx.co.jp/example" })),
    /USEFUL_TIP_SCHEMA_INVALID/,
  );
});

test("newlines, emoji, Japanese and URLs inside valid JSON remain valid", () => {
  const result = parseUsefulTipOutput(JSON.stringify(valid));
  assert.match(result.value.text, /☺️📈/u);
  assert.match(result.value.text, /\n/u);
  assert.equal(result.value.source_urls[0], "https://www.jpx.co.jp/example");
});

test("natural language around JSON is not guessed or extracted", () => {
  assert.throws(
    () => parseUsefulTipOutput(`結果はこちらです。\n${JSON.stringify(valid)}\n以上です。`),
    /USEFUL_TIP_JSON_PARSE_FAILED/,
  );
});

test("only an explicit max-output-tokens incomplete response is truncated", () => {
  assert.equal(isUsefulTipOutputTruncated({
    status: "incomplete",
    incomplete_details: { reason: "max_output_tokens" },
  }), true);
  assert.equal(isUsefulTipOutputTruncated({ status: "completed" }), false);
});
