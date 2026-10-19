// G6 runtime candidate (2026-10-19, G6-01): the composition that turns the PR302 gateway core into something a
// server can call. It wires, with nothing else:
//   - the shared provider (executeAiRequest through the real OpenAI / Anthropic adapters), reading ONLY the provider
//     key environment names;
//   - the ledger (the real SupabaseLedgerBudgetGuard): the source of truth for usage and cost;
//   - the call store (SupabaseAiCallsStore over the ai_calls RPCs): idempotency per operation;
//   - the authority (G5's verdict / recheck): an injected port; nothing here derives identity or ownership;
//   - the apps' feature policies (a registry checked at startup).
// NOT deployed and not wired into any app: supabase/ai_gateway/ is outside supabase/functions. Deploying it needs the
// provider module's import allowlist widened (a shared security boundary): see
// docs/ai-provider/G6_AI_GATEWAY_RUNTIME_SOURCE.md. It uses no runtime-specific API, writes no logs and reads no environment of its own.
import type { FetchLike } from "../functions/_shared/ai_provider/adapter.ts";
import { type EnvReader, PROVIDER_API_KEY_ENV, type RetryTiming, SupabaseLedgerBudgetGuard } from "../functions/_shared/ai_provider/mod.ts";
import { SecretValue } from "../functions/_shared/ai_provider/secrets.ts";
import { SupabaseAiCallsStore, supabaseUrlAllowed } from "./ai_calls_store.ts";
import { type AuthorityPort, gatewayExecute, type GatewayResult, type PolicyRegistry } from "./gateway.ts";
import { isDefinedRegistry } from "./policy_registry.ts";

export type AiGatewayOptions = Readonly<{
  supabaseUrl: string;
  /**
   * The server-side secret key for the ledger and ai_calls RPCs. A legacy JWT key (service_role "eyJ...") is refused;
   * on a real project only a secret key ("sb_secret_...") is accepted.
   */
  serviceKey: SecretValue;
  /** Environment reader; the runtime asks it only for the provider key names (PROVIDER_API_KEY_ENV). */
  readEnv: EnvReader;
  authority: AuthorityPort;
  /** Built by definePolicyRegistry (checked and frozen); anything else is refused. */
  policies: PolicyRegistry;
  fetch?: FetchLike;
  /** Ledger hold for an unsent reservation (30..3600 s, default 900). */
  holdSeconds?: number;
  /** Per ledger / call store RPC (default 10 s). */
  rpcTimeoutMs?: number;
  nowMs?: () => number;
  retryTiming?: RetryTiming;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}>;

export type AiGateway = Readonly<{ execute(credential: unknown, request: unknown): Promise<GatewayResult> }>;

export class AiGatewayConfigError extends Error {
  constructor(reason: string) {
    super(`AI_GATEWAY_CONFIG_INVALID:${reason}`);
  }
}

const PROVIDER_KEY_NAMES: readonly string[] = Object.values(PROVIDER_API_KEY_ENV);
const LEGACY_JWT = /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/u;

function isLoopback(supabaseUrl: string): boolean {
  const url = new URL(supabaseUrl);
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
}

/** Build the gateway. Every configuration problem throws here, before any request can be made. */
export function createAiGateway(options: AiGatewayOptions): AiGateway {
  if (!supabaseUrlAllowed(options.supabaseUrl)) throw new AiGatewayConfigError("supabase_url");
  if (!(options.serviceKey instanceof SecretValue)) throw new AiGatewayConfigError("service_key_type");
  const key = options.serviceKey.reveal();
  if (key.startsWith("eyJ") || LEGACY_JWT.test(key)) throw new AiGatewayConfigError("legacy_service_key");
  if (!isLoopback(options.supabaseUrl) && !key.startsWith("sb_secret_")) throw new AiGatewayConfigError("service_key_kind");
  if (typeof options.readEnv !== "function") throw new AiGatewayConfigError("read_env");
  if (!options.authority || typeof options.authority.verdict !== "function" || typeof options.authority.recheck !== "function") {
    throw new AiGatewayConfigError("authority");
  }
  if (!isDefinedRegistry(options.policies)) throw new AiGatewayConfigError("policies");

  const outerReadEnv = options.readEnv;
  // Least privilege: the provider layer may read the provider keys and nothing else.
  const readEnv: EnvReader = (name) => (PROVIDER_KEY_NAMES.includes(name) ? outerReadEnv(name) : undefined);
  const budget = new SupabaseLedgerBudgetGuard({
    supabaseUrl: options.supabaseUrl,
    serviceKey: options.serviceKey,
    fetch: options.fetch,
    holdSeconds: options.holdSeconds,
    rpcTimeoutMs: options.rpcTimeoutMs,
  });
  const store = new SupabaseAiCallsStore({
    supabaseUrl: options.supabaseUrl,
    serviceKey: options.serviceKey,
    fetch: options.fetch,
    rpcTimeoutMs: options.rpcTimeoutMs,
  });
  const deps = Object.freeze({
    authority: options.authority,
    policies: options.policies,
    provider: {
      readEnv,
      fetch: options.fetch,
      retryTiming: options.retryTiming,
      sleep: options.sleep,
      random: options.random,
    },
    budget,
    store,
    nowMs: options.nowMs,
  });
  return Object.freeze({ execute: (credential: unknown, request: unknown) => gatewayExecute(deps, credential, request) });
}
