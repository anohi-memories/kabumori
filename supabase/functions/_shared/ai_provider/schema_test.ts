// JSON Schema policy and provider conversion: supported subset, fail-closed rejection, per-provider stripping,
// description hints, and that the original schema is never modified.
import assert from "node:assert/strict";
import test from "node:test";
import { assertSchemaSupported, SchemaUnsupportedError, toProviderSchema } from "./schema.ts";
import { SAMPLE_SCHEMA } from "./test_support.ts";
import type { JsonSchema } from "./types.ts";

function object(properties: Record<string, unknown>, extra: Record<string, unknown> = {}): JsonSchema {
  return { type: "object", additionalProperties: false, required: Object.keys(properties), properties, ...extra };
}

function rejects(schema: unknown, reason: RegExp) {
  assert.throws(() => assertSchemaSupported(schema as JsonSchema), (error: unknown) => {
    assert.ok(error instanceof SchemaUnsupportedError);
    assert.match(error.reason, reason);
    return true;
  });
}

test("the sample schema (nested object, enum, $ref, anyOf null, constraints) is supported", () => {
  assert.doesNotThrow(() => assertSchemaSupported(SAMPLE_SCHEMA));
});

test("fail-closed: keywords that cannot be verified locally are rejected, not dropped", () => {
  for (const keyword of ["allOf", "oneOf", "not", "if", "format", "default", "patternProperties", "prefixItems", "dependentRequired", "examples"]) {
    rejects(object({ a: { type: "string", [keyword]: keyword === "format" ? "date" : [] } }), new RegExp(`keyword_${keyword}`));
  }
});

test("objects must be closed and list every property as required (portable strict mode)", () => {
  rejects({ type: "object", properties: { a: { type: "string" } }, required: ["a"] }, /additionalProperties_must_be_false/);
  rejects({ type: "object", additionalProperties: true, properties: {}, required: [] }, /additionalProperties_must_be_false/);
  rejects({ type: "object", additionalProperties: false, properties: { a: { type: "string" }, b: { type: "string" } }, required: ["a"] }, /required_must_list_every_property/);
  rejects(object({ inner: { type: "object", properties: { x: { type: "number" } }, required: ["x"] } }), /additionalProperties_must_be_false/);
});

test("root must be an object; recursion, external refs, deep nesting and too many unions are rejected", () => {
  rejects({ type: "array", items: { type: "string" } }, /root_must_be_object/);
  rejects({ anyOf: [object({})] }, /root_must_be_object/);
  rejects(object({ node: { $ref: "#/$defs/node" } }, { $defs: { node: object({ child: { $ref: "#/$defs/node" } }) } }), /recursive_ref/);
  rejects(object({ a: { $ref: "https://example.com/schema" } }), /ref_not_local_definition/);
  rejects(object({ a: { $ref: "#/$defs/missing" } }), /ref_target_missing/);
  let deep: JsonSchema = object({ leaf: { type: "string" } });
  for (let level = 0; level < 10; level += 1) deep = object({ child: deep });
  rejects(deep, /nesting_too_deep/);
  const unions: Record<string, unknown> = {};
  for (let index = 0; index < 17; index += 1) unions[`f${index}`] = { type: ["string", "null"] };
  rejects(object(unions), /too_many_unions/);
});

test("invalid constraint values and enums of complex values are rejected", () => {
  rejects(object({ a: { type: "string", pattern: "(" } }), /pattern_invalid/);
  rejects(object({ a: { type: "number", minimum: "0" } }), /minimum_not_number/);
  rejects(object({ a: { type: "array", items: { type: "string" }, maxItems: -1 } }), /maxItems_invalid/);
  rejects(object({ a: { enum: [{ x: 1 }] } }), /enum_complex_value/);
  rejects(object({ a: { type: "strin" } }), /type_invalid/);
});

test("Anthropic conversion strips numeric / length / array constraints, keeps pattern and minItems<=1, adds hints", () => {
  const original = structuredClone(SAMPLE_SCHEMA);
  const { schema, relaxed } = toProviderSchema("anthropic", SAMPLE_SCHEMA);
  assert.deepEqual(SAMPLE_SCHEMA, original, "input not modified");
  const props = schema.properties as Record<string, Record<string, unknown>>;
  assert.equal(props.title.minLength, undefined);
  assert.equal(props.title.maxLength, undefined);
  assert.equal(props.title.description, 'Short title [constraints: minLength=1, maxLength=20]');
  assert.equal(props.score.minimum, undefined);
  assert.equal(props.score.maximum, undefined);
  assert.equal(props.tags.minItems, 1, "minItems 1 is accepted by Anthropic");
  assert.equal(props.tags.maxItems, undefined);
  assert.equal(props.tags.uniqueItems, undefined);
  const detail = props.detail.properties as Record<string, Record<string, unknown>>;
  const note = (detail.note.anyOf as Record<string, unknown>[])[0];
  assert.equal(note.pattern, "^[a-z ]+$", "pattern is supported by Anthropic");
  assert.equal(detail.count.minimum, undefined);
  assert.deepEqual(schema.$defs, SAMPLE_SCHEMA.$defs);
  assert.deepEqual([...relaxed].sort(), [
    "/properties/detail/properties/count:minimum",
    "/properties/score:maximum",
    "/properties/score:minimum",
    "/properties/tags:maxItems",
    "/properties/tags:uniqueItems",
    "/properties/title:maxLength",
    "/properties/title:minLength",
  ]);
});

test("OpenAI conversion keeps its supported constraints and strips only length / uniqueItems", () => {
  const { schema, relaxed } = toProviderSchema("openai", SAMPLE_SCHEMA);
  const props = schema.properties as Record<string, Record<string, unknown>>;
  assert.equal(props.score.minimum, 0);
  assert.equal(props.score.maximum, 1);
  assert.equal(props.tags.maxItems, 3);
  assert.equal(props.title.maxLength, undefined);
  assert.deepEqual([...relaxed].sort(), ["/properties/tags:uniqueItems", "/properties/title:maxLength", "/properties/title:minLength"]);
});

test("Anthropic strips minItems above 1 and conversion is deterministic", () => {
  const schema = object({ list: { type: "array", items: { type: "string" }, minItems: 2 } });
  const first = toProviderSchema("anthropic", schema);
  const second = toProviderSchema("anthropic", schema);
  assert.deepEqual(first, second);
  const list = (first.schema.properties as Record<string, Record<string, unknown>>).list;
  assert.equal(list.minItems, undefined);
  assert.equal(list.description, "[constraints: minItems=2]");
});

test("conversion refuses an unsupported schema instead of sending it", () => {
  assert.throws(() => toProviderSchema("anthropic", object({ a: { type: "string", format: "date-time" } })), SchemaUnsupportedError);
  assert.throws(() => toProviderSchema("openai", object({ a: { allOf: [{ type: "string" }] } })), SchemaUnsupportedError);
});
