/** H5-only handoff shape, NOT a deletion executor or claim of provider revoke.
 * G5 owns the actual T10 worker, fence and managed Auth deletion. */
export type ThreadsCustodyEvidence = Readonly<{
  localTokenCustody: "absent" | "present" | "unknown";
  remoteRevocation: "confirmed_with_provider_evidence" | "not_confirmed";
  providerEvidenceId?: string;
}>;
export function deletionReadiness(e: ThreadsCustodyEvidence) {
  // Local Vault absence alone never proves a remote token has been invalidated.
  return Object.freeze({
    localCustodyCleared: e.localTokenCustody === "absent",
    confirmedRemoteRevoked:
      e.remoteRevocation === "confirmed_with_provider_evidence" &&
      typeof e.providerEvidenceId === "string" &&
      e.providerEvidenceId.length > 0,
    owner: "G5" as const,
    entitlement: "x_autopost" as const,
    action: "await_reviewed_T10" as const,
  });
}
