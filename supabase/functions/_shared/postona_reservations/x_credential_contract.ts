/**
 * G4 contract for the X credential source the reservation worker uses (F3 SOURCE CANDIDATE, 2026-10-17). F3 does NOT
 * implement the source (Issue #131: the G4 / shared OAuth owner holds connection, refresh and Vault); this module
 * states what any delivered XPostingCredentialSource must do, as a check G4 can run against its implementation:
 *   C1 `available` is exactly true once delivered (X_CREDENTIALS_NOT_CONNECTED keeps it false);
 *   C2 a connected, verified account -> its current access token (printable, 16..4096 chars);
 *   C3 an unknown, disconnected or deleted account -> null, answered (not thrown);
 *   C4 two connected accounts never get the same token (each account's own grant);
 *   C5 nothing it answers or throws carries a token of another account.
 * The worker asks for exactly the claimed row's account right before the one send and never stores the token.
 */
import type { XPostingCredentialSource } from "./x_publisher.ts";

export const X_ACCESS_TOKEN_RE = /^[\x21-\x7e]{16,4096}$/u;

export type CredentialContractCases = {
  connected: readonly [string, string];
  notConnected: readonly string[];
};

export async function credentialSourceViolations(source: XPostingCredentialSource, cases: CredentialContractCases): Promise<string[]> {
  const violations: string[] = [];
  if (source.available !== true) violations.push("C1 available is not true");
  const tokens: string[] = [];
  for (const account of cases.connected) {
    try {
      const token = await source.accessTokenFor(account);
      if (typeof token !== "string" || !X_ACCESS_TOKEN_RE.test(token)) violations.push(`C2 ${account}: no valid token`);
      else tokens.push(token);
    } catch {
      violations.push(`C2 ${account}: threw`);
    }
  }
  if (tokens.length === 2 && tokens[0] === tokens[1]) violations.push("C4 two accounts share a token");
  for (const account of cases.notConnected) {
    try {
      const token = await source.accessTokenFor(account);
      if (token !== null) violations.push(`C3 ${account}: answered ${tokens.includes(String(token)) ? "ANOTHER ACCOUNT'S token" : "a token"}`);
    } catch (error) {
      violations.push(`C3 ${account}: threw`);
      if (tokens.some((token) => String((error as Error)?.message ?? error).includes(token))) violations.push(`C5 ${account}: a token in the error`);
    }
  }
  return violations;
}
