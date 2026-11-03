// G5's owner-epoch token, as G4 reads it (G4-08, Issue #319). Pure; imports nothing.
//
// R1's allow answer carries owner_epoch = "g5oe:<owner_epoch>:<lifecycle_version>" (G5-03 PR #351, fixed as a string by
// G5: Issue #319 comment 6279934094). G5-04 (PR #358 @ 4f4ece89, a candidate: H1's re-review is CHANGES_REQUIRED P2 on
// install checks, not on this shape) makes W1 / W2 take both numbers as bigint: (brand, service_key,
// p_expected_owner_epoch, p_expected_lifecycle_version), with no clock. A binding or a reservation stores the two numbers
// from the allow it was made under and hands them, unchanged, to every later check; nothing re-reads or "refreshes" them.
//
// Both numbers stay decimal TEXT: >= 1, no sign, no leading zero, within PostgreSQL bigint (checked with BigInt). They
// are never turned into a JS number, so values above 2^53 keep every digit.

const BIGINT_MAX = 9223372036854775807n;
const DECIMAL = /^[1-9][0-9]{0,18}$/u;
const TOKEN = /^g5oe:([1-9][0-9]{0,18}):([1-9][0-9]{0,18})$/u;

export type G5Generation = Readonly<{ ownerEpoch: string; lifecycleVersion: string }>;

/** A stored or passed number: decimal text in 1..bigint max, or null. */
export function g5Decimal(value: unknown): string | null {
  return typeof value === "string" && DECIMAL.test(value) && BigInt(value) <= BIGINT_MAX ? value : null;
}

/** "g5oe:<epoch>:<lifecycle>" -> both numbers as decimal text, or null for anything else (a JS number included). */
export function parseG5OwnerEpochToken(token: unknown): G5Generation | null {
  if (typeof token !== "string") return null;
  const m = TOKEN.exec(token);
  if (!m) return null;
  const ownerEpoch = g5Decimal(m[1]);
  const lifecycleVersion = g5Decimal(m[2]);
  return ownerEpoch && lifecycleVersion ? Object.freeze({ ownerEpoch, lifecycleVersion }) : null;
}
