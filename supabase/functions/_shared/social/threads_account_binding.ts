// POSTONA Threads — the account-binding verdict between a finished OAuth connect and the posting ports. SOURCE
// CANDIDATE (G4-03, Issue #319): hard-disabled, read-only, wired to nothing; both of its inputs are injected ports
// that do not exist yet.
//
// Where it sits (each earlier stage already exists as a candidate and is NOT re-implemented here):
//   app        createThreadsConnectStarter (PR #251 stack): first return only, same signed-in person, in time
//   Edge       createThreadsConnectHandler (threads_connect_edge.ts): the wire receipt
//                {ok, status:"connected", provider:"threads", social_account_id, publish_enabled:false, token_expires_at}
//   runtime    H5 (PR #139/#159): verified actor + session-bound one-shot claim of the OAuth state and code
//   database   PR #124 complete: attested identity, the person's own workspace, single-use state, reconnect only
//              with the same Threads user id, an id connected elsewhere refused -> connection_status identity_verified
//   ports      G4-02 ThreadsCredentialPort / ThreadsSendPort (threads_send_port.ts) for G3's reservations
// What was missing is the step between the last two: when may a just-connected account be treated as BOUND for this
// person, this brand and this service, so the screen can say so and a later credential statement can rely on the same
// conditions? This module states those conditions as code:
//   gate open; G5's common POSTONA service key `x_autopost` (G4-10; any other key refused); a well-formed "connected"
//   receipt; the person
//   who started the connect is the person signed in now; the receipt came back before the OAuth state expired; exactly
//   one Threads row with that id, in the brand the connect was for, identity_verified with a credential and a
//   well-formed Threads user id; on a reconnect, the same Threads user as before; bound by this person; G5 says
//   allow for this principal, brand and service with an owner/admin role and a well-formed owner-epoch token; and BOTH
//   numbers recorded when the account was bound equal the token's (G4-08): the owner epoch (owner A -> B -> A never
//   revives a binding) and the owner's lifecycle_version, G5's service generation (a service ended and restarted since
//   the binding is a new period: G5-04 PR #358, no clock is compared). Both stay decimal text (g5_owner_epoch_token.ts).
//
// What it is NOT: an authority for a credential. The receipt is a receipt (threads_connect_publish_integration.ts);
// the credential port still needs ONE database statement that re-decides all of this together with the token and the
// generation (G4-02). PR #124 checks the same common key `x_autopost` (G4-10: that is G5's contract, not a borrowed X
// key) but records no owner epoch / lifecycle_version at binding: until the G4-09 SQL candidate (PR #367, unreviewed,
// not applied) is wired, a real binding always answers BIND_EPOCH_UNRECORDED. It never writes: a duplicate or replayed receipt gets the same verdict and changes nothing
// (the single-use state and code are the database's and H5's).
import { g5Decimal, parseG5OwnerEpochToken } from "./g5_owner_epoch_token.ts";
import { isSocialAccountId } from "./social_account_id.ts";
import { acceptableServiceKey, THREADS_POSTING_SERVICE_KEY } from "./threads_send_port.ts";

export const THREADS_ACCOUNT_BINDING_ENABLED = false;

export const THREADS_BINDING_REFUSALS = [
  "BINDING_DISABLED",
  "SERVICE_KEY_INVALID", // not G5's common POSTONA key (G4-10)
  "RECEIPT_INVALID", // not a "connected" receipt of the wire contract (a refused / uncertain connect is not a binding)
  "AUTH_REQUIRED",
  "PRINCIPAL_CHANGED", // signed in as someone else than the person who started the connect
  "STATE_EXPIRED",
  "ACCOUNT_UNAVAILABLE", // the read failed: nothing is assumed
  "ACCOUNT_NOT_FOUND",
  "ACCOUNT_AMBIGUOUS", // more than one row answered for one id
  "ACCOUNT_NOT_THREADS",
  "ACCOUNT_NOT_VERIFIED", // not identity_verified, no credential, or no well-formed Threads user id (disconnected)
  "BRAND_MISMATCH",
  "IDENTITY_CHANGED", // a reconnect brought another Threads user
  "BOUND_BY_OTHER_PRINCIPAL",
  "ENTITLEMENT_UNAVAILABLE", // G5's verdict could not be read
  "VERDICT_MISMATCH", // G5 answered about another principal, brand or service
  "SERVICE_NOT_ACTIVE", // G5: denied (not registered, ended, frozen, deleting, ...)
  "ROLE_INSUFFICIENT",
  "OWNER_EPOCH_UNKNOWN",
  "BIND_EPOCH_UNRECORDED",
  "OWNER_EPOCH_CHANGED",
  "SERVICE_GENERATION_CHANGED", // G4-08: the owner's lifecycle_version moved since the binding (ended and restarted)
] as const;
export type ThreadsBindingRefusal = (typeof THREADS_BINDING_REFUSALS)[number];

/** What the app flow knows about this connect (the starter's session at start, the state's expiry, the brand). */
export type ThreadsConnectFlowContext = Readonly<{
  startedByPrincipalId: string;
  currentPrincipalId: string | null;
  brandId: string;
  stateExpiresAtMs: number;
  receivedAtMs: number;
  /** On a reconnect: the Threads user id the account had before; null for a first connect. */
  previousThreadsUserId: string | null;
}>;

/** G4's read of the Threads account row (no SQL yet). Booleans and ids only; never a token or a Vault reference. */
export type ThreadsAccountRow = Readonly<{
  socialAccountId: string;
  brandId: string;
  platform: string;
  platformUserId: string | null;
  connectionStatus: string;
  hasAccessCredential: boolean;
  boundByPrincipalId: string | null;
  /** The two numbers of the R1 allow this binding was made under, as decimal text; PR #124 records neither yet. */
  bindOwnerEpoch: string | null;
  bindLifecycleVersion: string | null;
}>;

/** G5's verdict (G5-01 defines it; not implemented). */
export type G5PrincipalVerdict = Readonly<{
  principalId: string;
  brandId: string;
  serviceKey: string;
  verdict: "allow" | "deny";
  role: "owner" | "admin" | "member" | null;
  entitlementVersion: string;
  /** R1's owner_epoch: "g5oe:<epoch>:<lifecycle_version>" on allow, else null. */
  ownerEpochToken: string | null;
}>;

export type ThreadsBindingPorts = Readonly<{
  readThreadsAccount(socialAccountId: string): Promise<unknown>;
  principalVerdict(principalId: string, brandId: string, serviceKey: string): Promise<unknown>;
}>;

export type ThreadsAccountBinding = Readonly<{
  socialAccountId: string;
  brandId: string;
  threadsUserId: string;
  principalId: string;
  serviceKey: string;
  /** Decimal text (bigint range), never a JS number. */
  ownerEpoch: string;
  lifecycleVersion: string;
  entitlementVersion: string;
}>;
export type ThreadsBindingVerdict =
  | Readonly<{ ok: true; binding: ThreadsAccountBinding }>
  | Readonly<{ ok: false; code: ThreadsBindingRefusal }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const BRAND = /^[A-Za-z0-9_-]{1,128}$/u;
const THREADS_USER = /^[1-9][0-9]{0,31}$/u;
const VERSION = /^[A-Za-z0-9._:-]{1,128}$/u;
const refuse = (code: ThreadsBindingRefusal): ThreadsBindingVerdict => Object.freeze({ ok: false, code });

/** The account id of a "connected" wire receipt, or null. Exactly the Edge contract's keys; publishing still off. */
export function connectedReceiptAccountId(receipt: unknown): string | null {
  if (typeof receipt !== "object" || receipt === null || Array.isArray(receipt)) return null;
  const r = receipt as Record<string, unknown>;
  if (Object.keys(r).sort().join(",") !== "ok,provider,publish_enabled,social_account_id,status,token_expires_at") return null;
  if (r.ok !== true || r.status !== "connected" || r.provider !== "threads" || r.publish_enabled !== false) return null;
  if (typeof r.token_expires_at !== "string" || Number.isNaN(Date.parse(r.token_expires_at))) return null;
  return isSocialAccountId(r.social_account_id) ? r.social_account_id : null;
}

function accountRow(answer: unknown): ThreadsAccountRow | "none" | "many" | null {
  const rows = Array.isArray(answer) ? answer : answer === null ? [] : [answer];
  if (rows.length === 0) return "none";
  if (rows.length > 1) return "many";
  const r = rows[0] as Record<string, unknown>;
  if (typeof r !== "object" || r === null) return null;
  const okEpoch = (r.bindOwnerEpoch === null || typeof r.bindOwnerEpoch === "string") &&
    (r.bindLifecycleVersion === null || typeof r.bindLifecycleVersion === "string");
  if (
    typeof r.socialAccountId !== "string" || typeof r.brandId !== "string" || typeof r.platform !== "string" ||
    !(r.platformUserId === null || typeof r.platformUserId === "string") || typeof r.connectionStatus !== "string" ||
    typeof r.hasAccessCredential !== "boolean" || !(r.boundByPrincipalId === null || typeof r.boundByPrincipalId === "string") || !okEpoch
  ) return null;
  return r as unknown as ThreadsAccountRow;
}

function principalVerdict(answer: unknown): G5PrincipalVerdict | null {
  if (typeof answer !== "object" || answer === null || Array.isArray(answer)) return null;
  const v = answer as Record<string, unknown>;
  if (
    typeof v.principalId !== "string" || typeof v.brandId !== "string" || typeof v.serviceKey !== "string" ||
    (v.verdict !== "allow" && v.verdict !== "deny") ||
    !(v.role === null || v.role === "owner" || v.role === "admin" || v.role === "member") ||
    typeof v.entitlementVersion !== "string" || !VERSION.test(v.entitlementVersion) ||
    !(v.ownerEpochToken === null || typeof v.ownerEpochToken === "string")
  ) return null;
  return v as unknown as G5PrincipalVerdict;
}

/**
 * The verdict for one finished connect. `enabled` and `serviceKey` are the static gate and G5's key in production
 * (createThreadsAccountBinding below); tests pass them. Ports are touched only after every local check passed, the
 * account read before G5, and nothing is ever written.
 */
export async function decideThreadsAccountBinding(
  enabled: boolean,
  serviceKey: string | null,
  ports: ThreadsBindingPorts,
  receipt: unknown,
  flow: ThreadsConnectFlowContext,
): Promise<ThreadsBindingVerdict> {
  if (!enabled) return refuse("BINDING_DISABLED");
  if (!acceptableServiceKey(serviceKey)) return refuse("SERVICE_KEY_INVALID");
  const accountId = connectedReceiptAccountId(receipt);
  if (accountId === null) return refuse("RECEIPT_INVALID");
  if (!flow || !UUID.test(flow.startedByPrincipalId) || !BRAND.test(flow.brandId)) return refuse("RECEIPT_INVALID");
  if (flow.currentPrincipalId === null || !UUID.test(flow.currentPrincipalId)) return refuse("AUTH_REQUIRED");
  if (flow.currentPrincipalId !== flow.startedByPrincipalId) return refuse("PRINCIPAL_CHANGED");
  if (!Number.isFinite(flow.receivedAtMs) || !Number.isFinite(flow.stateExpiresAtMs) || flow.receivedAtMs > flow.stateExpiresAtMs) {
    return refuse("STATE_EXPIRED");
  }
  if (flow.previousThreadsUserId !== null && !THREADS_USER.test(flow.previousThreadsUserId)) return refuse("RECEIPT_INVALID");
  const principal = flow.currentPrincipalId;

  let row: ReturnType<typeof accountRow>;
  try {
    row = accountRow(await ports.readThreadsAccount(accountId));
  } catch {
    return refuse("ACCOUNT_UNAVAILABLE");
  }
  if (row === null) return refuse("ACCOUNT_UNAVAILABLE");
  if (row === "none") return refuse("ACCOUNT_NOT_FOUND");
  if (row === "many") return refuse("ACCOUNT_AMBIGUOUS");
  if (row.socialAccountId !== accountId) return refuse("ACCOUNT_NOT_FOUND");
  if (row.platform !== "threads") return refuse("ACCOUNT_NOT_THREADS");
  if (
    row.connectionStatus !== "identity_verified" || !row.hasAccessCredential || row.platformUserId === null ||
    !THREADS_USER.test(row.platformUserId)
  ) return refuse("ACCOUNT_NOT_VERIFIED");
  if (row.brandId !== flow.brandId) return refuse("BRAND_MISMATCH");
  if (flow.previousThreadsUserId !== null && row.platformUserId !== flow.previousThreadsUserId) return refuse("IDENTITY_CHANGED");
  if (row.boundByPrincipalId !== principal) return refuse("BOUND_BY_OTHER_PRINCIPAL");

  let verdict: G5PrincipalVerdict | null;
  try {
    verdict = principalVerdict(await ports.principalVerdict(principal, row.brandId, serviceKey));
  } catch {
    return refuse("ENTITLEMENT_UNAVAILABLE");
  }
  if (verdict === null) return refuse("ENTITLEMENT_UNAVAILABLE");
  if (verdict.principalId !== principal || verdict.brandId !== row.brandId || verdict.serviceKey !== serviceKey) {
    return refuse("VERDICT_MISMATCH");
  }
  if (verdict.verdict !== "allow") return refuse("SERVICE_NOT_ACTIVE");
  if (verdict.role !== "owner" && verdict.role !== "admin") return refuse("ROLE_INSUFFICIENT");
  const generation = parseG5OwnerEpochToken(verdict.ownerEpochToken);
  if (generation === null) return refuse("OWNER_EPOCH_UNKNOWN");
  const boundEpoch = g5Decimal(row.bindOwnerEpoch);
  const boundLifecycle = g5Decimal(row.bindLifecycleVersion);
  if (boundEpoch === null || boundLifecycle === null) return refuse("BIND_EPOCH_UNRECORDED");
  if (boundEpoch !== generation.ownerEpoch) return refuse("OWNER_EPOCH_CHANGED");
  if (boundLifecycle !== generation.lifecycleVersion) return refuse("SERVICE_GENERATION_CHANGED");

  return Object.freeze({
    ok: true,
    binding: Object.freeze({
      socialAccountId: accountId,
      brandId: row.brandId,
      threadsUserId: row.platformUserId,
      principalId: principal,
      serviceKey,
      ownerEpoch: generation.ownerEpoch,
      lifecycleVersion: generation.lifecycleVersion,
      entitlementVersion: verdict.entitlementVersion,
    }),
  });
}

/** The deployable form: closed by THREADS_ACCOUNT_BINDING_ENABLED (the key alone opens nothing). */
export function createThreadsAccountBinding(ports: ThreadsBindingPorts) {
  return (receipt: unknown, flow: ThreadsConnectFlowContext) =>
    decideThreadsAccountBinding(THREADS_ACCOUNT_BINDING_ENABLED, THREADS_POSTING_SERVICE_KEY, ports, receipt, flow);
}
