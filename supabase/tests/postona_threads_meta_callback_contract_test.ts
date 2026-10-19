// F4 / G4 (postona-g4-threads-end-to-end-gap-inventory-source-20261019, Issue #324): the CONTRACT for the Threads app's
// two Meta callbacks that do NOT exist anywhere yet -- the deauthorize callback (the person removed the app in Threads)
// and the data deletion request callback. Test-only and offline: no network permission, a fake app secret, a fake store.
//
// Documented by Meta (app dashboard, "Data Deletion Callback", read 2026-10-19; no API called):
//   POST with a `signed_request` parameter = <base64url signature>.<base64url payload>; the signature is HMAC-SHA256 of
//   the ENCODED payload with the app secret; the payload is JSON with algorithm "HMAC-SHA256", issued_at and user_id
//   (app-scoped); a data deletion callback answers JSON { url, confirmation_code } and starts deleting.
// Threads' own "create an app" page names both URLs (Deauthorize callback URL, Data Deletion Requests URL) but NOT the
// request format nor WHICH user id is sent. ASSUMED here (NOT VERIFIED for Threads): the same signed_request, user_id =
// the Threads user id stored as social_accounts.platform_user_id. A real handler must be checked against a real Meta call
// in a non-production project before it is trusted.
//
// metaCallbackViolations(make) is what any delivered handler must pass. A test-only reference handler proves the checker
// can be satisfied, and three broken handlers prove it fails them.
import { assert, assertEquals } from "jsr:@std/assert@1";

export type CallbackKind = "deauthorize" | "data_deletion";
export type CallbackStore = {
  /** The Threads account connected with this provider user id, or null. */
  accountByProviderUser(providerUserId: string): Promise<string | null>;
  /** Deauthorize: publishing stops and the account needs the person to reconnect (the token is no longer valid). */
  markDeauthorized(socialAccountId: string): Promise<void>;
  /** Data deletion: start removing the Threads footprint (G4's cleanup); returns the request's stable code. */
  requestDeletion(socialAccountId: string | null, providerUserId: string): Promise<string>;
};
export type CallbackDeps = { appSecret: string; store: CallbackStore; statusBaseUrl: string; fetch: (input: string) => Promise<Response> };
export type CallbackHandler = (kind: CallbackKind, request: Request) => Promise<Response>;

// --- helpers (fake Meta) ----------------------------------------------------------------------------------------------
const enc = new TextEncoder();
export function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
export function unb64url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/u.test(text)) return null;
  try {
    const bin = atob(text.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (text.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}
async function hmac(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}
export async function signedRequest(secret: string, payload: unknown): Promise<string> {
  const encoded = b64url(enc.encode(typeof payload === "string" ? payload : JSON.stringify(payload)));
  return `${b64url(await hmac(secret, encoded))}.${encoded}`;
}
const post = (signed: string | null) => new Request("https://callbacks.postona.example/threads", {
  method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: signed === null ? "" : new URLSearchParams({ signed_request: signed }).toString(),
});

class FakeStore implements CallbackStore {
  accounts = new Map([["1784140000000001", "sa_threads_alice"], ["1784140000000002", "sa_threads_bob"]]);
  deauthorized: string[] = [];
  deletions = new Map<string, string>();
  accountByProviderUser(id: string) { return Promise.resolve(this.accounts.get(id) ?? null); }
  markDeauthorized(account: string) { this.deauthorized.push(account); return Promise.resolve(); }
  requestDeletion(account: string | null, providerUserId: string) {
    const key = account ?? `unknown:${providerUserId}`;
    if (!this.deletions.has(key)) this.deletions.set(key, crypto.randomUUID().replaceAll("-", ""));
    return Promise.resolve(this.deletions.get(key)!);
  }
}

// --- the contract ------------------------------------------------------------------------------------------------------
export async function metaCallbackViolations(make: (deps: CallbackDeps) => CallbackHandler): Promise<string[]> {
  const v: string[] = [];
  const secret = "fake-threads-app-secret-0123456789abcdef";
  const store = new FakeStore();
  let fetches = 0;
  const handler = make({ appSecret: secret, store, statusBaseUrl: "https://postona.example/threads/deletion", fetch: () => { fetches += 1; return Promise.reject(new Error("no network")); } });
  const now = 1_760_800_000;
  const ok = (user: string) => ({ algorithm: "HMAC-SHA256", issued_at: now, user_id: user });
  const call = async (kind: CallbackKind, req: Request) => {
    try { return await handler(kind, req); } catch { return new Response(null, { status: 599 }); }
  };
  const untouched = () => store.deauthorized.length === 0 && store.deletions.size === 0;

  // M1 refused, nothing changed: forged / wrong secret / wrong algorithm / malformed / missing or odd user id / not POST.
  const forged = [
    ["another secret", await signedRequest("not-the-app-secret-0123456789abcdef", ok("1784140000000001"))],
    ["algorithm", await signedRequest(secret, { ...ok("1784140000000001"), algorithm: "HMAC-SHA1" })],
    ["no user", await signedRequest(secret, { algorithm: "HMAC-SHA256", issued_at: now })],
    ["odd user", await signedRequest(secret, ok("1784140000000001; drop"))],
    ["not json", await signedRequest(secret, "not json")],
    ["no dot", "abcdef"],
    ["bad base64", "!!!.???"],
    ["missing", null],
  ] as const;
  const good = await signedRequest(secret, ok("1784140000000001"));
  const [sig, body] = good.split(".");
  const tampered = `${sig}.${b64url(enc.encode(JSON.stringify(ok("1784140000000002"))))}`;
  for (const kind of ["deauthorize", "data_deletion"] as const) {
    for (const [label, signed] of [...forged, ["tampered payload", tampered] as const, ["signature of another body", `${sig}x.${body}`] as const]) {
      const res = await call(kind, post(signed));
      if (res.status < 400 || res.status >= 500) v.push(`M1 ${kind} ${label}: ${res.status}`);
    }
    const get = await call(kind, new Request("https://callbacks.postona.example/threads?signed_request=" + encodeURIComponent(good)));
    if (get.status !== 405) v.push(`M1 ${kind} GET: ${get.status}`);
  }
  if (!untouched()) v.push("M1 a refused callback changed something");

  // M2 deauthorize: exactly that person's account stops (publishing off, reconnect needed); 2xx; nothing echoed.
  const de = await call("deauthorize", post(good));
  if (de.status < 200 || de.status >= 300) v.push(`M2 deauthorize: ${de.status}`);
  if (JSON.stringify(store.deauthorized) !== JSON.stringify(["sa_threads_alice"])) v.push(`M2 deauthorized ${JSON.stringify(store.deauthorized)}`);
  const deText = await de.text();
  if (deText.includes("1784140000000001") || deText.includes(secret)) v.push("M2 response echoes the user or the secret");

  // M3 data deletion: { url, confirmation_code } only; the code is alphanumeric; the URL is https, carries the code and
  // never the user id; the deletion was requested for that account.
  const del = await call("data_deletion", post(await signedRequest(secret, ok("1784140000000002"))));
  let answer: Record<string, unknown> = {};
  try { answer = await del.json(); } catch { v.push("M3 not JSON"); }
  if (del.status !== 200 || Object.keys(answer).sort().join(",") !== "confirmation_code,url") v.push(`M3 shape ${del.status} ${JSON.stringify(answer)}`);
  const code = String(answer.confirmation_code ?? "");
  const url = String(answer.url ?? "");
  if (!/^[A-Za-z0-9]{8,64}$/u.test(code)) v.push("M3 confirmation_code");
  if (!url.startsWith("https://") || !url.includes(code) || url.includes("1784140000000002")) v.push(`M3 url ${url}`);
  if (store.deletions.get("sa_threads_bob") !== code) v.push("M3 the deletion of that account was not requested under that code");

  // M4 the same request again: the same code (idempotent); an unknown person: the same answer shape (no enumeration),
  // and no other account touched.
  const again = await call("data_deletion", post(await signedRequest(secret, ok("1784140000000002"))));
  const againCode = String((await again.json().catch(() => ({})) as Record<string, unknown>).confirmation_code ?? "");
  if (againCode !== code) v.push("M4 a repeated request got another code");
  const unknown = await call("data_deletion", post(await signedRequest(secret, ok("1784149999999999"))));
  const unknownAnswer = await unknown.json().catch(() => ({})) as Record<string, unknown>;
  if (unknown.status !== 200 || Object.keys(unknownAnswer).sort().join(",") !== "confirmation_code,url") v.push("M4 an unknown person is told apart");
  if ([...store.deletions.keys()].some((k) => k === "sa_threads_alice")) v.push("M4 another account's deletion was requested");

  // M5 no outbound call, ever (Threads has no app-side revoke to call; the callbacks only record).
  if (fetches !== 0) v.push(`M5 ${fetches} outbound calls`);
  return v;
}

// --- a test-only reference handler (proves the contract can be met; NOT a deliverable) ----------------------------------
const USER_RE = /^[1-9][0-9]{0,19}$/u;
export function referenceHandler(deps: CallbackDeps): CallbackHandler {
  return async (kind, request) => {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const signed = new URLSearchParams(await request.text()).get("signed_request") ?? "";
    const dot = signed.indexOf(".");
    const sig = dot > 0 ? unb64url(signed.slice(0, dot)) : null;
    const payloadBytes = dot > 0 ? unb64url(signed.slice(dot + 1)) : null;
    if (!sig || !payloadBytes) return new Response(null, { status: 400 });
    const key = await crypto.subtle.importKey("raw", enc.encode(deps.appSecret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    if (!await crypto.subtle.verify("HMAC", key, sig, enc.encode(signed.slice(dot + 1)))) return new Response(null, { status: 400 });
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(new TextDecoder().decode(payloadBytes)); } catch { return new Response(null, { status: 400 }); }
    const user = payload?.user_id;
    if (payload?.algorithm !== "HMAC-SHA256" || typeof user !== "string" || !USER_RE.test(user)) return new Response(null, { status: 400 });
    const account = await deps.store.accountByProviderUser(user);
    if (kind === "deauthorize") {
      if (account) await deps.store.markDeauthorized(account);
      return new Response(null, { status: 204 });
    }
    const code = await deps.store.requestDeletion(account, user);
    return Response.json({ url: `${deps.statusBaseUrl}?code=${code}`, confirmation_code: code });
  };
}

Deno.test("the contract can be met (test-only reference handler): no violation", async () => {
  assertEquals(await metaCallbackViolations(referenceHandler), []);
});

Deno.test("a handler that skips the signature check fails the contract", async () => {
  const unsigned = (deps: CallbackDeps): CallbackHandler => async (kind, request) => {
    const signed = new URLSearchParams(await request.clone().text()).get("signed_request") ?? "";
    const forged = await signedRequest(deps.appSecret, JSON.parse(new TextDecoder().decode(unb64url(signed.split(".")[1] ?? "") ?? new Uint8Array())));
    return referenceHandler(deps)(kind, new Request(request.url, { method: request.method, body: request.method === "POST" ? new URLSearchParams({ signed_request: forged }).toString() : undefined, headers: request.headers }));
  };
  const v = await metaCallbackViolations(unsigned);
  assert(v.some((x) => x.startsWith("M1")), JSON.stringify(v));
});

Deno.test("a handler that puts the user id in the status URL, or tells unknown people apart, fails the contract", async () => {
  const leaky = (deps: CallbackDeps): CallbackHandler => async (kind, request) => {
    const res = await referenceHandler(deps)(kind, request);
    if (kind !== "data_deletion" || res.status !== 200) return res;
    const body = await res.json() as { url: string; confirmation_code: string };
    return Response.json({ ...body, url: `${body.url}&user=1784140000000002` });
  };
  assert((await metaCallbackViolations(leaky)).some((x) => x.startsWith("M3 url")));
  const enumerating = (deps: CallbackDeps): CallbackHandler => async (kind, request) => {
    const res = await referenceHandler({ ...deps, store: { ...deps.store,
      accountByProviderUser: deps.store.accountByProviderUser.bind(deps.store),
      markDeauthorized: deps.store.markDeauthorized.bind(deps.store),
      requestDeletion: async (account, user) => { if (!account) throw new Error("unknown"); return await deps.store.requestDeletion(account, user); } } })(kind, request).catch(() => new Response(null, { status: 404 }));
    return res;
  };
  assert((await metaCallbackViolations(enumerating)).some((x) => x.startsWith("M4 an unknown")));
});

Deno.test("a handler that calls out (e.g. tries to revoke at Meta) fails the contract", async () => {
  const callsOut = (deps: CallbackDeps): CallbackHandler => async (kind, request) => {
    await deps.fetch("https://graph.threads.net/me/permissions").catch(() => undefined);
    return referenceHandler(deps)(kind, request);
  };
  assert((await metaCallbackViolations(callsOut)).some((x) => x.startsWith("M5")));
});

Deno.test("handlers that skip the algorithm check, ignore deauthorize, or mint a new code each time fail the contract", async () => {
  const anyAlgorithm = (deps: CallbackDeps): CallbackHandler => async (kind, request) => {
    const signed = new URLSearchParams(await request.clone().text()).get("signed_request") ?? "";
    const [sig, body] = signed.split(".");
    const payload = (() => { try { return JSON.parse(new TextDecoder().decode(unb64url(body ?? "") ?? new Uint8Array())); } catch { return null; } })();
    if (!payload || payload.algorithm === "HMAC-SHA256" || !sig) return referenceHandler(deps)(kind, request);
    const fixed = await signedRequest(deps.appSecret, { ...payload, algorithm: "HMAC-SHA256" });
    const ok = await signedRequest(deps.appSecret, payload) === signed;
    return referenceHandler(deps)(kind, ok ? new Request(request.url, { method: "POST", body: new URLSearchParams({ signed_request: fixed }).toString(), headers: request.headers }) : request);
  };
  assert((await metaCallbackViolations(anyAlgorithm)).some((x) => x.startsWith("M1 deauthorize algorithm")));
  const ignoresDeauthorize = (deps: CallbackDeps): CallbackHandler => (kind, request) =>
    kind === "deauthorize" && request.method === "POST" ? Promise.resolve(new Response(null, { status: 204 })) : referenceHandler(deps)(kind, request);
  assert((await metaCallbackViolations(ignoresDeauthorize)).some((x) => x.startsWith("M2 deauthorized")));
  const newCodeEachTime = (deps: CallbackDeps): CallbackHandler => referenceHandler({ ...deps, store: { ...deps.store,
    accountByProviderUser: deps.store.accountByProviderUser.bind(deps.store),
    markDeauthorized: deps.store.markDeauthorized.bind(deps.store),
    requestDeletion: async (account, user) => { const c = crypto.randomUUID().replaceAll("-", ""); await deps.store.requestDeletion(account, user); return c; } } });
  const v = await metaCallbackViolations(newCodeEachTime);
  assert(v.some((x) => x.startsWith("M4 a repeated")), JSON.stringify(v));
});
