import type {
  AiSubject,
  AnthropicModelPolicy,
  ExecuteDeps,
  JsonSchema,
} from "../ai_provider/mod.ts";
/** Server-owned registration. Never created from HTTP input or user metadata. */
export type ConsumerFeature = Readonly<{
  id: string;
  revision: string;
  policy: AnthropicModelPolicy;
  systemInstructions: string;
  schema: { name: string; schema: JsonSchema };
  maxInputBytes: number;
  maxResultBytes: number;
  maxTotalCostUsd: number;
  deadlineMs: number;
  /** Mandatory business/Fact check, including synthetic/source provenance when needed. No implicit pass. */
  validateFacts: (
    payload: unknown,
    input: string,
  ) => boolean | Promise<boolean>;
}>;
export type ConsumerRequest = Readonly<{
  feature: string;
  operationId: string;
  input: string;
  selection?: Readonly<
    { model?: string; effort?: string; maxOutputTokens?: number }
  >;
}>;
/** Only a trusted server verifier returns this; bridge never accepts subject/id from ConsumerRequest. */
export type AuthorizedConsumer = Readonly<
  { subject: AiSubject; expiresAtMs: number }
>;
export type Audit = Readonly<{
  callId: string;
  tenantTag: string;
  feature: string;
  role: string;
  model: string;
  policyVersion: string;
  attempts: number;
  estimatedCostUsd: number;
  costBasis: "measured" | "includes_upper_bound" | "no_request";
}>;
export type BridgeCode =
  | "REQUEST_INVALID"
  | "FEATURE_DENIED"
  | "AUTHORITY_DENIED"
  | "POLICY_DENIED"
  | "COST_DENIED"
  | "BUDGET_DENIED"
  | "OUTPUT_REJECTED"
  | "MODEL_UNAVAILABLE"
  | "PROVIDER_FAILED"
  | "UNKNOWN"
  | "IN_PROGRESS"
  | "CONTENT_DRIFT";
export type BridgeResult =
  | Readonly<{ ok: true; data: unknown; audit: Audit }>
  | Readonly<{ ok: false; code: BridgeCode; audit: Audit | null }>;
export type CallIdentity = Readonly<
  { key: string; tenantTag: string; fingerprint: string }
>;
export type CallClaim =
  | Readonly<{ kind: "acquired"; owner: string }>
  | Readonly<{ kind: "busy" | "conflict" }>
  | Readonly<{ kind: "complete"; fingerprint: string; result: BridgeResult }>;
/** MUST be durable/atomic across workers in live use. No expiration-based takeover of spent calls.
 * complete compares owner+identity atomically. Exception/response loss means UNKNOWN, never retry. */
export interface ConsumerCallStore {
  claim(identity: CallIdentity): Promise<CallClaim>;
  complete(
    identity: CallIdentity,
    owner: string,
    result: BridgeResult,
  ): Promise<void>;
}
export type ConsumerDeps = Readonly<{
  authorize: (
    credential: unknown,
    feature: string,
  ) => Promise<AuthorizedConsumer | null>;
  store: ConsumerCallStore;
  provider: ExecuteDeps & { fetch: NonNullable<ExecuteDeps["fetch"]> };
  nowMs?: () => number;
  /** Audit-safe counts/hashes ONLY. Hook exceptions cannot alter provider/result/ledger outcomes. */
  audit?: (
    event: Readonly<{ code: "OK" | BridgeCode; audit: Audit | null }>,
  ) => void;
}>;
