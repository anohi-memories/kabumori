import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeSchemaForClaude, UnsupportedSchemaError } from "./schema.ts";
import { loadCases } from "./fixtures.ts";
import { buildTaskRequest } from "./tasks.ts";

const FORBIDDEN = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "maxItems"];

function keywordsIn(node: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(node)) node.forEach((item) => keywordsIn(item, found));
  else if (typeof node === "object" && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      found.add(key);
      keywordsIn(value, found);
    }
  }
  return found;
}

test("numeric bounds and maxItems are removed and moved into the description", () => {
  const input = {
    type: "object",
    properties: {
      confidence: { type: "number", minimum: 0, maximum: 1 },
      entities: { type: "array", items: { type: "string" }, minItems: 0, maxItems: 12 },
    },
    required: ["confidence", "entities"],
    additionalProperties: false,
  };
  const { schema, changes } = sanitizeSchemaForClaude(input);
  const props = (schema as { properties: Record<string, { description?: string }> }).properties;
  assert.match(props.confidence.description ?? "", /minimum: 0, maximum: 1/);
  assert.match(props.entities.description ?? "", /maxItems: 12/);
  assert.deepEqual(changes.map((c) => `${c.path}:${c.keyword}`).sort(), [
    "$.confidence:maximum", "$.confidence:minimum", "$.entities:maxItems",
  ]);
  assert.ok(![...keywordsIn(schema)].some((key) => FORBIDDEN.includes(key)));
});

test("what Claude does accept is kept: enum, required, additionalProperties false, minItems 0 and 1", () => {
  const input = {
    type: "object",
    properties: {
      level: { type: "string", enum: ["a", "b"] },
      a: { type: "array", items: { type: "string" }, minItems: 0 },
      b: { type: "array", items: { type: "string" }, minItems: 1 },
      c: { type: "array", items: { type: "string" }, minItems: 3 },
    },
    required: ["level"],
    additionalProperties: false,
  };
  const { schema, changes } = sanitizeSchemaForClaude(input);
  const props = (schema as { properties: Record<string, Record<string, unknown>>; required: string[] }).properties;
  assert.deepEqual(props.level.enum, ["a", "b"]);
  assert.equal(props.a.minItems, 0);
  assert.equal(props.b.minItems, 1);
  assert.equal(props.c.minItems, undefined);
  assert.equal((schema as { additionalProperties: boolean }).additionalProperties, false);
  assert.deepEqual((schema as { required: string[] }).required, ["level"]);
  assert.deepEqual(changes.map((c) => c.keyword), ["minItems"]);
});

test("the input schema is not mutated", () => {
  const input = { type: "object", properties: { n: { type: "number", maximum: 5 } }, additionalProperties: false };
  const before = JSON.stringify(input);
  sanitizeSchemaForClaude(input);
  assert.equal(JSON.stringify(input), before);
});

test("an object that allows extra properties cannot be expressed to Claude and is reported, not silently changed", () => {
  assert.throws(
    () => sanitizeSchemaForClaude({ type: "object", properties: {}, additionalProperties: true }),
    UnsupportedSchemaError,
  );
});

test("a property that happens to be NAMED like a keyword is not treated as one", () => {
  const { schema, changes } = sanitizeSchemaForClaude({
    type: "object",
    properties: { maximum: { type: "string" }, pattern: { type: "string" } },
    additionalProperties: false,
  });
  assert.deepEqual(Object.keys((schema as { properties: object }).properties), ["maximum", "pattern"]);
  assert.equal(changes.length, 0);
});

test("every production schema used by the comparison tasks becomes Claude-acceptable", async () => {
  const cases = await loadCases();
  for (const taskId of ["judgement_primary", "judgement_detail", "generation_draft", "generation_fact", "generation_voice"] as const) {
    const request = await buildTaskRequest(taskId, cases[0]);
    assert.ok(request?.schema, taskId);
    const { schema } = sanitizeSchemaForClaude(request.schema.schema);
    const used = keywordsIn(schema);
    for (const keyword of FORBIDDEN) assert.ok(!used.has(keyword), `${taskId} still has ${keyword}`);
  }
});
