/**
 * Generic post-length policy for future app-managed settings.
 *
 * Counting rule: JavaScript Unicode code points (`Array.from(text).length`). A surrogate-pair
 * character such as 😀 counts as one. This is deterministic but is not X's weighted-length rule.
 */
export type PostLengthPolicy =
  | { mode: "limited"; maxChars: number }
  | { mode: "unlimited"; maxChars: null };

export const UNLIMITED_POST_LENGTH: PostLengthPolicy = {
  mode: "unlimited",
  maxChars: null,
};

export function postCharacterCount(text: string): number {
  return Array.from(text).length;
}

export function validatePostLengthPolicy(policy: PostLengthPolicy): void {
  if (
    policy.mode === "limited" &&
    (!Number.isSafeInteger(policy.maxChars) || policy.maxChars <= 0)
  ) {
    throw new Error("POST_LENGTH_POLICY_INVALID");
  }
  if (policy.mode === "unlimited" && policy.maxChars !== null) {
    throw new Error("POST_LENGTH_POLICY_INVALID");
  }
}

export function postLengthInstruction(policy: PostLengthPolicy): string {
  validatePostLengthPolicy(policy);
  return policy.mode === "limited"
    ? `投稿本文はUnicodeコードポイント数で${policy.maxChars}文字以内にしてください。`
    : "投稿本文の文字数上限は設定されていません。";
}

export function assertPostWithinLengthPolicy(
  policy: PostLengthPolicy,
  text: string,
): number {
  validatePostLengthPolicy(policy);
  const count = postCharacterCount(text);
  if (policy.mode === "limited" && count > policy.maxChars) {
    throw new Error("POST_LENGTH_LIMIT_EXCEEDED");
  }
  return count;
}
