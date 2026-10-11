import {
  buildThreadsAuthorizeUrl,
  completeThreadsConnectExchange,
  type FetchLike,
  hashThreadsState,
  isAcceptableThreadsRedirectUri,
  parseThreadsCallback,
  THREADS_CONNECT_ENDPOINTS,
  type ThreadsConnectSettings,
} from "../../functions/_shared/social/threads_connect_contract.ts";
import { completeRpcPayload } from "../../functions/_shared/social/threads_connect_rpc_contract.ts";
import { RuntimeRefusal, type VerifiedActor } from "./verified_actor.ts";
import { type createOwnerTransport } from "./owner_transport.ts";
type Bridge = ReturnType<typeof createOwnerTransport>;
export type RuntimeDependencies = {
  verify: (auth: string | null) => Promise<VerifiedActor>;
  bridge: Bridge;
  settings: ThreadsConnectSettings;
  attestationKey: string;
  fetch: FetchLike;
  now?: () => number;
  deadlineMs?: number;
};
/** Deliberately unwired SDK-compatible composition. Entry handler below remains statically disabled.
 * An authenticated app forwards the exact HTTPS callback; no unauthenticated browser writer exists. */
export function createThreadsRuntime(d: RuntimeDependencies) {
  const now = d.now ?? Date.now;
  const deadline = d.deadlineMs ?? 8000;
  const settings = Object.freeze({ ...d.settings });
  if (
    !isAcceptableThreadsRedirectUri(settings.redirectUri) ||
    new URL(settings.redirectUri).search ||
    !Number.isInteger(deadline) || deadline < 1 || deadline > 10000 ||
    d.attestationKey.length < 32
  ) throw new RuntimeRefusal("CONFIG_INVALID");
  const config = { status: "enabled" as const, settings };
  async function bounded<T>(
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => fn(ctl.signal)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            ctl.abort();
            reject(new RuntimeRefusal("OUTCOME_UNKNOWN"));
          }, deadline);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  const http: FetchLike = (url, init) =>
    bounded(async (signal) => {
      const u = new URL(url);
      const endpoints = Object.values(THREADS_CONNECT_ENDPOINTS);
      if (
        !endpoints.some((e) => {
          const v = new URL(e);
          return u.origin + u.pathname === v.origin + v.pathname;
        }) || init?.redirect === "follow"
      ) throw new RuntimeRefusal("PROVIDER_URL_INVALID");
      const r = await d.fetch(url, { ...init, redirect: "error", signal });
      const body = await r.text();
      if (body.length > 65536) {
        throw new RuntimeRefusal("PROVIDER_RESPONSE_INVALID");
      }
      return new Response(body, { status: r.status, headers: r.headers });
    });
  return Object.freeze({
    async start(auth: string | null) {
      try {
        const actor = await bounded(() => d.verify(auth));
        const state = btoa(
          String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
        ).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
        const expiresAt = new Date(Math.min(now() + 600000, actor.expiresAt));
        const hash = await hashThreadsState(state);
        await bounded(() =>
          d.bridge.begin(actor, hash, settings.redirectUri, expiresAt)
        );
        return {
          ok: true,
          provider: "threads",
          authorizationUrl: buildThreadsAuthorizeUrl(config, state),
          expiresAt: expiresAt.toISOString(),
        };
      } catch {
        return { ok: false, error: "START_REFUSED", restartRequired: true };
      }
    },
    async callback(auth: string | null, callbackUrl: string) {
      let hash: string | undefined;
      let actor: VerifiedActor | undefined;
      let exchangeStarted = false;
      let completeStarted = false;
      try {
        actor = await bounded(() => d.verify(auth));
        const url = new URL(callbackUrl);
        if (
          url.origin + url.pathname !== settings.redirectUri || url.username ||
          url.password ||
          (url.hash !== "" && url.hash !== "#_") || callbackUrl.length > 8192 ||
          [...url.searchParams.keys()].some((k) =>
            !["code", "state", "error", "error_reason", "error_description"]
              .includes(k)
          )
        ) throw new RuntimeRefusal("CALLBACK_INVALID");
        const parsed = parseThreadsCallback(url.searchParams);
        if (parsed.kind !== "code") {
          throw new RuntimeRefusal("CALLBACK_INVALID");
        }
        hash = await hashThreadsState(parsed.state);
        const codeHash = [
          ...new Uint8Array(
            await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(parsed.code),
            ),
          ),
        ].map((b) => b.toString(16).padStart(2, "0")).join("");
        const claim = await bounded(() =>
          d.bridge.claim(actor!, hash!, codeHash, settings.redirectUri)
        );
        if (
          !claim || claim.redirect_uri !== settings.redirectUri ||
          !Number.isFinite(new Date(claim.expires_at).getTime()) ||
          new Date(claim.expires_at).getTime() <= now() ||
          !/^u_[0-9a-f]{24}$/.test(claim.brand_id) ||
          !/^sa_[0-9a-f]{24}$/.test(claim.social_account_id) ||
          !/^[0-9a-f-]{36}$/.test(claim.oauth_state_id)
        ) throw new RuntimeRefusal("CLAIM_INVALID");
        exchangeStarted = true;
        const exchanged = await completeThreadsConnectExchange(
          http,
          config,
          parsed.code,
        );
        const current = await bounded(() => d.verify(auth));
        if (
          current.userId !== actor.userId ||
          current.sessionId !== actor.sessionId ||
          new Date(claim.expires_at).getTime() <= now()
        ) throw new RuntimeRefusal("SESSION_CHANGED");
        actor = current;
        const payload = await completeRpcPayload(d.attestationKey, {
          oauthStateId: claim.oauth_state_id,
          providerUserId: exchanged.identity.providerAccountId,
          handle: exchanged.identity.handle ?? null,
          accessToken: exchanged.longLivedToken,
        });
        const expiry = new Date(now() + exchanged.expiresInSeconds * 1000);
        completeStarted = true;
        await bounded(() => d.bridge.complete(actor!, hash!, payload, expiry));
        // This DTO is a receipt, NOT a publish authority/token; G4 must reauthorize on each post.
        return {
          ok: true,
          status: "connected",
          provider: "threads",
          socialAccountId: claim.social_account_id,
          publishEnabled: false,
          tokenExpiresAt: expiry.toISOString(),
        };
      } catch {
        if (actor && hash && exchangeStarted && !completeStarted) {
          try {
            await bounded(() => d.bridge.uncertain(actor!, hash!));
          } catch { /* durable claim remains burned */ }
        }
        return {
          ok: false,
          error: completeStarted
            ? "COMPLETE_OUTCOME_UNKNOWN"
            : exchangeStarted
            ? "EXCHANGE_OUTCOME_UNCERTAIN"
            : "CALLBACK_REFUSED",
          reconciliationRequired: exchangeStarted,
          restartRequired: true,
        };
      }
    },
  });
}
