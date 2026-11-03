import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRefreshUrl,
  createThreadsTokenRefresher,
  MAX_TOKEN_LIFETIME_MS,
  MIN_TOKEN_AGE_MS,
  parseRefreshResponse,
  refreshDecision,
  REFRESH_WINDOW_MS,
  type RefreshClaim,
  type RefreshStore,
  THREADS_REFRESH_ENDPOINT,
  THREADS_TOKEN_REFRESH_ENABLED,
} from "./threads_token_refresh.ts";

// F4 Threads token refresh design candidate, offline. Fake tokens only; distinctive so any leak is easy to spot.
const DAY = 24 * 3600 * 1000;
const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);
const OLD = "THQVJoffline_OLD_token_LEAKCHECK_0123456789";
const NEW = "THQVJoffline_NEW_token_LEAKCHECK_9876543210";
const ok200 = (over: Record<string, unknown> = {}) => JSON.stringify({ access_token: NEW, token_type: "bearer", expires_in: 60 * 86400, ...over });

test("the flag is off and nothing in the functions tree imports the refresher except its own test", async () => {
  assert.equal(THREADS_TOKEN_REFRESH_ENABLED, false);
  const root = new URL("../../", import.meta.url);
  const importers: string[] = [];
  const walk = async (dir: URL): Promise<void> => {
    for await (const entry of Deno.readDir(dir)) {
      const child = new URL(entry.name + (entry.isDirectory ? "/" : ""), dir);
      if (entry.isDirectory) await walk(child);
      else if (/\.(ts|tsx|mjs|js)$/.test(entry.name) && !entry.name.startsWith("threads_token_refresh")) {
        if ((await Deno.readTextFile(child)).includes("threads_token_refresh")) importers.push(child.pathname);
      }
    }
  };
  await walk(root);
  assert.deepEqual(importers, []);
  const source = await Deno.readTextFile(new URL("./threads_token_refresh.ts", import.meta.url));
  assert.doesNotMatch(source, /Deno\.(env|serve)|console\.(log|warn|error)|^import /m, "pure: no env, no server, no logging, no imports");
});

test("decision: unknown or expired -> reauth; younger than 24 h -> not attempted; outside the window -> not due; inside -> refresh", () => {
  const issued = NOW - 50 * DAY;
  assert.equal(refreshDecision({ now: NOW, issuedAt: null, expiresAt: NOW + DAY }), "reauth_required");
  assert.equal(refreshDecision({ now: NOW, issuedAt: issued, expiresAt: null }), "reauth_required");
  assert.equal(refreshDecision({ now: NOW, issuedAt: issued, expiresAt: NOW }), "reauth_required", "at expiry it can no longer be refreshed");
  assert.equal(refreshDecision({ now: NOW, issuedAt: NOW - MIN_TOKEN_AGE_MS + 1, expiresAt: NOW + 2 * DAY }), "too_young");
  assert.equal(refreshDecision({ now: NOW, issuedAt: NOW - 2 * DAY, expiresAt: NOW + REFRESH_WINDOW_MS + 1 }), "not_due");
  assert.equal(refreshDecision({ now: NOW, issuedAt: issued, expiresAt: NOW + REFRESH_WINDOW_MS }), "refresh_now");
  assert.equal(refreshDecision({ now: NOW, issuedAt: NOW - MIN_TOKEN_AGE_MS, expiresAt: NOW + 1 }), "refresh_now");
});

test("request: exactly the documented endpoint and grant; a token of an unexpected shape is never sent nor echoed", () => {
  const url = new URL(buildRefreshUrl(OLD));
  assert.equal(url.origin + url.pathname, THREADS_REFRESH_ENDPOINT);
  assert.deepEqual([...url.searchParams.keys()], ["grant_type", "access_token"]);
  assert.equal(url.searchParams.get("grant_type"), "th_refresh_token");
  for (const bad of ["", "short", `${OLD} x`, `${OLD}&x=1`, "a".repeat(2049)]) {
    assert.throws(() => buildRefreshUrl(bad), (e: Error) => e.message === "THREADS_REFRESH_TOKEN_SHAPE_INVALID" && !e.message.includes(OLD));
  }
});

test("response: only a well-formed 200 is a refresh; 190 means reconnect; other 4xx a refusal; the rest is uncertain", () => {
  assert.deepEqual(parseRefreshResponse(200, ok200(), NOW), { kind: "refreshed", accessToken: NEW, expiresAt: NOW + 60 * 86400 * 1000 });
  assert.equal(parseRefreshResponse(200, ok200({ token_type: undefined }), NOW).kind, "refreshed", "token_type may be absent");
  for (const body of [null, "not json", "[]", ok200({ access_token: 5 }), ok200({ access_token: "x" }), ok200({ token_type: "mac" }), ok200({ expires_in: 0 }), ok200({ expires_in: 1.5 }), ok200({ expires_in: MAX_TOKEN_LIFETIME_MS / 1000 + 1 }), ok200({ expires_in: "5184000" })]) {
    assert.deepEqual(parseRefreshResponse(200, body, NOW), { kind: "uncertain", code: "THREADS_REFRESH_RESPONSE_MALFORMED" }, String(body));
  }
  const oauth = (code: number) => JSON.stringify({ error: { message: `bad ${OLD}`, type: "OAuthException", code } });
  for (const status of [400, 401, 403]) assert.deepEqual(parseRefreshResponse(status, oauth(190), NOW), { kind: "reauth_required", code: "THREADS_REFRESH_TOKEN_INVALID" });
  assert.deepEqual(parseRefreshResponse(400, oauth(100), NOW), { kind: "rejected", code: "THREADS_REFRESH_REJECTED" });
  assert.deepEqual(parseRefreshResponse(400, "garbage", NOW), { kind: "rejected", code: "THREADS_REFRESH_REJECTED" });
  for (const status of [429, 500, 502, 503, 302, 204]) assert.deepEqual(parseRefreshResponse(status, oauth(190), NOW), { kind: "uncertain", code: "THREADS_REFRESH_UNAVAILABLE" }, String(status));
});

// ------------------------------------------------------------------------------------------- the coordinator

type Account = { owner: string; version: string; issuedAt: number | null; expiresAt: number | null; token: string; reauth?: string; busy?: boolean; gone?: boolean };
function fakeStore(accounts: Record<string, Account>) {
  const leases = new Map<string, string>();
  const calls: Array<[string, ...unknown[]]> = [];
  let n = 0;
  const store: RefreshStore = {
    claim(id) {
      calls.push(["claim", id]);
      const a = accounts[id];
      if (!a || a.gone) return Promise.resolve(null);
      if (a.busy || [...leases.values()].includes(id)) return Promise.resolve("busy");
      const lease = `lease-${++n}`;
      leases.set(lease, id);
      const claim: RefreshClaim = { lease, credentialVersion: a.version, issuedAt: a.issuedAt, expiresAt: a.expiresAt, accessToken: a.token };
      return Promise.resolve(claim);
    },
    commit(lease, version, next) {
      calls.push(["commit", lease, version, next.expiresAt]);
      const a = accounts[leases.get(lease) ?? ""];
      if (!a || a.gone || a.version !== version) return Promise.resolve("conflict");
      a.token = next.accessToken; a.expiresAt = next.expiresAt; a.issuedAt = next.refreshedAt; a.version = `${version}+1`;
      return Promise.resolve("committed");
    },
    markReauthRequired(lease, version, code) {
      calls.push(["reauth", lease, version, code]);
      const a = accounts[leases.get(lease) ?? ""];
      if (a && a.version === version) a.reauth = code;
      return Promise.resolve();
    },
    release(lease) { calls.push(["release", lease]); leases.delete(lease); return Promise.resolve(); },
  };
  return { store, calls, leases };
}
function fakeFetch(answer: () => Promise<Response> | Response) {
  const urls: string[] = [];
  return { urls, fetch: (url: string, _init: RequestInit) => { urls.push(url); return Promise.resolve(answer()); } };
}
const due = (over: Partial<Account> = {}): Account => ({ owner: "brand-A", version: "v1", issuedAt: NOW - 50 * DAY, expiresAt: NOW + 5 * DAY, token: OLD, ...over });
const scan = (value: unknown) => assert.ok(!JSON.stringify(value).includes(OLD) && !JSON.stringify(value).includes(NEW), "no token in results or store calls (except the commit payload, not recorded)");

test("disabled by default: no store access and no network", async () => {
  const s = fakeStore({ a: due() }); const f = fakeFetch(() => new Response(ok200()));
  assert.equal(await createThreadsTokenRefresher({ store: s.store, fetch: f.fetch, now: () => NOW }).refresh("a"), "disabled");
  assert.deepEqual(s.calls, []); assert.deepEqual(f.urls, []);
});

test("a due token is refreshed once, stored by compare-and-set, the lease released; nothing secret in results", async () => {
  const accounts = { a: due() };
  const s = fakeStore(accounts); const f = fakeFetch(() => new Response(ok200()));
  const result = await createThreadsTokenRefresher({ store: s.store, fetch: f.fetch, now: () => NOW, enabled: true }).refresh("a");
  assert.equal(result, "refreshed");
  assert.equal(f.urls.length, 1);
  assert.equal(accounts.a.token, NEW); assert.equal(accounts.a.version, "v1+1"); assert.equal(accounts.a.expiresAt, NOW + 60 * 86400 * 1000);
  assert.equal(s.leases.size, 0, "released");
  scan([result, s.calls]);
});

test("concurrent refreshes of one account: one network call; the other run is told busy", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const s = fakeStore({ a: due() });
  const f = fakeFetch(async () => { await gate; return new Response(ok200()); });
  const refresher = createThreadsTokenRefresher({ store: s.store, fetch: f.fetch, now: () => NOW, enabled: true });
  const first = refresher.refresh("a");
  await new Promise((r) => setTimeout(r, 0));
  const second = await refresher.refresh("a");
  release();
  assert.deepEqual([await first, second], ["refreshed", "busy"]);
  assert.equal(f.urls.length, 1);
});

test("a publish, delete, disconnect or cleanup in flight holds the account: the refresh does nothing", async () => {
  const s = fakeStore({ a: due({ busy: true }) }); const f = fakeFetch(() => new Response(ok200()));
  assert.equal(await createThreadsTokenRefresher({ store: s.store, fetch: f.fetch, now: () => NOW, enabled: true }).refresh("a"), "busy");
  assert.deepEqual(f.urls, []);
});

test("disconnected, deleted, service ended or moved to another workspace before the run: gone, no network", async () => {
  const s = fakeStore({ a: due({ gone: true }) }); const f = fakeFetch(() => new Response(ok200()));
  assert.equal(await createThreadsTokenRefresher({ store: s.store, fetch: f.fetch, now: () => NOW, enabled: true }).refresh("a"), "gone");
  assert.equal(await createThreadsTokenRefresher({ store: s.store, fetch: f.fetch, now: () => NOW, enabled: true }).refresh("unknown"), "gone");
  assert.deepEqual(f.urls, []);
});

test("the account changed while Meta answered (reconnect / rebinding / deletion): the new token is discarded, nothing written", async () => {
  const accounts = { a: due() };
  const s = fakeStore(accounts);
  const f = fakeFetch(() => { accounts.a.version = "v2-reconnected"; accounts.a.owner = "brand-B"; return new Response(ok200()); });
  assert.equal(await createThreadsTokenRefresher({ store: s.store, fetch: f.fetch, now: () => NOW, enabled: true }).refresh("a"), "conflict");
  assert.equal(accounts.a.token, OLD, "never stored over another credential or for another workspace");
  assert.equal(s.leases.size, 0);
});

test("revoked or invalid token (OAuthException 190): marked for reconnect once; the stored credential is not replaced", async () => {
  const accounts = { a: due() };
  const s = fakeStore(accounts);
  const f = fakeFetch(() => new Response(JSON.stringify({ error: { type: "OAuthException", code: 190, message: `revoked ${OLD}` } }), { status: 400 }));
  assert.equal(await createThreadsTokenRefresher({ store: s.store, fetch: f.fetch, now: () => NOW, enabled: true }).refresh("a"), "reauth_required");
  assert.equal(accounts.a.reauth, "THREADS_REFRESH_TOKEN_INVALID"); assert.equal(accounts.a.token, OLD);
  assert.equal(s.calls.filter((c) => c[0] === "reauth").length, 1);
  scan(s.calls);
});

test("expired or unknown expiry: reconnect without any network call", async () => {
  for (const over of [{ expiresAt: NOW - 1 }, { expiresAt: null }, { issuedAt: null }]) {
    const accounts = { a: due(over) };
    const s = fakeStore(accounts); const f = fakeFetch(() => new Response(ok200()));
    assert.equal(await createThreadsTokenRefresher({ store: s.store, fetch: f.fetch, now: () => NOW, enabled: true }).refresh("a"), "reauth_required");
    assert.deepEqual(f.urls, []); assert.equal(accounts.a.reauth, "THREADS_TOKEN_EXPIRED_OR_UNKNOWN");
  }
});

test("network failure, rate limit, 5xx or a malformed 200: uncertain, old credential kept, lease released, nothing concluded", async () => {
  const answers: Array<() => Response> = [
    () => { throw new TypeError(`offline ${OLD}`); },
    () => new Response("{}", { status: 429 }),
    () => new Response("oops", { status: 503 }),
    () => new Response(ok200({ expires_in: 0 }), { status: 200 }),
    () => new Response("not json", { status: 200 }),
  ];
  for (const answer of answers) {
    const accounts = { a: due() };
    const s = fakeStore(accounts); const f = fakeFetch(answer);
    const result = await createThreadsTokenRefresher({ store: s.store, fetch: f.fetch, now: () => NOW, enabled: true }).refresh("a");
    assert.equal(result, "uncertain");
    assert.equal(accounts.a.token, OLD); assert.equal(accounts.a.reauth, undefined);
    assert.equal(s.calls.some((c) => c[0] === "commit" || c[0] === "reauth"), false);
    assert.equal(s.leases.size, 0);
  }
});

test("not due / too young: no network call, lease released", async () => {
  for (const over of [{ expiresAt: NOW + 30 * DAY }, { issuedAt: NOW - 1000, expiresAt: NOW + 2 * DAY }]) {
    const s = fakeStore({ a: due(over) }); const f = fakeFetch(() => new Response(ok200()));
    const result = await createThreadsTokenRefresher({ store: s.store, fetch: f.fetch, now: () => NOW, enabled: true }).refresh("a");
    assert.ok(result === "not_due" || result === "too_young");
    assert.deepEqual(f.urls, []); assert.equal(s.leases.size, 0);
  }
});

test("each account is refreshed with its own credential only (no cross-account or cross-workspace use)", async () => {
  const bToken = NEW.replace("NEW", "BBB");
  const accounts = { a: due({ owner: "brand-A", token: OLD }), b: due({ owner: "brand-B", token: bToken }) };
  const s = fakeStore(accounts); const f = fakeFetch(() => new Response(ok200()));
  const refresher = createThreadsTokenRefresher({ store: s.store, fetch: f.fetch, now: () => NOW, enabled: true });
  await refresher.refresh("b");
  assert.equal(new URL(f.urls[0]).searchParams.get("access_token"), bToken, "b's request carries b's own credential");
  assert.equal(accounts.a.token, OLD, "account a untouched");
});
