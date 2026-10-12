// POSTONA Threads — how the connection (H5, Draft PR #139 on #135 / #124) and the manual publish (G4,
// PR #140 + this stack) compose, as a typed, testable contract. SOURCE ONLY: imported by tests, never by a
// deployed entry. It holds no credential and grants nothing.
//
// The chain, in order (every stage is its own authority decision; nothing earlier is trusted later):
//   1 actor          H5 verified actor: getClaims (signature) + getUser (Auth state) -> {userId, sessionId}
//   2 oauth_state    PR #124 begin (T13, workspace, Threads row, state) + H5 remember, over H5's owner transport
//   3 code_claim     H5 durable one-shot claim of the authorization code (burned before any Meta exchange)
//   4 exchange       PR #118 contract: code -> short -> long-lived token -> identity (Meta)
//   5 complete       ONE owner transaction: PR #124 complete (attested identity, Vault) + G4 custody
//                    (record_threads_credential_custody: the expiry of exactly that stored credential) +
//                    H5 outcome. The custody call is the one change H5's owner transport still needs.
//   6 permission     G4: the person explicitly allows manual posts to this account (owner/admin)
//   7 reserve        G4 begin: one attempt per tap, the exact text stored
//   8 release+write  G4 release (one attested transaction re-deciding everything, then the credential) ->
//                    Meta container -> record; again for check / publish / confirm
//   9 read_back      G4 confirm: the post read back with its id and permalink
//
// H5's connect receipt ({status:"connected", publishEnabled:false, tokenExpiresAt, socialAccountId}) is a
// RECEIPT for the screen, not an authority: publishing never reads it (stage 8 re-decides in the database).

export const THREADS_INTEGRATION_STAGES = [
  { id: "actor", owner: "H5", source: "PR #139 verified_actor.ts", needs: ["AUTH_GET_CLAIMS"] },
  { id: "oauth_state", owner: "G4 (PR #124) + H5", source: "PR #124 begin + PR #139 remember", needs: ["CONNECT_GATE", "OWNER_TRANSPORT", "T13_LIVE", "PHASE_2A2_APPLIED", "CONNECT_SQL_APPLIED"] },
  { id: "code_claim", owner: "H5", source: "PR #139 claim_candidate.sql", needs: ["OWNER_TRANSPORT", "CONNECT_SQL_APPLIED"] },
  { id: "exchange", owner: "H5 (PR #118 contract)", source: "PR #118 provider contract (kept unimported)", needs: ["META_APP", "CONNECT_SECRETS"] },
  { id: "complete", owner: "G4 (PR #124, custody) + H5", source: "PR #124 complete + custody + PR #139 outcome", needs: ["OWNER_TRANSPORT", "CUSTODY_WIRED", "CONNECT_SECRETS"] },
  { id: "permission", owner: "G4", source: "threads_manual_publish_candidate.sql", needs: ["PUBLISH_SQL_APPLIED", "T13_LIVE"] },
  { id: "reserve", owner: "G4", source: "threads_manual_publish_candidate.sql", needs: ["PUBLISH_SQL_APPLIED"] },
  { id: "release_write", owner: "G4", source: "threads_publish_release_candidate.sql + threads_publish_contract.ts", needs: ["PUBLISH_GATE", "PUBLISH_SQL_APPLIED", "PUBLISH_ATTESTATION_KEY", "META_APP"] },
  { id: "read_back", owner: "G4", source: "threads_publish_contract.ts", needs: ["PUBLISH_GATE", "META_APP"] },
] as const;
export type ThreadsIntegrationStage = (typeof THREADS_INTEGRATION_STAGES)[number]["id"];
export type ThreadsIntegrationRequirement = (typeof THREADS_INTEGRATION_STAGES)[number]["needs"][number];

/**
 * What is actually provisioned. Every field defaults to false; only a reviewed change or a verified
 * operator fact turns one true. Gates come from the static source flags, never from the environment.
 */
export type ThreadsIntegrationProbe = Readonly<Partial<Record<ThreadsIntegrationRequirement | "PILOT_APPROVED" | "INTEGRATED_REVIEW", boolean>>>;

/** The first stage that cannot run, and exactly what it is missing; null when the whole chain could run. */
export function firstUnavailableStage(probe: ThreadsIntegrationProbe):
  Readonly<{ stage: ThreadsIntegrationStage | "pilot"; missing: readonly string[] }> | null {
  for (const stage of THREADS_INTEGRATION_STAGES) {
    const missing = stage.needs.filter((need) => probe[need] !== true);
    if (missing.length > 0) return { stage: stage.id, missing };
  }
  const pilot = (["INTEGRATED_REVIEW", "PILOT_APPROVED"] as const).filter((need) => probe[need] !== true);
  return pilot.length > 0 ? { stage: "pilot", missing: pilot } : null;
}

// --- The connect receipt (H5) ---------------------------------------------------------------------------

export type ThreadsConnectReceipt = Readonly<{ socialAccountId: string; tokenExpiresAt: string }>;

/**
 * Accepts exactly H5's success receipt. `publishEnabled` must be false: a receipt that claims publishing
 * is enabled is not a receipt from this chain. The result is for display only.
 */
export function parseThreadsConnectReceipt(value: unknown, now: Date): ThreadsConnectReceipt | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  const keys = Object.keys(r).sort().join(",");
  if (keys !== "ok,provider,publishEnabled,socialAccountId,status,tokenExpiresAt") return null;
  if (r.ok !== true || r.status !== "connected" || r.provider !== "threads" || r.publishEnabled !== false) return null;
  if (typeof r.socialAccountId !== "string" || !/^sa_[0-9a-f]{24}$/.test(r.socialAccountId)) return null;
  if (typeof r.tokenExpiresAt !== "string") return null;
  const expires = Date.parse(r.tokenExpiresAt);
  // The long-lived token lasts at most ~60 days (the custody writer refuses beyond 61).
  if (!Number.isFinite(expires) || expires <= now.getTime() || expires > now.getTime() + 61 * 24 * 3600 * 1000) return null;
  return { socialAccountId: r.socialAccountId, tokenExpiresAt: new Date(expires).toISOString() };
}

// --- The one H5 change this stack needs ---------------------------------------------------------------

/**
 * The statements H5's owner transport must run, in this order, inside its existing `complete` transaction
 * (after `assert_actor`, the workspace lock and the claimed-attempt check it already performs). Only the
 * middle statement is new. Kept here as data so the integration smoke can assert the exact text.
 */
export const THREADS_COMPLETE_TRANSACTION_SQL = Object.freeze([
  "select public.complete_social_mobile_threads_oauth_connection($1::uuid,$2,$3,$4,$5)",
  "select public.record_threads_credential_custody($6,$7::timestamptz)",
  "select postona_threads_runtime.outcome($8,$9::uuid,$10::uuid,'complete',$7::timestamptz)",
]);
