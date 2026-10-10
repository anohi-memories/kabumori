// Runtime validation against the original schema (required tests 3-8): valid payload, missing required field, type
// mismatch, numeric range, array and string constraints, nested objects, and issue text that never echoes values.
import assert from "node:assert/strict";
import test from "node:test";
import { SAMPLE_SCHEMA, VALID_PAYLOAD } from "./test_support.ts";
import { MAX_SCHEMA_ISSUES, validateAgainstSchema } from "./validate.ts";

function issues(payload: unknown) {
  return validateAgainstSchema(payload, SAMPLE_SCHEMA).map((issue) => `${issue.path}:${issue.keyword}`);
}

function withChange(change: (copy: Record<string, unknown>) => void) {
  const copy = structuredClone(VALID_PAYLOAD) as Record<string, unknown>;
  change(copy);
  return copy;
}

test("3. a payload that satisfies every constraint has no issues", () => {
  assert.deepEqual(issues(VALID_PAYLOAD), []);
  assert.deepEqual(issues(withChange((p) => ((p.detail as Record<string, unknown>).note = null))), [], "anyOf null branch");
});

test("4. a missing required field is an issue, at top level and nested", () => {
  assert.deepEqual(issues(withChange((p) => delete p.score)), ["/score:required"]);
  assert.deepEqual(issues(withChange((p) => delete (p.detail as Record<string, unknown>).count)), ["/detail/count:required"]);
});

test("5. type mismatches are issues (integer vs number, string vs number, object vs array, null)", () => {
  assert.deepEqual(issues(withChange((p) => (p.score = "0.5"))), ["/score:type"]);
  assert.deepEqual(issues(withChange((p) => ((p.detail as Record<string, unknown>).count = 1.5))), ["/detail/count:type"]);
  assert.deepEqual(issues(withChange((p) => (p.detail = []))), ["/detail:type"]);
  assert.deepEqual(issues(null), ["/:type"]);
  assert.deepEqual(issues(withChange((p) => (p.kind = "other"))), ["/kind:enum"]);
});

test("6. numeric range violations are issues", () => {
  assert.deepEqual(issues(withChange((p) => (p.score = 1.01))), ["/score:maximum"]);
  assert.deepEqual(issues(withChange((p) => (p.score = -0.1))), ["/score:minimum"]);
  assert.deepEqual(issues(withChange((p) => ((p.detail as Record<string, unknown>).count = -1))), ["/detail/count:minimum"]);
  const exclusive = { type: "object", additionalProperties: false, required: ["x"], properties: { x: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1, multipleOf: 0.25 } } };
  assert.deepEqual(validateAgainstSchema({ x: 0.5 }, exclusive), []);
  assert.deepEqual(validateAgainstSchema({ x: 0 }, exclusive).map((i) => i.keyword), ["exclusiveMinimum"]);
  assert.deepEqual(validateAgainstSchema({ x: 0.3 }, exclusive).map((i) => i.keyword), ["multipleOf"]);
  assert.deepEqual(validateAgainstSchema({ x: Number.NaN }, exclusive).map((i) => i.keyword), ["type"]);
});

test("7. array constraint violations are issues (minItems, maxItems, uniqueItems, item enum)", () => {
  assert.deepEqual(issues(withChange((p) => (p.tags = []))), ["/tags:minItems"]);
  assert.deepEqual(issues(withChange((p) => (p.tags = ["a", "b", "c", "d"]))), ["/tags:maxItems"]);
  assert.deepEqual(issues(withChange((p) => (p.tags = ["a", "a"]))), ["/tags:uniqueItems"]);
  assert.deepEqual(issues(withChange((p) => (p.tags = ["a", "z"]))), ["/tags/1:enum"]);
});

test("8. string constraint violations are issues; length counts code points (Japanese, emoji)", () => {
  assert.deepEqual(issues(withChange((p) => (p.title = ""))), ["/title:minLength"]);
  assert.deepEqual(issues(withChange((p) => (p.title = "あ".repeat(20)))), [], "20 Japanese characters fit maxLength 20");
  assert.deepEqual(issues(withChange((p) => (p.title = "あ".repeat(21)))), ["/title:maxLength"]);
  assert.deepEqual(issues(withChange((p) => (p.title = "😀".repeat(20)))), [], "emoji are one code point each, not two UTF-16 units");
  assert.deepEqual(issues(withChange((p) => ((p.detail as Record<string, unknown>).note = "UPPER"))), ["/detail/note:anyOf"]);
});

test("nested objects reject unexpected keys without naming them", () => {
  const result = validateAgainstSchema(withChange((p) => ((p.detail as Record<string, unknown>)["secret_name_from_model"] = 1)), SAMPLE_SCHEMA);
  assert.deepEqual(result, [{ path: "/detail", keyword: "additionalProperties" }]);
  assert.ok(!JSON.stringify(result).includes("secret_name_from_model"));
});

test("issues never contain output values", () => {
  const sentinel = "SENTINEL-VALUE-見出し";
  const result = validateAgainstSchema(withChange((p) => (p.title = sentinel.repeat(5))), SAMPLE_SCHEMA);
  assert.ok(result.length > 0);
  assert.ok(!JSON.stringify(result).includes("SENTINEL"));
});

test("issue count is capped, and an unknown keyword in a schema is an issue, not ignored", () => {
  const many = { type: "object", additionalProperties: false, required: [] as string[], properties: {} as Record<string, unknown> };
  for (let index = 0; index < 40; index += 1) {
    many.required.push(`k${index}`);
    many.properties[`k${index}`] = { type: "string" };
  }
  assert.equal(validateAgainstSchema({}, many).length, MAX_SCHEMA_ISSUES);
  assert.deepEqual(validateAgainstSchema("x", { type: "string", format: "date" }).map((i) => i.keyword), ["unsupported_keyword"]);
});
