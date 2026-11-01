/**
 * G3's credential generation, derived from G4's verified credential_generation (G3 SOURCE CANDIDATE, 2026-10-30, Issue #318 G3-49).
 * Not deployed. The SAME definition as the database (G3-48, PR #581):
 *   X       postona_x_resv.x_credential_generation(account)             = sha256 hex of 'g3x1|' || G4's 'g4x1:<connection_epoch>'
 *   Threads postona_threads_resv.threads_credential_generation(account) = sha256 hex of 'g3t1|' || G4's 'g4t1:<oauth_state_id>'
 * (014 / 013: encode(sha256(convert_to('g3x1|' || generation, 'UTF8')), 'hex'), only when G4's verdict is `verified`).
 * G4's value is opaque to G3: only its shape is checked (anything else -> null, never a generation). G5's lifecycle stays G3's own
 * MV / g5_bound_state check in the database and is never mixed with this value.
 *
 * xGenerationSourceFromG4Raw adapts a G4 X token source that answers G4's RAW generation together with the token (one read) into the
 * generation-bound source the X reservation worker (x_bound_delivery.ts) and the single post (single_post.ts) accept. It is the IF
 * offered to G4 (Issue #318 G3-48 REPORT): either G4's credentialFor answers G3's derived value, or it answers G4's raw value and this
 * adapter derives it. Nothing is cached; a source that is not `available === true` stays not connected.
 */
import { CREDENTIAL_GENERATION_RE, X_ACCESS_TOKEN_RE, X_GENERATION_CREDENTIALS_NOT_CONNECTED, type XGenerationCredential, type XPostingGenerationCredentialSource } from "./x_credential_generation.ts";

export type G3CredentialPlatform = "x" | "threads";

/** G4's X generation: 'g4x1:' || connection_epoch (a non-negative bigint). */
export const G4_X_GENERATION_RE = /^g4x1:[0-9]{1,19}$/u;
/** G4's Threads generation: 'g4t1:' || oauth_state_id (a uuid as PostgreSQL prints it). */
export const G4_THREADS_GENERATION_RE = /^g4t1:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const PREFIX: Readonly<Record<G3CredentialPlatform, string>> = Object.freeze({ x: "g3x1|", threads: "g3t1|" });
const SHAPE: Readonly<Record<G3CredentialPlatform, RegExp>> = Object.freeze({ x: G4_X_GENERATION_RE, threads: G4_THREADS_GENERATION_RE });

/** sha256 hex of the platform prefix || G4's generation; null for an unknown platform or a value not in G4's shape. */
export async function g3CredentialGeneration(platform: G3CredentialPlatform, g4Generation: unknown): Promise<string | null> {
  if (platform !== "x" && platform !== "threads") return null;
  if (typeof g4Generation !== "string" || !SHAPE[platform].test(g4Generation)) return null;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(PREFIX[platform] + g4Generation)));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type XG4RawCredential = { token: string; g4Generation: string };
export type XG4RawCredentialSource = {
  readonly available: boolean;
  credentialFor(socialAccountId: string): Promise<XG4RawCredential | null>;
};

/** One G4 read per lookup -> { token, G3's derived generation } | null. A throw, a bad token or a bad G4 value -> null. */
export function xGenerationSourceFromG4Raw(source: unknown): XPostingGenerationCredentialSource {
  const s = source as Partial<XG4RawCredentialSource> | null;
  if (!s || s.available !== true || typeof s.credentialFor !== "function") return X_GENERATION_CREDENTIALS_NOT_CONNECTED;
  const read = s.credentialFor.bind(s);
  return Object.freeze({
    available: true as const,
    async credentialFor(socialAccountId: string): Promise<XGenerationCredential | null> {
      let raw: XG4RawCredential | null;
      try {
        raw = await read(socialAccountId);
      } catch {
        return null;
      }
      if (!raw || typeof raw.token !== "string" || !X_ACCESS_TOKEN_RE.test(raw.token)) return null;
      const generation = await g3CredentialGeneration("x", raw.g4Generation);
      return generation !== null && CREDENTIAL_GENERATION_RE.test(generation) ? { token: raw.token, generation } : null;
    },
  });
}
