// The id of a public.social_accounts row, as G4 checks it (G4-12, Issue #319). Pure; imports nothing.
//
// Exactly the table's CHECK social_accounts_id_check `^[a-z][a-z0-9_]{1,80}$` (migrations 20261007150000 catalog
// assertion; rows are `sa_...`, 20260919120000). It is not a UUID: G4-02 / G4-03 / G4-04 used to accept only UUIDs, so
// every real account was refused (G3 U2, G4-11 overlay). One check for every G4 entry that takes an account id; the
// owner / brand / R1 / W1 / W2 / generation checks after it are unchanged, it only stops refusing the real shape.
//
// No case folding, no trimming, no Unicode: a leading digit or underscore, an upper-case letter, a hyphen, a space, a
// control character, a trailing newline (`$` here matches only at the very end), or more than 81 characters refuse.

export const SOCIAL_ACCOUNT_ID = /^[a-z][a-z0-9_]{1,80}$/u;

/** A string in the social_accounts id shape, or false. */
export function isSocialAccountId(value: unknown): value is string {
  return typeof value === "string" && SOCIAL_ACCOUNT_ID.test(value);
}
