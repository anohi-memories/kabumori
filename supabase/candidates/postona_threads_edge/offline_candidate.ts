// Disconnected OFFLINE MOCK candidate. No SDK, env, server, native fetch or production adapter.
// Do not wire into an Edge Function: owner-only RPC authority and distributed claims remain gates.
import {
  buildThreadsAuthorizeUrl,
  completeThreadsConnectExchange,
  type FetchLike,
  hashThreadsState,
  isAcceptableThreadsRedirectUri,
  isWellFormedThreadsState,
  parseThreadsCallback,
  THREADS_CONNECT_ERROR_CODES,
  THREADS_CONNECT_SCOPES,
  type ThreadsConnectSettings,
} from "../../functions/_shared/social/threads_connect_contract.ts";
import {
  beginRpcPayload,
  completeRpcPayload,
  consumeRpcPayload,
  T13_REFUSAL_CODES,
  THREADS_CONNECT_RPC_REFUSAL_CODES,
} from "../../functions/_shared/social/threads_connect_rpc_contract.ts";

export type Subject = Readonly<{ userId: string; sessionId: string }>;
export type BeginRow = Readonly<
  { brand_id: string; social_account_id: string }
>;
export type ConsumeRow =
  & BeginRow
  & Readonly<{ oauth_state_id: string; redirect_uri: string }>;
export type Attempt = Readonly<{
  subject: Subject;
  workspace: BeginRow;
  expiresAtMs: number;
}>;

/** Verified identity must come from a trusted auth verifier, never decoded user input/metadata. */
export interface MockAuthPort {
  verify(
    credential: string | null,
    signal: AbortSignal,
  ): Promise<Subject | null>;
}
/** Payloads match PR124. These are injected mocks, NOT authenticated/service-role RPC adapters. */
export interface MockRpcPort {
  begin(
    subject: Subject,
    payload: ReturnType<typeof beginRpcPayload>,
    signal: AbortSignal,
  ): Promise<BeginRow>;
  consume(
    subject: Subject,
    payload: ReturnType<typeof consumeRpcPayload>,
    signal: AbortSignal,
  ): Promise<ConsumeRow>;
  complete(
    subject: Subject,
    payload: Awaited<ReturnType<typeof completeRpcPayload>>,
    signal: AbortSignal,
  ): Promise<void>;
}
/**
 * Mock-only attempt coordinator. claim atomically checks owner AND session and permanently burns
 * the attempt AND code hash before external exchange; no release/retry API. PR124 consume is read-only.
 * Real activation needs durable, cross-instance claims with expiry/drain/reconciliation proof.
 */
export interface MockAttemptPort {
  remember(hash: string, attempt: Attempt, signal: AbortSignal): Promise<void>;
  claim(
    hash: string,
    codeHash: string,
    subject: Subject,
    signal: AbortSignal,
  ): Promise<Attempt | null>;
}
export type OfflinePorts = Readonly<{
  mode: "offline-mock";
  auth: MockAuthPort;
  rpc: MockRpcPort;
  attempts: MockAttemptPort;
  fakeHttp: FetchLike;
  now: () => number;
  /** Tests may inject deterministic bytes; default is WebCrypto 32-byte randomness. */
  randomBytes?: () => Uint8Array;
  deadlineMs?: number;
}>;
const LOCAL_CODES = [
  "AUTH_REQUIRED",
  "AUTH_UNAVAILABLE",
  "OFFLINE_CONFIGURATION_INVALID",
  "START_FAILED",
  "CALLBACK_INVALID",
  "AUTHORIZATION_DENIED",
  "STATE_UNAVAILABLE",
  "STATE_NOT_USABLE",
  "RPC_RESPONSE_INVALID",
  "CONSUME_FAILED",
  "COMPLETE_FAILED",
  "COMPLETE_OUTCOME_UNKNOWN",
] as const;
const ALLOWED_CODES = new Set<string>([
  ...LOCAL_CODES,
  ...THREADS_CONNECT_ERROR_CODES,
  ...T13_REFUSAL_CODES,
  ...THREADS_CONNECT_RPC_REFUSAL_CODES,
]);
class FixedError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export class MockRpcRefusal extends Error {
  constructor(
    readonly code:
      | (typeof T13_REFUSAL_CODES)[number]
      | (typeof THREADS_CONNECT_RPC_REFUSAL_CODES)[number],
  ) {
    super(code);
  }
}
export type Failure = Readonly<
  { ok: false; error: string; restartRequired: true }
>;
const failure = (error: unknown, fallback: string): Failure => {
  const candidate =
    error !== null && typeof error === "object" && "code" in error
      ? error.code
      : null;
  return {
    ok: false,
    error: typeof candidate === "string" && ALLOWED_CODES.has(candidate)
      ? candidate
      : fallback,
    restartRequired: true,
  };
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const validSubject = (value: Subject | null): value is Subject =>
  !!value && typeof value.userId === "string" &&
  typeof value.sessionId === "string" &&
  UUID.test(value.userId) && UUID.test(value.sessionId);
const sameSubject = (a: Subject, b: Subject) =>
  a.userId === b.userId && a.sessionId === b.sessionId;
const validWorkspace = (row: BeginRow) =>
  !!row && typeof row.brand_id === "string" &&
  /^sm_[0-9a-f]{24}$/.test(row.brand_id) &&
  typeof row.social_account_id === "string" &&
  /^sa_[0-9a-f]{24}$/.test(row.social_account_id);

/** Deliberately refuses real-looking configuration; this factory is not a runtime enable switch. */
export function createOfflineThreadsCandidate(
  settings: ThreadsConnectSettings,
  dummyKey: string,
  ports: OfflinePorts,
) {
  const redirect = (() => {
    try {
      return new URL(settings.redirectUri);
    } catch {
      return null;
    }
  })();
  const duration = ports.deadlineMs ?? 10_000;
  if (
    ports.mode !== "offline-mock" || !redirect ||
    !isAcceptableThreadsRedirectUri(settings.redirectUri) ||
    !redirect.hostname.endsWith(".example") || redirect.search !== "" ||
    redirect.port !== "" ||
    !/^[0-9]{1,32}$/.test(settings.appId) ||
    !/^offline_dummy_[A-Za-z0-9_-]{16,100}$/.test(settings.appSecret) ||
    !/^offline_dummy_[A-Za-z0-9_-]{32,100}$/.test(dummyKey) ||
    !Number.isInteger(duration) || duration < 1 || duration > 10_000
  ) {
    throw new FixedError("OFFLINE_CONFIGURATION_INVALID");
  }
  settings = Object.freeze({ ...settings });
  const config = { status: "enabled" as const, settings };
  // The explicit enabled config is only for offline pure request builders. The production gate and
  // readThreadsConnectConfig remain untouched/false. There is no production entry point here.
  const timed = async <T>(
    operation: (signal: AbortSignal) => Promise<T>,
    code: string,
  ): Promise<T> => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => operation(controller.signal)),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new FixedError(code));
          }, duration);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  const verify = async (credential: string | null): Promise<Subject> => {
    const subject = await timed(
      (signal) => ports.auth.verify(credential, signal),
      "AUTH_UNAVAILABLE",
    );
    if (!validSubject(subject)) throw new FixedError("AUTH_REQUIRED");
    return Object.freeze({ ...subject });
  };
  const fakeHttp: FetchLike = async (url, init) => {
    const response = await timed((signal) =>
      ports.fakeHttp(url, {
        ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
      }), "THREADS_CODE_EXCHANGE_UNAVAILABLE");
    // Also bound a mock body that ignores the AbortSignal (the pure adapter otherwise awaits text).
    const body = await timed(
      () => response.text(),
      "THREADS_CODE_EXCHANGE_UNAVAILABLE",
    );
    return new Response(body, {
      status: response.status,
      headers: response.headers,
    });
  };

  return Object.freeze({
    async start(credential: string | null): Promise<
      | Failure
      | Readonly<{
        ok: true;
        authorizationUrl: string;
        expiresAt: string;
        provider: "threads";
      }>
    > {
      try {
        const subject = await verify(credential);
        const nowMs = ports.now();
        if (!Number.isFinite(nowMs)) throw new FixedError("START_FAILED");
        const bytes = ports.randomBytes?.() ??
          crypto.getRandomValues(new Uint8Array(32));
        if (!(bytes instanceof Uint8Array) || bytes.length !== 32) {
          throw new FixedError("START_FAILED");
        }
        const rawState = btoa(String.fromCharCode(...bytes)).replaceAll(
          "+",
          "-",
        ).replaceAll("/", "_").replaceAll("=", "");
        const hash = await hashThreadsState(rawState);
        const expiresAtMs = nowMs + 10 * 60 * 1000;
        const payload = beginRpcPayload({
          stateHash: hash,
          redirectUri: settings.redirectUri,
          now: new Date(nowMs),
          expiresAt: new Date(expiresAtMs),
        });
        const row = await timed(
          (signal) => ports.rpc.begin(subject, payload, signal),
          "START_FAILED",
        );
        if (!validWorkspace(row)) throw new FixedError("RPC_RESPONSE_INVALID");
        const workspace = Object.freeze({
          brand_id: row.brand_id,
          social_account_id: row.social_account_id,
        });
        await timed(
          (signal) =>
            ports.attempts.remember(
              hash,
              Object.freeze({ subject, workspace, expiresAtMs }),
              signal,
            ),
          "START_FAILED",
        );
        const authorizationUrl = buildThreadsAuthorizeUrl(config, rawState);
        const scopes = new URL(authorizationUrl).searchParams.get("scope");
        if (scopes !== THREADS_CONNECT_SCOPES.join(",")) {
          throw new FixedError("START_FAILED");
        }
        return {
          ok: true,
          authorizationUrl,
          expiresAt: payload.p_expires_at,
          provider: "threads",
        };
      } catch (error) {
        return failure(error, "START_FAILED");
      }
    },

    async callback(
      credential: string | null,
      callbackUrl: string,
    ): Promise<
      | Failure
      | Readonly<{
        ok: true;
        status: "connected";
        provider: "threads";
        publishEnabled: false;
      }>
    > {
      let completionStarted = false;
      try {
        const subject = await verify(credential);
        let url: URL;
        try {
          url = new URL(callbackUrl);
        } catch {
          throw new FixedError("CALLBACK_INVALID");
        }
        if (
          url.origin + url.pathname !== settings.redirectUri || url.username ||
          url.password ||
          (url.hash !== "" && url.hash !== "#_") || callbackUrl.length > 8192 ||
          [...url.searchParams.keys()].some((key) =>
            !["code", "state", "error", "error_reason", "error_description"]
              .includes(key)
          )
        ) {
          throw new FixedError("CALLBACK_INVALID");
        }
        const parsed = parseThreadsCallback(url.searchParams);
        if (parsed.kind === "denied") {
          throw new FixedError("AUTHORIZATION_DENIED");
        }
        if (parsed.kind !== "code" || !isWellFormedThreadsState(parsed.state)) {
          throw new FixedError("CALLBACK_INVALID");
        }
        const hash = await hashThreadsState(parsed.state);
        // No release even if RPC/provider timed out: the code may have been exchanged already.
        const codeDigest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(parsed.code),
        );
        const codeHash = [...new Uint8Array(codeDigest)].map((byte) =>
          byte.toString(16).padStart(2, "0")
        ).join("");
        const attempt = await timed(
          (signal) => ports.attempts.claim(hash, codeHash, subject, signal),
          "STATE_UNAVAILABLE",
        );
        if (
          !attempt || !sameSubject(attempt.subject, subject) ||
          !validWorkspace(attempt.workspace) ||
          !Number.isFinite(attempt.expiresAtMs) ||
          !Number.isFinite(ports.now()) || attempt.expiresAtMs <= ports.now()
        ) {
          throw new FixedError("STATE_NOT_USABLE");
        }
        const row = await timed(
          (signal) =>
            ports.rpc.consume(subject, consumeRpcPayload(hash), signal),
          "CONSUME_FAILED",
        );
        if (
          !row || !UUID.test(row.oauth_state_id) ||
          row.redirect_uri !== settings.redirectUri ||
          row.brand_id !== attempt.workspace.brand_id ||
          row.social_account_id !== attempt.workspace.social_account_id
        ) {
          throw new FixedError("RPC_RESPONSE_INVALID");
        }
        const exchanged = await completeThreadsConnectExchange(
          fakeHttp,
          config,
          parsed.code,
        );
        const currentSubject = await verify(credential);
        if (!sameSubject(subject, currentSubject)) {
          throw new FixedError("AUTH_REQUIRED");
        }
        if (
          !Number.isFinite(ports.now()) || attempt.expiresAtMs <= ports.now()
        ) throw new FixedError("STATE_NOT_USABLE");
        const payload = await completeRpcPayload(dummyKey, {
          oauthStateId: row.oauth_state_id,
          providerUserId: exchanged.identity.providerAccountId,
          handle: exchanged.identity.handle ?? null,
          accessToken: exchanged.longLivedToken,
        });
        // Mock complete must recheck T13 atomically. No client-side lifecycle check substitutes it.
        completionStarted = true;
        await timed(
          (signal) => ports.rpc.complete(subject, payload, signal),
          "COMPLETE_OUTCOME_UNKNOWN",
        );
        return {
          ok: true,
          status: "connected",
          provider: "threads",
          publishEnabled: false,
        };
      } catch (error) {
        return failure(
          error,
          completionStarted ? "COMPLETE_OUTCOME_UNKNOWN" : "COMPLETE_FAILED",
        );
      }
    },
  });
}
