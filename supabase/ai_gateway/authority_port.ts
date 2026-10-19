// G6 runtime candidate (2026-10-19, G6-02): the gateway's AuthorityPort over G5's verdict. G5 (shared account /
// auth / entitlement owner) decides who the caller is, whether the session is live, who owns the brand (the F5 owner
// epoch) and which service entitlements are active. G6 does NOT judge any of that: it converts G5's answer STRICTLY
// (anything unexpected is "unknown", never "allow") and applies only the AI plan rule it owns: which entitlements may
// open which AI feature (the planAllowlist from buildAppPolicySet).
//
// G5's transport is injected (fetchVerdict / fetchRecheck): no G5 RPC, endpoint or table is assumed to exist. The
// wire shape below is the PROPOSAL G6 needs from G5 (docs/ai-provider/G6_APP_POLICY_AUTHORITY_PORT.md):
//   { v: 1, decision: "allow"|"deny"|"unknown"|"pending", reason: string|null,
//     scope: { app, feature, brand_slug: string|null },
//     subject: { kind: "user", user_id: uuid } | { kind: "system" },
//     session: { state: "active"|"revoked"|"expired"|"unknown", ref: string } | null,   (null only for system)
//     owner_epoch: string|null,                (required when scope.brand_slug is set; opaque, e.g. F5's bigint epoch)
//     entitlements: string[],                  ("<app>:<service>", active ones only)
//     issued_at_ms: number, expires_at_ms: number }
import type { AppId, AuthorityPort, AuthVerdict, BrandRef, GatewaySubject } from "./gateway.ts";

export type VerdictScope = Readonly<{ app: AppId; feature: string; brand: BrandRef | null }>;
export type G5Transport = Readonly<{
  /** G5's verdict for this credential and scope (the wire object above). Throws when G5 cannot be reached. */
  fetchVerdict(credential: unknown, scope: VerdictScope): Promise<unknown>;
  /** G5's fresh verdict for the same subject and scope, asked right before each provider attempt. */
  fetchRecheck(scope: VerdictScope, subject: Readonly<{ kind: "user"; userId: string } | { kind: "system" }>): Promise<unknown>;
}>;
export type G5AuthorityOptions = Readonly<{
  transport: G5Transport;
  /** app:feature -> the entitlements that open it for a person (AppPolicySet.planAllowlist). */
  planAllowlist: ReadonlyMap<string, readonly string[]>;
  nowMs?: () => number;
  /** Longest verdict lifetime accepted (default 300 000 ms, at most 900 000). */
  maxTtlMs?: number;
  /** Clock skew tolerated on issued_at_ms (default 30 000 ms). */
  skewMs?: number;
  /** Per G5 call (default 3 000 ms); a slower answer counts as unreachable. */
  timeoutMs?: number;
}>;

const WIRE_KEYS = "decision,entitlements,expires_at_ms,issued_at_ms,owner_epoch,reason,scope,session,subject,v";
const USER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/u;
const ENTITLEMENT = /^[a-z][a-z0-9_]{0,31}:[a-z][a-z0-9_]{0,63}$/u;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const keysAre = (v: Record<string, unknown>, keys: string) => Object.keys(v).sort().join(",") === keys;
const finiteInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

async function sha256(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => timer = setTimeout(() => reject(new Error("G5_TIMEOUT")), ms));
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

type Parsed = Readonly<{ verdict: AuthVerdict; subjectRef: Readonly<{ kind: "user"; userId: string } | { kind: "system" }> }>;

/** The G5 port. verdict() and recheck() never return "allow" unless every rule below holds. */
export function createG5AuthorityPort(options: G5AuthorityOptions): AuthorityPort {
  const now = options.nowMs ?? (() => Date.now());
  const maxTtl = options.maxTtlMs ?? 300_000;
  if (!Number.isInteger(maxTtl) || maxTtl < 1_000 || maxTtl > 900_000) throw new Error("G5_PORT_MAX_TTL_INVALID");
  const skew = options.skewMs ?? 30_000;
  if (!Number.isInteger(skew) || skew < 0 || skew > 120_000) throw new Error("G5_PORT_SKEW_INVALID");
  const timeoutMs = options.timeoutMs ?? 3_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) throw new Error("G5_PORT_TIMEOUT_INVALID");
  const scopes = new WeakMap<AuthVerdict, Readonly<{ scope: VerdictScope; subjectRef: Parsed["subjectRef"] }>>();

  /** An answer that is not "allow": the subject is the requested scope's, so the gateway's checks stay meaningful. */
  const refuse = (scope: VerdictScope, decision: "deny" | "unknown" | "pending", reason: string): AuthVerdict => ({
    decision,
    subject: { kind: "system", app: scope.app },
    generation: "refused",
    expiresAtMs: 0,
    reason,
  });

  async function parse(wire: unknown, scope: VerdictScope): Promise<Parsed | AuthVerdict> {
    if (!isRecord(wire) || !keysAre(wire, WIRE_KEYS) || wire.v !== 1) return refuse(scope, "unknown", "WIRE_SHAPE");
    const { decision, reason, scope: s, subject, session, owner_epoch, entitlements, issued_at_ms, expires_at_ms } = wire;
    if (decision !== "allow" && decision !== "deny" && decision !== "unknown" && decision !== "pending") return refuse(scope, "unknown", "WIRE_DECISION");
    if (!(reason === null || (typeof reason === "string" && TOKEN.test(reason)))) return refuse(scope, "unknown", "WIRE_REASON");
    if (decision !== "allow") return refuse(scope, decision, typeof reason === "string" ? reason : `G5_${String(decision).toUpperCase()}`);
    // The scope G5 answered for must be exactly the one asked (app, feature, brand).
    if (!isRecord(s) || !keysAre(s, "app,brand_slug,feature") || s.app !== scope.app || s.feature !== scope.feature ||
      s.brand_slug !== (scope.brand ? scope.brand.slug : null)) return refuse(scope, "unknown", "SCOPE_MISMATCH");
    if (!finiteInt(issued_at_ms) || !finiteInt(expires_at_ms)) return refuse(scope, "unknown", "WIRE_TIME");
    const t = now();
    if (issued_at_ms > t + skew) return refuse(scope, "unknown", "ISSUED_IN_FUTURE");
    if (!(expires_at_ms > t)) return refuse(scope, "deny", "EXPIRED");
    if (expires_at_ms - issued_at_ms > maxTtl) return refuse(scope, "unknown", "TTL_TOO_LONG");
    if (!Array.isArray(entitlements) || entitlements.length > 32 || new Set(entitlements).size !== entitlements.length ||
      !entitlements.every((e) => typeof e === "string" && ENTITLEMENT.test(e))) return refuse(scope, "unknown", "WIRE_ENTITLEMENTS");
    const key = `${scope.app}:${scope.feature}`;
    const plan = options.planAllowlist.get(key);
    if (!plan) return refuse(scope, "deny", "FEATURE_NOT_ENABLED");

    let gatewaySubject: GatewaySubject;
    let subjectRef: Parsed["subjectRef"];
    let sessionRef = "-";
    if (isRecord(subject) && subject.kind === "system" && keysAre(subject, "kind")) {
      if (session !== null || owner_epoch !== null || scope.brand !== null) return refuse(scope, "unknown", "SYSTEM_SHAPE");
      gatewaySubject = { kind: "system", app: scope.app };
      subjectRef = { kind: "system" };
    } else if (isRecord(subject) && subject.kind === "user" && keysAre(subject, "kind,user_id") && typeof subject.user_id === "string" && USER_ID.test(subject.user_id)) {
      if (!isRecord(session) || !keysAre(session, "ref,state") || typeof session.ref !== "string" || !TOKEN.test(session.ref)) return refuse(scope, "unknown", "SESSION_SHAPE");
      if (session.state !== "active") return refuse(scope, "deny", `SESSION_${String(session.state).toUpperCase().slice(0, 16)}`);
      if (scope.brand && !(typeof owner_epoch === "string" && TOKEN.test(owner_epoch))) return refuse(scope, "unknown", "OWNER_EPOCH_MISSING");
      if (!scope.brand && owner_epoch !== null) return refuse(scope, "unknown", "OWNER_EPOCH_WITHOUT_BRAND");
      // The AI plan rule (G6): at least one entitlement G5 says is active must open this feature.
      if (!entitlements.some((e) => plan.includes(e as string))) return refuse(scope, "deny", "PLAN_NOT_ALLOWED");
      gatewaySubject = { kind: "user", app: scope.app, userId: subject.user_id, brand: scope.brand };
      subjectRef = { kind: "user", userId: subject.user_id };
      sessionRef = session.ref;
    } else return refuse(scope, "unknown", "SUBJECT_SHAPE");

    // The generation changes when the owner epoch, the session or the plan-relevant entitlements change, so the
    // gateway's recheck stops the send on any of them.
    const planEntitlements = (entitlements as string[]).filter((e) => plan.includes(e)).sort();
    const generation = "g5v1:" + await sha256(JSON.stringify([owner_epoch, sessionRef, planEntitlements]));
    return { verdict: { decision: "allow", subject: gatewaySubject, generation, expiresAtMs: expires_at_ms }, subjectRef };
  }

  return Object.freeze({
    async verdict(credential: unknown, scope: VerdictScope): Promise<AuthVerdict> {
      // A feature no plan opens is refused without asking G5 (Miseiro, disabled or undeclared features).
      if (!options.planAllowlist.has(`${scope.app}:${scope.feature}`)) return refuse(scope, "deny", "FEATURE_NOT_ENABLED");
      const wire = await withTimeout(options.transport.fetchVerdict(credential, scope), timeoutMs); // throws -> AUTH_UNAVAILABLE
      const parsed = await parse(wire, scope);
      if (!("subjectRef" in parsed)) return parsed;
      scopes.set(parsed.verdict, { scope, subjectRef: parsed.subjectRef });
      return parsed.verdict;
    },
    async recheck(prior: AuthVerdict): Promise<AuthVerdict> {
      const known = scopes.get(prior);
      if (!known) return refuse({ app: prior.subject.app, feature: "-", brand: null }, "unknown", "RECHECK_UNKNOWN_VERDICT");
      const wire = await withTimeout(options.transport.fetchRecheck(known.scope, known.subjectRef), timeoutMs);
      const parsed = await parse(wire, known.scope);
      return "subjectRef" in parsed ? parsed.verdict : parsed;
    },
  });
}
