// Claude structured outputs (output_config.format, type json_schema) reject a few JSON-Schema keywords that the
// production OpenAI schemas use (numeric min/max, maxItems, ...), and answer 400. The comparison must send the SAME
// task to both vendors, so the schema is reduced to what Claude accepts and every removed constraint is moved into
// the field description (so the model still sees it) and reported (so a result can say what was relaxed).

type Json = Record<string, unknown>;

const REMOVED_KEYWORDS = [
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minLength", "maxLength", "maxItems", "pattern",
] as const;

export type SchemaChange = { path: string; keyword: string; value: unknown };

export class UnsupportedSchemaError extends Error {
  constructor(path: string, keyword: string) {
    super(`CLAUDE_SCHEMA_UNSUPPORTED:${path}:${keyword}`);
    this.name = "UnsupportedSchemaError";
  }
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function visit(node: unknown, path: string, changes: SchemaChange[]): unknown {
  if (Array.isArray(node)) return node.map((item, index) => visit(item, `${path}[${index}]`, changes));
  if (!isObject(node)) return node;
  const out: Json = {};
  const notes: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    if ((REMOVED_KEYWORDS as readonly string[]).includes(key) && !isObject(value)) {
      // `pattern` can be a property NAME inside `properties`; here the value is a primitive, so it is a keyword.
      changes.push({ path, keyword: key, value });
      notes.push(`${key}: ${String(value)}`);
      continue;
    }
    if (key === "minItems" && typeof value === "number" && value > 1) {
      changes.push({ path, keyword: key, value });
      notes.push(`minItems: ${value}`);
      continue;
    }
    if (key === "additionalProperties" && value !== false && node.type === "object") {
      throw new UnsupportedSchemaError(path, "additionalProperties");
    }
    out[key] = key === "properties" && isObject(value)
      ? Object.fromEntries(Object.entries(value).map(([name, child]) => [name, visit(child, `${path}.${name}`, changes)]))
      : visit(value, `${path}.${key}`, changes);
  }
  if (notes.length > 0) {
    const existing = typeof out.description === "string" && out.description.length > 0 ? `${out.description} ` : "";
    out.description = `${existing}(constraints not enforced by the API: ${notes.join(", ")})`;
  }
  return out;
}

export function sanitizeSchemaForClaude(schema: Json): { schema: Json; changes: SchemaChange[] } {
  const changes: SchemaChange[] = [];
  const result = visit(structuredClone(schema), "$", changes) as Json;
  return { schema: result, changes };
}
