// G4-06 (Issue #319): the adapter between G5's person verdict R1 and this flow's XConnectAuthorizationPort (G4-05).
// SOURCE CANDIDATE, offline: NOT wired (index.ts still passes `authorization: null`), no RPC client, no token, no network.
//
// R1 (G5-03 Draft PR #351 @ 59d3dff0, contract G5-02 PR #344): public.common_account_authorization_verdict(p_app,
// p_feature, p_brand_id) -> jsonb, the caller's own JWT. Its answer is the 8-key wire without times:
//   { v: 1, decision: allow|deny|unknown|pending, reason, scope: {app, feature, brand_slug},
//     subject: {kind:"user", user_id} | {kind:"system"}, session: {state, ref} | null,
//     owner_epoch: "g5oe:<epoch>:<lifecycle_version>" | null, entitlements: ["postona:x_autopost"] | [] }
// and the Edge classifies the HTTP status (G5-02 §3.8): 401/403 deny, 404 / any other non-200 / a body that is not exactly
// this wire for the question asked: unknown; a transport failure: unavailable. PROVISIONAL: H1's review of #351
// (Issue #306, CHANGES_REQUIRED P2 on W1/W2 only) did not change R1's wire, but G5 has not accepted a final version; a
// change there needs this file changed (the next K4).
//
// Decisions here, all fail-closed:
//   * only `allow` with exactly the wire, this app/feature/brand, this person, an active session reference, the owner-epoch
//     TOKEN (a string: "g5oe:" + two bigint-range decimals, no leading zero, never parsed into a JS number) and exactly the
//     x_autopost entitlement becomes an allow; the epoch handed to G4-05 is the token's decimal epoch text;
//   * `deny` for this person stays a deny (403 upstream); a deny about nobody, and pending / unknown / anything malformed,
//     is unknown (503 upstream);
//   * BEGIN: R1 requires a brand and the workspace is created BY begin, so R1 cannot be asked before it; the begin phase
//     answers unknown without calling R1 (X connect therefore cannot start through this adapter; the gap is G5's to
//     answer: a person-level question for x_connect, or a way to name the not-yet-created workspace). The brand id is not
//     derived here from the user id (that would re-implement SQL G4 does not own the decision for);
//   * every call asks R1 again; nothing is cached, so a replayed callback gets a fresh verdict.
import type { XConnectAuthorizationPort, XConnectAuthorizationRequest } from "./oauth_logic.ts";

export const X_CONNECT_R1_ADAPTER_WIRED = false;
export const R1_RPC_NAME = "common_account_authorization_verdict";
export const R1_WIRE_KEYS = "decision,entitlements,owner_epoch,reason,scope,session,subject,v";
export const R1_FEATURE = "x_connect";
const BIGINT_MAX = 9223372036854775807n;
const BRAND = /^[a-z][a-z0-9_-]{0,63}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const EPOCH_TOKEN = /^g5oe:([1-9][0-9]{0,18}):([1-9][0-9]{0,18})$/u;
const SESSION_REF = /^s:[0-9a-f]{32}$/u;
const REASON = /^[A-Z][A-Z0-9_]{1,63}$/u;

export type R1Question = Readonly<{ p_app: "postona"; p_feature: typeof R1_FEATURE; p_brand_id: string }>;
export type R1TransportResult = Readonly<{ status: number; body: unknown }>;
/** POST /rest/v1/rpc/common_account_authorization_verdict with the caller's own JWT (not implemented here). */
export type R1Transport = (question: R1Question, userAccessToken: string) => Promise<R1TransportResult>;

/** The G4-05 port's normalised shape. */
export type NormalisedVerdict = Readonly<{
  decision: "allow" | "deny" | "unknown";
  subjectUserId: string | null;
  brandId: string | null;
  ownerEpoch: string | null;
}>;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const keysAre = (v: Record<string, unknown>, keys: string) => Object.keys(v).sort().join(",") === keys;
const unknownFor = (brandId: string | null): NormalisedVerdict => Object.freeze({ decision: "unknown", subjectUserId: null, brandId, ownerEpoch: null });

/** "g5oe:<epoch>:<lifecycle>" -> the epoch's decimal text, or null. Both parts within bigint; never a JS number. */
export function ownerEpochFromToken(token: unknown): string | null {
  if (typeof token !== "string") return null;
  const m = EPOCH_TOKEN.exec(token);
  if (!m || BigInt(m[1]) > BIGINT_MAX || BigInt(m[2]) > BIGINT_MAX) return null;
  return m[1];
}

/** One R1 answer for (this person, this brand) -> the normalised verdict. Pure. */
export function decodeR1Answer(result: unknown, expected: Readonly<{ userId: string; brandId: string }>): NormalisedVerdict {
  const { userId, brandId } = expected;
  if (!isRecord(result) || !Number.isInteger(result.status)) return unknownFor(brandId);
  const status = result.status as number;
  if (status === 401 || status === 403) return Object.freeze({ decision: "deny", subjectUserId: userId, brandId, ownerEpoch: null });
  if (status !== 200) return unknownFor(brandId);
  const w = result.body;
  if (!isRecord(w) || !keysAre(w, R1_WIRE_KEYS) || w.v !== 1) return unknownFor(brandId);
  const scope = w.scope;
  if (!isRecord(scope) || !keysAre(scope, "app,brand_slug,feature") || scope.app !== "postona" || scope.feature !== R1_FEATURE || scope.brand_slug !== brandId) {
    return unknownFor(brandId);
  }
  const subject = w.subject;
  const aboutThisPerson = isRecord(subject) && keysAre(subject, "kind,user_id") && subject.kind === "user" && subject.user_id === userId;
  if (!Array.isArray(w.entitlements)) return unknownFor(brandId);

  if (w.decision === "deny") {
    if (!aboutThisPerson || typeof w.reason !== "string" || !REASON.test(w.reason)) return unknownFor(brandId);
    return Object.freeze({ decision: "deny", subjectUserId: userId, brandId, ownerEpoch: null });
  }
  if (w.decision !== "allow" || !aboutThisPerson || w.reason !== null) return unknownFor(brandId);
  const session = w.session;
  if (!isRecord(session) || !keysAre(session, "ref,state") || session.state !== "active" || typeof session.ref !== "string" || !SESSION_REF.test(session.ref)) {
    return unknownFor(brandId);
  }
  if (w.entitlements.length !== 1 || w.entitlements[0] !== "postona:x_autopost") return unknownFor(brandId);
  const ownerEpoch = ownerEpochFromToken(w.owner_epoch);
  if (ownerEpoch === null) return unknownFor(brandId);
  return Object.freeze({ decision: "allow", subjectUserId: userId, brandId, ownerEpoch });
}

class R1Timeout extends Error {}

/**
 * The G4-05 port over an R1 transport. Throws when the transport fails or exceeds `timeoutMs` (G4-05 answers 503
 * X_CONNECT_AUTHORIZATION_UNAVAILABLE); never returns an allow it did not decode.
 */
export function createXConnectR1AuthorizationPort(deps: Readonly<{ transport: R1Transport; timeoutMs?: number }>): XConnectAuthorizationPort {
  const timeoutMs = deps.timeoutMs ?? 3000;
  return async (request: XConnectAuthorizationRequest): Promise<NormalisedVerdict> => {
    if (request.phase !== "pre_exchange") return unknownFor(null); // begin: R1 needs the workspace begin creates
    if (typeof request.brandId !== "string" || !BRAND.test(request.brandId) || !UUID.test(request.userId)) return unknownFor(request.brandId);
    const question: R1Question = Object.freeze({ p_app: "postona", p_feature: R1_FEATURE, p_brand_id: request.brandId });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => deps.transport(question, request.userAccessToken)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new R1Timeout()), timeoutMs);
        }),
      ]);
      return decodeR1Answer(result, { userId: request.userId, brandId: request.brandId });
    } finally {
      clearTimeout(timer);
    }
  };
}
