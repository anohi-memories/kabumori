import { BrandContextError } from "./brand_context.ts";
import type { BrandPostDraft } from "./brand_post_generator.ts";

export type AiLabEngagementMode =
  | "regular"
  | "experience"
  | "opinion"
  | "choices";
export type AiLabEngagementDraft = BrandPostDraft & {
  engagementMode?: AiLabEngagementMode;
  pollOptions?: string[];
};
export type AiLabEngagementViolation =
  | "ENGAGEMENT_TOO_LONG"
  | "ENGAGEMENT_TOO_MANY_LINES"
  | "ENGAGEMENT_INVALID_MODE"
  | "POLL_INVALID_STRUCTURE"
  | "POLL_INVALID_OPTIONS"
  | "POLL_UNEXPECTED_OPTIONS"
  | "POLL_OPTIONS_IN_TEXT";

export const AI_LAB_ENGAGEMENT_MAX_CHARACTERS = 120;
export const AI_LAB_ENGAGEMENT_MAX_LINES = 4;

/** A malformed generated poll can be corrected within the existing bounded content retry loop. */
export class AiLabEngagementGenerationError extends Error {
  readonly violation: AiLabEngagementViolation = "POLL_INVALID_STRUCTURE";
  constructor() {
    super("AI_LAB_POLL_INVALID_STRUCTURE");
    this.name = "AiLabEngagementGenerationError";
  }
}

export function collectAiLabEngagementViolations(
  draft: AiLabEngagementDraft,
): AiLabEngagementViolation[] {
  const violations: AiLabEngagementViolation[] = [];
  const mode = draft.engagementMode;
  if (
    mode !== undefined &&
    !["regular", "experience", "opinion", "choices"].includes(mode)
  ) {
    return ["ENGAGEMENT_INVALID_MODE"];
  }
  if (mode && mode !== "regular") {
    if (Array.from(draft.text).length > AI_LAB_ENGAGEMENT_MAX_CHARACTERS) {
      violations.push("ENGAGEMENT_TOO_LONG");
    }
    if (draft.text.split(/\r\n|\r|\n/u).length > AI_LAB_ENGAGEMENT_MAX_LINES) {
      violations.push("ENGAGEMENT_TOO_MANY_LINES");
    }
  }
  if (mode !== "choices") {
    if (draft.pollOptions !== undefined) {
      violations.push("POLL_UNEXPECTED_OPTIONS");
    }
    return violations;
  }
  const options: unknown = draft.pollOptions;
  if (
    !Array.isArray(options) || options.length < 2 || options.length > 4 ||
    options.some((option) =>
      typeof option !== "string" || !option.trim() ||
      option !== option.trim() || Array.from(option).length > 25 ||
      Array.from(option).some((char) =>
        char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127
      )
    )
  ) {
    violations.push("POLL_INVALID_OPTIONS");
  } else {
    const normalized = options.map((option: string) =>
      option.normalize("NFKC").toLowerCase()
    );
    if (new Set(normalized).size !== options.length) {
      violations.push("POLL_INVALID_OPTIONS");
    }
  }
  if (/^\s*(?:[A-D][.．)）:：]|[①②③④])/mu.test(draft.text)) {
    violations.push("POLL_OPTIONS_IN_TEXT");
  }
  return violations;
}

export function assertAiLabEngagementAllowed(
  draft: AiLabEngagementDraft,
): void {
  if (collectAiLabEngagementViolations(draft).length > 0) {
    throw new BrandContextError("AI_LAB_ENGAGEMENT_INVALID");
  }
}
