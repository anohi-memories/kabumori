// JSON Schema policy and provider conversion.
//
// One schema is written once by the caller and must work on either provider, so the accepted subset is the part
// both providers can take (directly or after conversion) AND that validate.ts can check locally:
//
//   structure : type (string or array of types), properties, required, additionalProperties: false, items, enum
//               (primitive values), const, anyOf, $ref to "#/$defs/..." or "#/definitions/...", $defs, definitions
//   annotation: description, title, $comment
//   constraint: minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf, minLength, maxLength, pattern,
//               minItems, maxItems, uniqueItems
//
// Rules for every object: additionalProperties must be false and `required` must list every property (OpenAI
// strict mode needs this; express an optional field as a union with null). The root must be an object. No
// recursion, at most 10 levels of object nesting and at most 16 union parameters (anyOf / type arrays).
// Anything else (allOf, oneOf, not, if/then/else, format, default, patternProperties, ...) is rejected with
// SchemaUnsupportedError before any request: a constraint we cannot verify locally must not be relied on.
//
// Provider conversion removes the constraints a provider does not accept, appends them to the field's description
// as a hint, and leaves the original schema untouched; the output is always validated against the ORIGINAL schema
// (validate.ts). Sources (read 2026-10-10):
//   - Anthropic structured outputs: numerical, string-length and array constraints beyond minItems 0/1 are not
//     supported (400 if sent); pattern and enum / const / anyOf / $ref are.
//   - OpenAI Structured Outputs: pattern, minimum / maximum / exclusive* / multipleOf, minItems / maxItems are
//     supported; minLength / maxLength are not listed; allOf, not, if/then/else, dependent* are not supported.

import type { AiProvider, JsonSchema } from "./types.ts";

export class SchemaUnsupportedError extends Error {
  readonly path: string;
  readonly reason: string;
  constructor(path: string, reason: string) {
    super(`SCHEMA_UNSUPPORTED:${reason}@${path || "/"}`);
    this.path = path;
    this.reason = reason;
  }
}

const STRUCTURE = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "const", "anyOf", "$ref", "$defs", "definitions"]);
const ANNOTATION = new Set(["description", "title", "$comment"]);
export const CONSTRAINT_KEYWORDS: readonly string[] = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
];
const CONSTRAINT = new Set(CONSTRAINT_KEYWORDS);
const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

export const MAX_OBJECT_NESTING = 10;
export const MAX_UNION_PARAMETERS = 16;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pointer(path: string, segment: string | number): string {
  return `${path}/${String(segment).replace(/~/gu, "~0").replace(/\//gu, "~1")}`;
}

/** Resolve a local reference ("#/$defs/name" or "#/definitions/name"). */
export function resolveLocalRef(root: JsonSchema, ref: unknown, path: string): JsonSchema {
  if (typeof ref !== "string") throw new SchemaUnsupportedError(path, "ref_not_string");
  const match = /^#\/(\$defs|definitions)\/([^/]+)$/u.exec(ref);
  if (!match) throw new SchemaUnsupportedError(path, "ref_not_local_definition");
  const defs = root[match[1]];
  const name = match[2].replace(/~1/gu, "/").replace(/~0/gu, "~");
  if (!isRecord(defs) || !isRecord(defs[name])) throw new SchemaUnsupportedError(path, "ref_target_missing");
  return defs[name] as JsonSchema;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function checkConstraint(keyword: string, value: unknown, path: string): void {
  switch (keyword) {
    case "minimum":
    case "maximum":
    case "exclusiveMinimum":
    case "exclusiveMaximum":
      if (typeof value !== "number" || !Number.isFinite(value)) throw new SchemaUnsupportedError(path, `${keyword}_not_number`);
      return;
    case "multipleOf":
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new SchemaUnsupportedError(path, "multipleOf_invalid");
      return;
    case "minLength":
    case "maxLength":
    case "minItems":
    case "maxItems":
      if (!isNonNegativeInteger(value)) throw new SchemaUnsupportedError(path, `${keyword}_invalid`);
      return;
    case "uniqueItems":
      if (typeof value !== "boolean") throw new SchemaUnsupportedError(path, "uniqueItems_invalid");
      return;
    case "pattern":
      if (typeof value !== "string") throw new SchemaUnsupportedError(path, "pattern_not_string");
      try {
        new RegExp(value, "u");
      } catch {
        throw new SchemaUnsupportedError(path, "pattern_invalid");
      }
      return;
  }
}

type Walk = { root: JsonSchema; unions: number; refStack: string[] };

function checkNode(node: unknown, path: string, objectDepth: number, walk: Walk): void {
  if (!isRecord(node)) throw new SchemaUnsupportedError(path, "subschema_not_object");
  for (const keyword of Object.keys(node)) {
    if (!STRUCTURE.has(keyword) && !ANNOTATION.has(keyword) && !CONSTRAINT.has(keyword)) {
      throw new SchemaUnsupportedError(path, `keyword_${keyword.replace(/[^A-Za-z0-9_$]/gu, "_").slice(0, 40)}`);
    }
    if (CONSTRAINT.has(keyword)) checkConstraint(keyword, node[keyword], path);
  }
  for (const keyword of ANNOTATION) {
    if (keyword in node && typeof node[keyword] !== "string") throw new SchemaUnsupportedError(path, `${keyword}_not_string`);
  }
  if (path !== "" && ("$defs" in node || "definitions" in node)) throw new SchemaUnsupportedError(path, "defs_not_at_root");

  if ("$ref" in node) {
    const ref = node.$ref as string;
    if (walk.refStack.includes(ref)) throw new SchemaUnsupportedError(path, "recursive_ref");
    const target = resolveLocalRef(walk.root, ref, path);
    walk.refStack.push(ref);
    checkNode(target, path, objectDepth, walk);
    walk.refStack.pop();
  }

  let types: string[] | null = null;
  if ("type" in node) {
    const raw = node.type;
    types = Array.isArray(raw) ? raw as string[] : [raw as string];
    if (types.length === 0 || types.some((type) => typeof type !== "string" || !TYPES.has(type))) {
      throw new SchemaUnsupportedError(path, "type_invalid");
    }
    if (new Set(types).size !== types.length) throw new SchemaUnsupportedError(path, "type_duplicate");
    if (Array.isArray(raw)) walk.unions += 1;
  }

  if ("enum" in node) {
    const values = node.enum;
    if (!Array.isArray(values) || values.length === 0) throw new SchemaUnsupportedError(path, "enum_invalid");
    if (values.some((value) => value !== null && !["string", "number", "boolean"].includes(typeof value))) {
      throw new SchemaUnsupportedError(path, "enum_complex_value");
    }
  }
  if ("const" in node) {
    const value = node.const;
    if (value !== null && !["string", "number", "boolean"].includes(typeof value)) throw new SchemaUnsupportedError(path, "const_complex_value");
  }

  if ("anyOf" in node) {
    const branches = node.anyOf;
    if (!Array.isArray(branches) || branches.length === 0) throw new SchemaUnsupportedError(path, "anyOf_invalid");
    walk.unions += 1;
    branches.forEach((branch, index) => checkNode(branch, pointer(pointer(path, "anyOf"), index), objectDepth, walk));
  }

  const isObject = types?.includes("object") || "properties" in node || "required" in node || "additionalProperties" in node;
  if (isObject) {
    const depth = objectDepth + 1;
    if (depth > MAX_OBJECT_NESTING) throw new SchemaUnsupportedError(path, "nesting_too_deep");
    if (node.additionalProperties !== false) throw new SchemaUnsupportedError(path, "additionalProperties_must_be_false");
    const properties = node.properties ?? {};
    if (!isRecord(properties)) throw new SchemaUnsupportedError(path, "properties_invalid");
    const required = node.required ?? [];
    if (!Array.isArray(required) || required.some((key) => typeof key !== "string")) throw new SchemaUnsupportedError(path, "required_invalid");
    const keys = Object.keys(properties);
    const requiredSet = new Set(required as string[]);
    if (requiredSet.size !== required.length) throw new SchemaUnsupportedError(path, "required_duplicate");
    if (keys.length !== requiredSet.size || keys.some((key) => !requiredSet.has(key))) {
      throw new SchemaUnsupportedError(path, "required_must_list_every_property");
    }
    for (const key of keys) checkNode(properties[key], pointer(pointer(path, "properties"), key), depth, walk);
  } else if ("properties" in node) {
    throw new SchemaUnsupportedError(path, "properties_without_object");
  }

  if ("items" in node) {
    if (Array.isArray(node.items)) throw new SchemaUnsupportedError(path, "tuple_items");
    checkNode(node.items, pointer(path, "items"), objectDepth, walk);
  }
}

/**
 * Throw SchemaUnsupportedError unless the schema is inside the supported subset (see the header). Run before any
 * request so a bad schema never costs a call.
 */
export function assertSchemaSupported(schema: JsonSchema): void {
  if (!isRecord(schema)) throw new SchemaUnsupportedError("", "schema_not_object");
  const rootTypes = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (rootTypes.length !== 1 || rootTypes[0] !== "object") throw new SchemaUnsupportedError("", "root_must_be_object");
  const walk: Walk = { root: schema, unions: 0, refStack: [] };
  for (const defsKey of ["$defs", "definitions"]) {
    const defs = schema[defsKey];
    if (defs === undefined) continue;
    if (!isRecord(defs)) throw new SchemaUnsupportedError(`/${defsKey}`, "defs_invalid");
    for (const [name, def] of Object.entries(defs)) {
      walk.refStack.push(`#/${defsKey}/${name}`);
      checkNode(def, pointer(`/${defsKey}`, name), 0, walk);
      walk.refStack.pop();
    }
  }
  walk.unions = 0;
  checkNode(schema, "", 0, walk);
  if (walk.unions > MAX_UNION_PARAMETERS) throw new SchemaUnsupportedError("", "too_many_unions");
}

/** Constraints each provider does not accept in its constrained-output schema. */
function strippedFor(provider: AiProvider, keyword: string, value: unknown): boolean {
  if (provider === "openai") return keyword === "minLength" || keyword === "maxLength" || keyword === "uniqueItems";
  if (keyword === "pattern") return false;
  if (keyword === "minItems") return typeof value === "number" && value > 1;
  return CONSTRAINT.has(keyword);
}

function convertNode(node: Record<string, unknown>, provider: AiProvider, relaxed: string[], path: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const removed: string[] = [];
  for (const [keyword, value] of Object.entries(node)) {
    if (CONSTRAINT.has(keyword) && strippedFor(provider, keyword, value)) {
      removed.push(`${keyword}=${JSON.stringify(value)}`);
      relaxed.push(`${path || "/"}:${keyword}`);
      continue;
    }
    if (keyword === "properties" && isRecord(value)) {
      out.properties = Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, convertNode(child as Record<string, unknown>, provider, relaxed, pointer(pointer(path, "properties"), key))]),
      );
    } else if ((keyword === "$defs" || keyword === "definitions") && isRecord(value)) {
      out[keyword] = Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, convertNode(child as Record<string, unknown>, provider, relaxed, pointer(`/${keyword}`, key))]),
      );
    } else if (keyword === "items" && isRecord(value)) {
      out.items = convertNode(value, provider, relaxed, pointer(path, "items"));
    } else if (keyword === "anyOf" && Array.isArray(value)) {
      out.anyOf = value.map((branch, index) => convertNode(branch as Record<string, unknown>, provider, relaxed, pointer(pointer(path, "anyOf"), index)));
    } else {
      out[keyword] = structuredClone(value);
    }
  }
  if (removed.length > 0) {
    const hint = `[constraints: ${removed.join(", ")}]`;
    out.description = typeof out.description === "string" && out.description !== "" ? `${out.description} ${hint}` : hint;
  }
  return out;
}

export type ProviderSchema = {
  /** The schema to send to the provider. */
  readonly schema: JsonSchema;
  /** "<json pointer>:<keyword>" of every constraint removed for the provider (still validated locally). */
  readonly relaxed: readonly string[];
};

/**
 * The provider-ready copy of a supported schema. The input is not modified. Removed constraints become a
 * description hint and are enforced afterwards by validating against the original schema.
 */
export function toProviderSchema(provider: AiProvider, schema: JsonSchema): ProviderSchema {
  assertSchemaSupported(schema);
  const relaxed: string[] = [];
  const converted = convertNode(schema as Record<string, unknown>, provider, relaxed, "");
  return { schema: converted, relaxed };
}

/** OpenAI / Anthropic accept these schema names (OpenAI's limit: letters, digits, _ and -, at most 64). */
export function isValidSchemaName(name: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/u.test(name);
}
