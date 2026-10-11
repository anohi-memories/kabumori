// E4 flow-expiry bound (Phase 3e, H2 E11 review R3). OFFLINE ONLY.
//
// The longest callback delay that still LINKED is a LOWER bound on the flow-state lifetime: a 600 s success says
// nothing about whether 900 s would also link. So a mitigation LABEL ("settle exceeds the measured expiry",
// "manual linking disabled") never qualifies A+B by itself. It qualifies only with an UPPER bound: the configured
// expiry of the pinned GoTrue version (project config or pinned source), a callback attempted after that expiry and
// refused, the request-duration maximum and a clock-skew margin on both sides, a settle time covering all of them,
// a verified drain of flows already started (disabling manual linking does not cancel started callbacks), and an
// exclusive final re-check -- in the order revoke sessions -> ban -> drain -> exclusive re-check -> Admin delete.

export const E4_REQUIRED_SEQUENCE = ['revoke_sessions', 'ban', 'drain', 'exclusive_recheck', 'admin_delete'] as const;

export interface E4BoundEvidence {
  /** GoTrue version recorded in E1 that the bound applies to. */
  gotrueVersion: string;
  /** Flow-state expiry from the project's configuration or the pinned source of that version: the UPPER bound. */
  configuredFlowExpirySeconds: number;
  configuredFlowExpirySource: 'project_config' | 'pinned_version_source';
  /** A callback attempted after the configured expiry, and whether GoTrue refused it. */
  expiredCallbackAttemptDelaySeconds: number;
  expiredCallbackRejected: boolean;
  /** The longest delay that still linked: a LOWER bound only, never used as the bound. */
  lastSuccessfulCallbackDelaySeconds?: number;
  /** api_max_request_duration recorded in E1. */
  requestDurationMaxSeconds: number;
  clockSkewMarginSeconds: number;
  settleSeconds: number;
  /** Flows / callbacks started before the ban were read back as finished or expired before the decision. */
  inFlightDrainVerified: boolean;
  /** The final decision re-checked identities under the exclusive login lock after the drain. */
  exclusiveRecheckVerified: boolean;
  sequence: readonly string[];
  evidence: string[];
}

const positive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;

/** Reasons the bound does not hold (empty = the mitigation is evidenced). */
export function evaluateE4Bound(bound: E4BoundEvidence | undefined): string[] {
  if (!bound) return ['E4_BOUND_MISSING'];
  const reasons: string[] = [];
  if (typeof bound.gotrueVersion !== 'string' || !/^v?\d+\.\d+\.\d+/u.test(bound.gotrueVersion)) reasons.push('E4_BOUND_VERSION_NOT_PINNED');
  if (bound.configuredFlowExpirySource !== 'project_config' && bound.configuredFlowExpirySource !== 'pinned_version_source') reasons.push('E4_BOUND_EXPIRY_SOURCE');
  for (const field of ['configuredFlowExpirySeconds', 'expiredCallbackAttemptDelaySeconds', 'requestDurationMaxSeconds', 'clockSkewMarginSeconds', 'settleSeconds'] as const) {
    if (!positive(bound[field])) reasons.push(`E4_BOUND_NOT_POSITIVE:${field}`);
  }
  if (positive(bound.configuredFlowExpirySeconds) && positive(bound.expiredCallbackAttemptDelaySeconds)
    && !(bound.expiredCallbackAttemptDelaySeconds > bound.configuredFlowExpirySeconds)) reasons.push('E4_BOUND_NO_CALLBACK_AFTER_EXPIRY');
  if (bound.expiredCallbackRejected !== true) reasons.push('E4_BOUND_EXPIRED_CALLBACK_NOT_REJECTED');
  if (positive(bound.lastSuccessfulCallbackDelaySeconds) && positive(bound.configuredFlowExpirySeconds)
    && bound.lastSuccessfulCallbackDelaySeconds > bound.configuredFlowExpirySeconds) reasons.push('E4_BOUND_CONTRADICTED_BY_OBSERVED_LINK');
  if (positive(bound.configuredFlowExpirySeconds) && positive(bound.requestDurationMaxSeconds) && positive(bound.clockSkewMarginSeconds) && positive(bound.settleSeconds)
    && bound.settleSeconds < bound.configuredFlowExpirySeconds + bound.requestDurationMaxSeconds + 2 * bound.clockSkewMarginSeconds) {
    reasons.push('E4_BOUND_SETTLE_TOO_SHORT');
  }
  if (bound.inFlightDrainVerified !== true) reasons.push('E4_BOUND_IN_FLIGHT_NOT_DRAINED');
  if (bound.exclusiveRecheckVerified !== true) reasons.push('E4_BOUND_NO_EXCLUSIVE_RECHECK');
  if (!Array.isArray(bound.sequence) || bound.sequence.join('>') !== E4_REQUIRED_SEQUENCE.join('>')) reasons.push('E4_BOUND_SEQUENCE');
  if (!Array.isArray(bound.evidence) || bound.evidence.length === 0) reasons.push('E4_BOUND_NO_EVIDENCE');
  return reasons;
}
