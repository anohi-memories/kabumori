export const AUTO_PUBLISH_CUTOVER_UNAVAILABLE = "NEWS_AUTO_PUBLISH_CUTOVER_UNAVAILABLE";
export const AUTO_PUBLISH_CUTOVER_BLOCKED = "NEWS_AUTO_PUBLISH_CUTOVER_BLOCKED";

/**
 * The settings row's updated_at is the existing, persisted cutover boundary.
 * A candidate must have been generated at or after that boundary before the
 * auto-publish path may select or claim it.
 */
export function isCandidateAfterAutoPublishCutover(
  generatedAt: string | null | undefined,
  cutoverAt: string | null | undefined,
): boolean {
  if (typeof generatedAt !== "string" || typeof cutoverAt !== "string") return false;
  const generatedMs = Date.parse(generatedAt);
  const cutoverMs = Date.parse(cutoverAt);
  return Number.isFinite(generatedMs) && Number.isFinite(cutoverMs) && generatedMs >= cutoverMs;
}
