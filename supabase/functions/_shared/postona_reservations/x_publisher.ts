/**
 * X publisher for POSTONA reservations (F3 SOURCE CANDIDATE, 2026-10-16). Not deployed; never reached in production
 * while the credential source is X_CREDENTIALS_NOT_CONNECTED (then `available` is false and the worker claims
 * nothing).
 *
 * The X user access token belongs to the G4 / shared OAuth owner (connection, refresh, Vault). F3 does not read
 * Vault, refresh tokens or change the OAuth code: it only asks the owner-delivered XPostingCredentialSource for the
 * CURRENT access token of exactly the claimed social account, right before the one send. The token is used for
 * that request only: never stored, logged, returned or put into an error.
 *
 * One reservation = one POST https://api.x.com/2/tweets { text } (the stored text, unchanged). The answer decides:
 *   201 + numeric data.id                         -> published (provider post id)
 *   400 / 401 / 403 / 429 (X refused the request) -> rejected_before_send (X_REJECTED_<status>): provably not posted
 *   no token / the credential source failed       -> rejected_before_send (X_CREDENTIALS_UNAVAILABLE): never sent
 *   anything else (5xx, other status, malformed 201, network error, timeout)
 *                                                 -> unknown: the row becomes 'uncertain', never re-sent blindly
 */
import type { PublishResult, ReservationPublisher } from "./worker.ts";

export const X_CREATE_POST_URL = "https://api.x.com/2/tweets";
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Owner-delivered (G4 / shared OAuth): the current access token of one connected X account, or null. */
export type XPostingCredentialSource = {
  readonly available: boolean;
  accessTokenFor(socialAccountId: string): Promise<string | null>;
};

/** G4 has not delivered a reviewed credential source (Issue #131): nothing can be sent. */
export const X_CREDENTIALS_NOT_CONNECTED: XPostingCredentialSource = Object.freeze({
  available: false as const,
  accessTokenFor: () => Promise.resolve(null),
});

const REFUSED_BEFORE_CREATE = new Set([400, 401, 403, 429]);
const POST_ID_RE = /^[0-9]{1,30}$/u;
const TOKEN_RE = /^[\x21-\x7e]{16,4096}$/u;

export function createXReservationPublisher(deps: {
  credentials: XPostingCredentialSource;
  fetch?: FetchLike;
  timeoutMs?: number;
}): ReservationPublisher {
  const fetchImpl = deps.fetch ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 20_000;
  return {
    available: deps.credentials.available === true,
    async publish(socialAccountId: string, text: string): Promise<PublishResult> {
      let token: string | null;
      try {
        token = await deps.credentials.accessTokenFor(socialAccountId);
      } catch {
        token = null;
      }
      if (typeof token !== "string" || !TOKEN_RE.test(token)) return { kind: "rejected_before_send", code: "X_CREDENTIALS_UNAVAILABLE" };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(X_CREATE_POST_URL, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ text }),
          signal: controller.signal,
        });
      } catch {
        // The request may have reached X before the connection broke or the timer fired.
        return { kind: "unknown", code: controller.signal.aborted ? "X_TIMEOUT" : "X_TRANSPORT_UNKNOWN" };
      } finally {
        clearTimeout(timer);
      }
      if (response.status === 201) {
        let id: unknown = null;
        try {
          id = ((await response.json()) as { data?: { id?: unknown } } | null)?.data?.id;
        } catch {
          id = null;
        }
        return typeof id === "string" && POST_ID_RE.test(id) ? { kind: "published", providerPostId: id } : { kind: "unknown", code: "X_RESPONSE_INVALID" };
      }
      await response.body?.cancel().catch(() => undefined);
      if (REFUSED_BEFORE_CREATE.has(response.status)) return { kind: "rejected_before_send", code: `X_REJECTED_${response.status}` };
      return { kind: "unknown", code: `X_HTTP_${response.status >= 100 && response.status <= 999 ? response.status : 0}` };
    },
  };
}
