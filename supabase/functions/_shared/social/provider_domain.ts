// POSTONA provider-neutral domain (Phase 2a1): provider ids, structural capabilities and the contracts
// later X / Threads / Instagram adapters implement. Pure and import-free: no Edge Function imports it
// yet, so it changes no behavior. Mirrored for the app in
// apps/social-mobile/src/domain/provider-domain.ts; provider_domain_parity_test.ts keeps the two
// identical in values and types. Design: docs/postona/multi-social-phase1.md (sections 3 and 4).
//
// Capabilities are structural facts only. Commercial pricing and publishing quotas are deliberately not
// here: they change, some are inconsistent in the providers' own documentation, and they must not
// become runtime gates by accident.

export const PROVIDER_IDS = ["x", "threads", "instagram"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/** How a provider's credential is kept usable. Material itself never appears in these contracts. */
export const CREDENTIAL_PROFILES = ["oauth2_rotating_refresh", "long_lived_access"] as const;
export type CredentialProfile = (typeof CREDENTIAL_PROFILES)[number];

/** One create call, or a media container that must be ready before it is published. */
export const PUBLISH_FLOWS = ["single_call", "container_then_publish"] as const;
export type PublishFlow = (typeof PUBLISH_FLOWS)[number];

export type ProviderCapabilities = Readonly<{
  provider: ProviderId;
  /** A post may consist of text alone. */
  textOnly: boolean;
  /** Every post needs at least one media item. */
  mediaRequired: boolean;
  /** Media may be attached to a text post without being required. */
  optionalMedia: boolean;
  publishFlow: PublishFlow;
  credentialProfile: CredentialProfile;
  /** A successful publish returns a provider-side post id. */
  providerPostId: boolean;
  /** The provider API exposes a permalink for a published post. */
  providerPermalink: boolean;
}>;

export const PROVIDER_CAPABILITIES: Readonly<Record<ProviderId, ProviderCapabilities>> = Object.freeze({
  x: Object.freeze({
    provider: "x",
    textOnly: true,
    mediaRequired: false,
    optionalMedia: true,
    publishFlow: "single_call",
    credentialProfile: "oauth2_rotating_refresh",
    providerPostId: true,
    // The x.com/{user}/status/{id} form appears only in examples, not as an API field.
    providerPermalink: false,
  }),
  threads: Object.freeze({
    provider: "threads",
    textOnly: true,
    mediaRequired: false,
    optionalMedia: true,
    publishFlow: "container_then_publish",
    credentialProfile: "long_lived_access",
    providerPostId: true,
    providerPermalink: true,
  }),
  instagram: Object.freeze({
    provider: "instagram",
    textOnly: false,
    mediaRequired: true,
    optionalMedia: false,
    publishFlow: "container_then_publish",
    credentialProfile: "long_lived_access",
    providerPostId: true,
    providerPermalink: true,
  }),
});

/** Exact, case-sensitive match. Anything else is unknown and refused (fail closed). */
export function parseProviderId(value: unknown): ProviderId | null {
  return typeof value === "string" && (PROVIDER_IDS as readonly string[]).includes(value) ? (value as ProviderId) : null;
}

export function providerCapabilities(value: unknown): ProviderCapabilities | null {
  const provider = parseProviderId(value);
  return provider === null ? null : PROVIDER_CAPABILITIES[provider];
}

// --- Contracts (types only; no adapter exists yet) -------------------------------------------------

/** Who the connected account is on the provider. No token or credential field, by design. */
export type ConnectedAccountIdentity = Readonly<{
  provider: ProviderId;
  providerAccountId: string;
  handle?: string;
  displayName?: string;
}>;

/** Where usable credential material lives (e.g. Vault secret ids), never the material itself. */
export type CredentialRef = Readonly<{
  profile: CredentialProfile;
  accessRef: string;
  /** Only the rotating-refresh profile has a separate refresh credential. */
  refreshRef: string | null;
}>;

export const MEDIA_KINDS = ["image", "video"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];
export type MediaRef = Readonly<{ assetId: string; kind: MediaKind }>;

/**
 * One provider-specific delivery of a logical post. `targetId` is the idempotency key: retries and
 * reconciliation operate on a target, never on the logical post.
 */
export type PublicationTarget = Readonly<{
  targetId: string;
  provider: ProviderId;
  connectedAccountId: string;
  /** Text rendered for this provider when the target was created; not regenerated on retry. */
  renderedText: string;
  media: readonly MediaRef[];
  /** ISO-8601 timestamp; absent for an immediate (manual) publish. */
  scheduledAt?: string;
}>;

export const TARGET_SHAPE_REFUSALS = ["PROVIDER_UNSUPPORTED", "TEXT_ONLY_NOT_SUPPORTED", "MEDIA_NOT_SUPPORTED", "EMPTY_TARGET"] as const;
export type TargetShapeRefusal = (typeof TARGET_SHAPE_REFUSALS)[number];

/**
 * Structural check of a target against its provider's capabilities: unknown provider, text-only to a
 * media-required provider, media to a provider without media, or nothing at all. Length limits and
 * quotas are not checked here.
 */
export function checkTargetShape(target: Pick<PublicationTarget, "provider" | "renderedText" | "media">): TargetShapeRefusal | null {
  const capabilities = providerCapabilities(target.provider);
  if (capabilities === null) return "PROVIDER_UNSUPPORTED";
  const hasText = target.renderedText.trim() !== "";
  const hasMedia = target.media.length > 0;
  if (!hasText && !hasMedia) return "EMPTY_TARGET";
  if (hasMedia && !capabilities.mediaRequired && !capabilities.optionalMedia) return "MEDIA_NOT_SUPPORTED";
  if (!hasMedia && (capabilities.mediaRequired || !capabilities.textOnly)) return "TEXT_ONLY_NOT_SUPPORTED";
  return null;
}

/** The steps a publish takes for a flow, in order. */
export const PUBLISH_STEPS = ["prepare", "await_ready", "publish"] as const;
export type PublishStep = (typeof PUBLISH_STEPS)[number];
export function publishStepsFor(flow: PublishFlow): readonly PublishStep[] {
  return flow === "single_call" ? ["publish"] : ["prepare", "await_ready", "publish"];
}

/** A target prepared for publishing. For container flows the container id must be stored before publish. */
export type PreparedPublish =
  | Readonly<{ flow: "single_call"; targetId: string }>
  | Readonly<{ flow: "container_then_publish"; targetId: string; containerId: string }>;

export const CONTAINER_STATES = ["in_progress", "finished", "error", "expired", "published"] as const;
export type ContainerState = (typeof CONTAINER_STATES)[number];

export const PUBLISH_OUTCOME_KINDS = ["published", "rejected", "uncertain"] as const;
export type PublishOutcomeKind = (typeof PUBLISH_OUTCOME_KINDS)[number];

/**
 * published: the provider created the post. rejected: it provably did not (stable code). uncertain: it
 * may have (lost response, timeout, ambiguous status); the target needs reconciliation, not a resend.
 */
export type PublishOutcome =
  | Readonly<{ kind: "published"; targetId: string; providerPostId: string; permalink?: string }>
  | Readonly<{ kind: "rejected"; targetId: string; code: string }>
  | Readonly<{ kind: "uncertain"; targetId: string; code: string; containerId?: string }>;

/** Whether a target may be attempted again as-is. Only a proven rejection allows it. */
export function mayRetryTarget(outcome: PublishOutcome): boolean {
  return outcome.kind === "rejected";
}

export const CREDENTIAL_CHECKS = ["usable", "refreshed", "reauth_required", "uncertain"] as const;
export type CredentialCheck = (typeof CREDENTIAL_CHECKS)[number];

export const REVOKE_RESULTS = ["revoked", "not_supported", "failed"] as const;
export type RevokeResult = (typeof REVOKE_RESULTS)[number];

/** Connect a provider account for the signed-in owner (server side; secrets stay in the adapter). */
export interface ConnectAdapter {
  readonly provider: ProviderId;
  authorizationUrl(input: Readonly<{ state: string; codeChallenge: string; redirectUri: string }>): string;
  complete(
    input: Readonly<{ code: string; codeVerifier: string; redirectUri: string }>,
  ): Promise<Readonly<{ identity: ConnectedAccountIdentity; credential: CredentialRef }>>;
}

/** Keep an account's credential usable according to its profile. */
export interface CredentialAdapter {
  readonly provider: ProviderId;
  readonly profile: CredentialProfile;
  ensureUsable(credential: CredentialRef, now: Date): Promise<CredentialCheck>;
}

/** Publish one target. Single-call providers skip `awaitReady`. */
export interface PublishAdapter {
  readonly provider: ProviderId;
  readonly flow: PublishFlow;
  prepare(target: PublicationTarget, credential: CredentialRef): Promise<PreparedPublish | PublishOutcome>;
  awaitReady?(prepared: PreparedPublish, credential: CredentialRef): Promise<ContainerState>;
  publish(prepared: PreparedPublish, credential: CredentialRef): Promise<PublishOutcome>;
}

/** Disconnect an account and, where the provider allows, delete a published post. */
export interface DisconnectAdapter {
  readonly provider: ProviderId;
  revoke(credential: CredentialRef): Promise<RevokeResult>;
  deleteRemote?(providerPostId: string, credential: CredentialRef): Promise<RevokeResult>;
}
