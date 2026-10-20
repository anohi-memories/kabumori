// Test-only cases for the social_accounts id shape (G4-12), shared by the id test and every G4 entry that takes one.

/** Accepted by CHECK social_accounts_id_check `^[a-z][a-z0-9_]{1,80}$`. */
export const VALID_SOCIAL_ACCOUNT_IDS: readonly string[] = [
  "sa_3f6c1b8e5d2a4c7f9e1b0a2b", // 'sa_' || substr(md5(brand || ':x'), 1, 24), 20260919120000
  "sa_x",
  "ab", // the shortest: 2 characters
  "s_",
  "a1",
  `a${"z".repeat(80)}`, // the longest: 81 characters
  `a${"_".repeat(80)}`,
];

/** Refused by the CHECK (and so by G4 before any port). */
export const INVALID_SOCIAL_ACCOUNT_IDS: readonly unknown[] = [
  "",
  "a", // too short
  `a${"z".repeat(81)}`, // 82 characters
  "1sa_x", // leading digit
  "_sa_x", // leading underscore
  "Sa_x", // upper case
  "sa_X",
  "SA_3F6C1B8E5D2A4C7F9E1B0A2B",
  "sa-x", // hyphen
  "3f6c1b8e-5d2a-4c7f-9e1b-0a2b3c4d5e6f", // a UUID is not a social_accounts id
  "sa_x ", // trailing space
  " sa_x",
  "sa x",
  "sa_x\n", // trailing newline
  "sa_x\r",
  "sa_\tx",
  "sa_x\u0000", // control characters
  "sa_x\u007f",
  "sa_é", // non-ASCII letters
  "sa_ı",
  "ｓa_x", // full-width s
  "sa_x​", // zero-width space
  "sa_x\u{1f600}",
  "sa_x.y",
  "sa_x/y",
  "sa_x'",
  null,
  undefined,
  7,
  ["sa_x"],
  { id: "sa_x" },
  new String("sa_x"),
];
