// What every provider adapter receives and returns. Adapters make exactly ONE HTTP attempt, never throw, and never
// retry: retries, budget and validation belong to execute.ts.

import type { ClassifiedError } from "./errors.ts";
import type { ModelSpec } from "./model_catalog.ts";
import type { ProviderApiKey } from "./secrets.ts";
import type { AiRequest, AiTokenUsage, JsonSchema } from "./types.ts";

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type AdapterCall = {
  readonly request: AiRequest;
  readonly spec: ModelSpec;
  /** The schema converted for this provider (schema.ts). */
  readonly providerSchema: JsonSchema;
  readonly key: ProviderApiKey;
  /** This attempt's timeout (the request timeout, shortened to fit the overall deadline). */
  readonly timeoutMs: number;
  readonly fetch: FetchLike;
  readonly nowMs: () => number;
};

export type AdapterOutcome =
  | {
    readonly ok: true;
    readonly text: string;
    readonly stopReason: string;
    /** null when the response did not carry readable usage (then the cost is charged at its upper bound). */
    readonly usage: AiTokenUsage | null;
    readonly actualModel: string | null;
    readonly requestId: string | null;
    readonly httpStatus: number;
  }
  | {
    readonly ok: false;
    readonly error: ClassifiedError;
    /** Known usage (a refusal or a cut-off output is billed), zero for a non-billed HTTP error, null if unknown. */
    readonly usage: AiTokenUsage | null;
    readonly actualModel: string | null;
    readonly requestId: string | null;
  };

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** A count from a provider usage object, or undefined when absent / malformed. */
export function countField(record: unknown, key: string): number | undefined {
  if (typeof record !== "object" || record === null) return undefined;
  const value = (record as Record<string, unknown>)[key];
  return isNonNegativeInteger(value) ? value : undefined;
}
