// Runtime validation of a model's JSON output against the ORIGINAL schema (the one before provider conversion).
//
// A response is a result only if it parses AND passes this check: constrained decoding on the provider side is not
// trusted on its own, and constraints removed for a provider (schema.ts) are enforced here. The schema must have
// passed assertSchemaSupported; a keyword this validator does not know is reported as an issue, never skipped.
//
// Issues name a JSON pointer built from schema property names and array indexes, and the failing keyword. They
// never contain output values or unexpected key names, so they are safe to log.

import { CONSTRAINT_KEYWORDS, resolveLocalRef } from "./schema.ts";
import type { JsonSchema } from "./types.ts";

export type SchemaIssue = { readonly path: string; readonly keyword: string };

const KNOWN = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "anyOf",
  "$ref",
  "$defs",
  "definitions",
  "description",
  "title",
  "$comment",
  ...CONSTRAINT_KEYWORDS,
]);

export const MAX_SCHEMA_ISSUES = 20;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pointer(path: string, segment: string | number): string {
  return `${path}/${String(segment).replace(/~/gu, "~0").replace(/\//gu, "~1")}`;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return false;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
}

/** Unicode code points, the unit JSON Schema uses for string length. */
function codePointLength(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

function isMultipleOf(value: number, divisor: number): boolean {
  const quotient = value / divisor;
  return Math.abs(quotient - Math.round(quotient)) <= 1e-9 * Math.max(1, Math.abs(quotient));
}

type Context = { root: JsonSchema; issues: SchemaIssue[]; max: number; depth: number };

function add(context: Context, path: string, keyword: string): void {
  if (context.issues.length < context.max) context.issues.push({ path: path || "/", keyword });
}

function validateNode(value: unknown, schema: unknown, path: string, context: Context): void {
  if (context.issues.length >= context.max) return;
  if (!isRecord(schema)) {
    add(context, path, "invalid_schema");
    return;
  }
  if (context.depth > 64) {
    add(context, path, "too_deep");
    return;
  }
  for (const keyword of Object.keys(schema)) {
    if (!KNOWN.has(keyword)) add(context, path, "unsupported_keyword");
  }

  if ("$ref" in schema) {
    let target: JsonSchema;
    try {
      target = resolveLocalRef(context.root, schema.$ref, path);
    } catch {
      add(context, path, "$ref");
      return;
    }
    context.depth += 1;
    validateNode(value, target, path, context);
    context.depth -= 1;
  }

  if ("type" in schema) {
    const types = Array.isArray(schema.type) ? schema.type as unknown[] : [schema.type];
    if (!types.some((type) => typeof type === "string" && matchesType(value, type))) {
      add(context, path, "type");
      return;
    }
  }
  if ("enum" in schema && !(Array.isArray(schema.enum) && schema.enum.some((option) => deepEqual(option, value)))) add(context, path, "enum");
  if ("const" in schema && !deepEqual(schema.const, value)) add(context, path, "const");
  if ("anyOf" in schema) {
    const branches = Array.isArray(schema.anyOf) ? schema.anyOf : [];
    const matched = branches.some((branch) => {
      const probe: Context = { root: context.root, issues: [], max: 1, depth: context.depth + 1 };
      validateNode(value, branch, path, probe);
      return probe.issues.length === 0;
    });
    if (!matched) add(context, path, "anyOf");
  }

  if (typeof value === "string") {
    const length = "minLength" in schema || "maxLength" in schema ? codePointLength(value) : 0;
    if (typeof schema.minLength === "number" && length < schema.minLength) add(context, path, "minLength");
    if (typeof schema.maxLength === "number" && length > schema.maxLength) add(context, path, "maxLength");
    if (typeof schema.pattern === "string") {
      let matches = false;
      try {
        matches = new RegExp(schema.pattern, "u").test(value);
      } catch {
        matches = false;
      }
      if (!matches) add(context, path, "pattern");
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && !(value >= schema.minimum)) add(context, path, "minimum");
    if (typeof schema.maximum === "number" && !(value <= schema.maximum)) add(context, path, "maximum");
    if (typeof schema.exclusiveMinimum === "number" && !(value > schema.exclusiveMinimum)) add(context, path, "exclusiveMinimum");
    if (typeof schema.exclusiveMaximum === "number" && !(value < schema.exclusiveMaximum)) add(context, path, "exclusiveMaximum");
    if (typeof schema.multipleOf === "number" && !isMultipleOf(value, schema.multipleOf)) add(context, path, "multipleOf");
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) add(context, path, "minItems");
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) add(context, path, "maxItems");
    if (schema.uniqueItems === true) {
      const duplicate = value.some((item, index) => value.findIndex((other) => deepEqual(other, item)) !== index);
      if (duplicate) add(context, path, "uniqueItems");
    }
    if ("items" in schema) {
      context.depth += 1;
      value.forEach((item, index) => validateNode(item, schema.items, pointer(path, index), context));
      context.depth -= 1;
    }
  }

  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (typeof key === "string" && !Object.hasOwn(value, key)) add(context, pointer(path, key), "required");
    }
    if (schema.additionalProperties === false) {
      // The unexpected key's name comes from the model; report only that one exists.
      if (Object.keys(value).some((key) => !Object.hasOwn(properties, key))) add(context, path, "additionalProperties");
    } else if ("additionalProperties" in schema) {
      add(context, path, "unsupported_keyword");
    }
    context.depth += 1;
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) validateNode(value[key], child, pointer(path, key), context);
    }
    context.depth -= 1;
  }
}

/** Every way `value` breaks `schema` (at most MAX_SCHEMA_ISSUES). An empty list means the value is valid. */
export function validateAgainstSchema(value: unknown, schema: JsonSchema, max = MAX_SCHEMA_ISSUES): SchemaIssue[] {
  const context: Context = { root: schema, issues: [], max, depth: 0 };
  validateNode(value, schema, "", context);
  return context.issues;
}
