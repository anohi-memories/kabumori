import type { Effort, NeutralRequest } from "./types.ts";

// Production builds OpenAI Responses API bodies. To compare vendors on EXACTLY the production prompt, those bodies are
// captured (capture.ts) and converted here into a provider-neutral request. No prompt text is copied into this repo
// area: when a production prompt changes, the next run simply picks the change up.

type Json = Record<string, unknown>;

export class NeutralConversionError extends Error {
  constructor(what: string) {
    super(`NEUTRAL_CONVERSION_FAILED:${what}`);
    this.name = "NeutralConversionError";
  }
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function effortOf(value: unknown): Effort | undefined {
  return value === "low" || value === "medium" || value === "high" ? value : undefined;
}

export function fromOpenAiResponsesBody(body: unknown, meta: { taskId: string; caseId: string }): NeutralRequest {
  if (!isObject(body)) throw new NeutralConversionError("body");
  const instructions = body.instructions;
  const input = body.input;
  if (typeof instructions !== "string" || instructions.length === 0) throw new NeutralConversionError("instructions");
  if (typeof input !== "string" || input.length === 0) throw new NeutralConversionError("input");
  const maxOutputTokens = body.max_output_tokens;
  if (typeof maxOutputTokens !== "number" || !Number.isInteger(maxOutputTokens) || maxOutputTokens < 1) {
    throw new NeutralConversionError("max_output_tokens");
  }

  const request: NeutralRequest = {
    taskId: meta.taskId,
    caseId: meta.caseId,
    system: instructions,
    user: input,
    maxOutputTokens,
  };

  const format = isObject(body.text) && isObject(body.text.format) ? body.text.format : null;
  if (format) {
    if (format.type !== "json_schema" || typeof format.name !== "string" || !isObject(format.schema)) {
      throw new NeutralConversionError("text.format");
    }
    request.schema = { name: format.name, schema: structuredClone(format.schema) };
  }

  const effort = isObject(body.reasoning) ? effortOf(body.reasoning.effort) : undefined;
  if (effort) request.effort = effort;

  if (Array.isArray(body.tools)) {
    const search = body.tools.find((tool) => isObject(tool) && tool.type === "web_search");
    if (search && isObject(search)) {
      const filters = isObject(search.filters) ? search.filters : null;
      const domains = filters && Array.isArray(filters.allowed_domains)
        ? filters.allowed_domains.filter((item): item is string => typeof item === "string")
        : undefined;
      request.webSearch = {
        ...(domains && domains.length > 0 ? { allowedDomains: domains } : {}),
        ...(typeof body.max_tool_calls === "number" ? { maxUses: body.max_tool_calls } : {}),
      };
    }
  }
  return request;
}
