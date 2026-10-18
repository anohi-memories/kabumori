/**
 * Generation-bound X credential port for the POSTONA single manual post (F3 SOURCE CANDIDATE, 2026-10-18, M1-F1).
 * F3 does NOT implement it (Issue #131: connection, refresh and Vault belong to the G4 / shared OAuth owner); this module
 * states the port and what a delivered source must do, as a check G4 can run against its implementation.
 *
 * credentialFor(account) answers the account's CURRENT access token together with the credential GENERATION read in the
 * same snapshot as the token: postona_x_resv.x_credential_generation(account) (006: SHA-256 over the account, its
 * workspace and F5's owner of it, the X user id, both Vault references, the connection status, verified_at, the row's
 * updated_at and the refresh state). The single post sends only when that generation equals the one the database
 * answered in post_now_preflight right before the send -- equal to the one bound at begin -- so a refresh, a reconnect,
 * a Vault reference change or an owner change after the token was read refuses the send (never sent).
 *   G1 `available` is exactly true once delivered (X_GENERATION_CREDENTIALS_NOT_CONNECTED keeps it false);
 *   G2 a connected, verified account -> { token (printable, 16..4096), generation (64 lowercase hex) };
 *   G3 the generation equals the database's x_credential_generation(account) at the time of the read;
 *   G4 an unknown, disconnected or deleted account -> null, answered (not thrown);
 *   G5 two accounts never share a token; nothing answered or thrown carries another account's token.
 * A source without credentialFor (the older accessTokenFor-only XPostingCredentialSource) is NOT accepted: it cannot say
 * which generation its token belongs to.
 */
import type { XPostingCredentialSource } from "./x_publisher.ts";

export type XGenerationCredential = { token: string; generation: string };
export type XPostingGenerationCredentialSource = {
  readonly available: boolean;
  credentialFor(socialAccountId: string): Promise<XGenerationCredential | null>;
};

/** G4 has not delivered a reviewed generation-bound source (Issue #131): nothing can be sent. */
export const X_GENERATION_CREDENTIALS_NOT_CONNECTED: XPostingGenerationCredentialSource = Object.freeze({
  available: false as const,
  credentialFor: () => Promise.resolve(null),
});

export const X_ACCESS_TOKEN_RE = /^[\x21-\x7e]{16,4096}$/u;
export const CREDENTIAL_GENERATION_RE = /^[0-9a-f]{64}$/u;

/** Only a source with `available === true` AND a credentialFor function is usable; anything else is not connected. */
export function generationSourceOf(source: unknown): XPostingGenerationCredentialSource {
  const s = source as Partial<XPostingGenerationCredentialSource> | null;
  return s && s.available === true && typeof s.credentialFor === "function" ? s as XPostingGenerationCredentialSource : X_GENERATION_CREDENTIALS_NOT_CONNECTED;
}

/** A credential source that answers exactly this token, for exactly this account, once (the publisher's one send). */
export function oneShotCredentialSource(socialAccountId: string, token: string): XPostingCredentialSource {
  let used = false;
  return {
    available: true,
    accessTokenFor(account: string) {
      if (used || account !== socialAccountId) return Promise.resolve(null);
      used = true;
      return Promise.resolve(token);
    },
  };
}

export type GenerationContractCases = {
  connected: readonly [string, string];
  notConnected: readonly string[];
  /** The database's x_credential_generation(account), read by the test right after credentialFor. */
  databaseGeneration(socialAccountId: string): Promise<string | null>;
};

export async function generationSourceViolations(source: XPostingGenerationCredentialSource, cases: GenerationContractCases): Promise<string[]> {
  const violations: string[] = [];
  if (source.available !== true) violations.push("G1 available is not true");
  const tokens: string[] = [];
  for (const account of cases.connected) {
    try {
      const credential = await source.credentialFor(account);
      if (!credential || typeof credential.token !== "string" || !X_ACCESS_TOKEN_RE.test(credential.token)
          || typeof credential.generation !== "string" || !CREDENTIAL_GENERATION_RE.test(credential.generation)) {
        violations.push(`G2 ${account}: no valid token + generation`);
        continue;
      }
      tokens.push(credential.token);
      if (credential.generation !== await cases.databaseGeneration(account)) violations.push(`G3 ${account}: generation differs from the database`);
    } catch {
      violations.push(`G2 ${account}: threw`);
    }
  }
  if (tokens.length === 2 && tokens[0] === tokens[1]) violations.push("G5 two accounts share a token");
  for (const account of cases.notConnected) {
    try {
      const credential = await source.credentialFor(account);
      if (credential !== null) violations.push(`G4 ${account}: answered ${tokens.includes(String(credential?.token)) ? "ANOTHER ACCOUNT'S token" : "a credential"}`);
    } catch (error) {
      violations.push(`G4 ${account}: threw`);
      if (tokens.some((token) => String((error as Error)?.message ?? error).includes(token))) violations.push(`G5 ${account}: a token in the error`);
    }
  }
  return violations;
}
