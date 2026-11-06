// Offline: run with no --allow-net and no --allow-env (only --allow-read for the isolation scan):
//   deno test --no-config --cached-only --allow-read=. supabase/functions/_shared/social/threads_meta_callback_test.ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  createThreadsDeletionStatusHandler,
  createThreadsMetaCallbackHandler,
  THREADS_META_CALLBACKS_ENABLED,
  type ThreadsMetaCallbackStore,
  verifySignedRequest,
} from "./threads_meta_callback.ts";
import { b64url, metaCallbackViolations, signedRequest } from "../../../tests/postona_threads_meta_callback_contract_test.ts";

const SECRET = "fake-threads-app-secret-0123456789abcdef";
const NOW = 1_760_800_000;
const STATUS_URL = "https://postona.example/threads/deletion";
const ok = (user = "1784140000000001", extra: Record<string, unknown> = {}) => ({
  algorithm: "HMAC-SHA256",
  issued_at: NOW,
  user_id: user,
  ...extra,
});
const form = (body: string, type = "application/x-www-form-urlencoded") =>
  new Request("https://edge.example/threads-meta-callbacks/data-deletion", {
    method: "POST",
    headers: { "content-type": type },
    body,
  });
const signedForm = async (payload: unknown, secret = SECRET) =>
  form(new URLSearchParams({ signed_request: await signedRequest(secret, payload) }).toString());

function recordingStore(overrides: Partial<ThreadsMetaCallbackStore> = {}) {
  const calls: string[] = [];
  const store: ThreadsMetaCallbackStore = {
    accountByProviderUser: (id) => {
      calls.push(`lookup ${id}`);
      return Promise.resolve(id === "1784140000000001" ? "sa_threads_alice" : null);
    },
    markDeauthorized: (account, event) => {
      calls.push(`deauthorize ${account} ${event.kind}`);
      return Promise.resolve();
    },
    requestDeletion: (account, user) => {
      calls.push(`delete ${account} ${user}`);
      return Promise.resolve("Code0123456789ab");
    },
    ...overrides,
  };
  return { store, calls };
}
const handlerWith = (store: ThreadsMetaCallbackStore, extra: Partial<Parameters<typeof createThreadsMetaCallbackHandler>[0]> = {}) =>
  createThreadsMetaCallbackHandler({ appSecret: SECRET, store, statusBaseUrl: STATUS_URL, now: () => NOW, ...extra });

test("the static gate is false", () => {
  assert.equal(THREADS_META_CALLBACKS_ENABLED, false);
});

test("the handler meets the Meta callback contract M1-M7", async () => {
  assert.deepEqual(await metaCallbackViolations((deps) => createThreadsMetaCallbackHandler({ ...deps, now: () => NOW })), []);
});

test("signed request: well-formed fields only", async () => {
  const verify = async (payload: unknown, secret = SECRET) => verifySignedRequest(await signedRequest(secret, payload), SECRET, NOW);
  const fields = (v: Awaited<ReturnType<typeof verifySignedRequest>>) => v && { userId: v.userId, issuedAt: v.issuedAt };
  assert.deepEqual(fields(await verify(ok())), { userId: "1784140000000001", issuedAt: NOW });
  // `expires` is the token's expiry in Meta's signed requests (0 = does not expire): ignored, never a refusal.
  assert.deepEqual(fields(await verify(ok("1784140000000001", { expires: 0, extra: "ignored" }))), { userId: "1784140000000001", issuedAt: NOW });
  for (const bad of [
    ok(1784140000000001 as unknown as string), // a number loses precision: refused
    ok("01784140000000001"),
    ok("123456789012345678901"),
    ok("1784140000000001", { issued_at: undefined }),
    ok("1784140000000001", { issued_at: "1760800000" }),
    ok("1784140000000001", { issued_at: -1 }),
    ok("1784140000000001", { issued_at: 1.5 }),
    ok("1784140000000001", { issued_at: NOW + 601 }),
    ok("1784140000000001", { algorithm: "hmac-sha256" }),
    [ok()],
    null,
    "text",
  ]) {
    assert.equal(await verify(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(fields(await verify(ok("1784140000000001", { issued_at: NOW + 600 }))), { userId: "1784140000000001", issuedAt: NOW + 600 });
  const good = await signedRequest(SECRET, ok());
  const [sig, body] = good.split(".");
  for (const bad of [`${sig}.${body}.x`, `${sig.slice(0, -2)}.${body}`, `${sig}==.${body}`, `.${body}`, `${sig}.`, `${sig} .${body}`]) {
    assert.equal(await verifySignedRequest(bad, SECRET, NOW), null, bad);
  }
  const invalidUtf8 = b64url(new Uint8Array([0x7b, 0xff, 0x7d]));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sigUtf8 = b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(invalidUtf8))));
  assert.equal(await verifySignedRequest(`${sigUtf8}.${invalidUtf8}`, SECRET, NOW), null);
});

test("transport refusals come before the store and carry only a fixed code", async () => {
  const { store, calls } = recordingStore();
  const handler = handlerWith(store);
  const good = await signedRequest(SECRET, ok());
  const cases: [Request, number, string][] = [
    [form(new URLSearchParams({ signed_request: good }).toString(), "application/json"), 415, "UNSUPPORTED_MEDIA_TYPE"],
    [form(`signed_request=${good}&signed_request=${good}`), 400, "INVALID_SIGNED_REQUEST"],
    [form(`signed_request=${good}${"x".repeat(9000)}`), 413, "PAYLOAD_TOO_LARGE"],
    [form(""), 400, "INVALID_SIGNED_REQUEST"],
    [new Request("https://edge.example/x", { method: "PUT", body: "a" }), 405, "METHOD_NOT_ALLOWED"],
  ];
  for (const [request, status, error] of cases) {
    for (const kind of ["deauthorize", "data_deletion"] as const) {
      const res = await handler(kind, request.clone());
      assert.equal(res.status, status, error);
      assert.deepEqual(await res.json(), { ok: false, error });
      assert.equal(res.headers.get("cache-control"), "no-store");
    }
  }
  assert.deepEqual(calls, []);
});

test("a bad configuration refuses before reading the request or the store", async () => {
  const { store, calls } = recordingStore();
  for (const extra of [{ appSecret: "short" }, { appSecret: "has a space 0123456789" }, { statusBaseUrl: "http://postona.example/d" }, {
    statusBaseUrl: "https://postona.example/d?user=1",
  }, { statusBaseUrl: "https://u:p@postona.example/d" }, { statusBaseUrl: "not a url" }]) {
    const res = await handlerWith(store, extra)("data_deletion", await signedForm(ok()));
    assert.equal(res.status, 503, JSON.stringify(extra));
    assert.deepEqual(await res.json(), { ok: false, error: "CONFIG_UNAVAILABLE" });
  }
  assert.deepEqual(calls, []);
});

test("deauthorize: 204 with no body for a known or an unknown person; only the bound account is stopped", async () => {
  const { store, calls } = recordingStore();
  const handler = handlerWith(store);
  const known = await handler("deauthorize", await signedForm(ok()));
  const unknown = await handler("deauthorize", await signedForm(ok("1784149999999999")));
  for (const res of [known, unknown]) {
    assert.equal(res.status, 204);
    assert.equal(await res.text(), "");
  }
  assert.deepEqual(calls, ["lookup 1784140000000001", "deauthorize sa_threads_alice deauthorization", "lookup 1784149999999999"]);
});

test("data deletion: the answer carries the store's code and the status URL, never the user id", async () => {
  const { store, calls } = recordingStore();
  const res = await handlerWith(store)("data_deletion", await signedForm(ok()));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { url: `${STATUS_URL}?code=Code0123456789ab`, confirmation_code: "Code0123456789ab" });
  assert.deepEqual(calls, [
    "lookup 1784140000000001",
    "deauthorize sa_threads_alice data_deletion_request", // G4-02 #10: stopped first
    "delete sa_threads_alice 1784140000000001",
  ]);
});

test("a store that does not answer in time is 503, never acknowledged", async () => {
  const never = () => new Promise<never>(() => {});
  for (const overrides of [{ accountByProviderUser: never }, { markDeauthorized: never }, { requestDeletion: never }]) {
    const { store } = recordingStore(overrides);
    for (const kind of ["deauthorize", "data_deletion"] as const) {
      const res = await handlerWith(store, { storeTimeoutMs: 20 })(kind, await signedForm(ok()));
      // A method the kind never calls cannot block it (data deletion now calls all three).
      const expectAck = kind === "deauthorize" && "requestDeletion" in overrides;
      assert.equal(res.status, expectAck ? (kind === "deauthorize" ? 204 : 200) : 503, `${kind} ${Object.keys(overrides)}`);
      if (!expectAck) assert.deepEqual(await res.json(), { ok: false, error: "STORE_UNAVAILABLE" });
    }
  }
});

test("deletion status: only what the store recorded; unknown codes look alike; refusals are fixed codes", async () => {
  const seen: string[] = [];
  const states: Record<string, "received" | "in_progress" | "completed"> = {
    Recv0123456789ab: "received",
    Prog0123456789ab: "in_progress",
    Done0123456789ab: "completed",
  };
  const handler = createThreadsDeletionStatusHandler({
    store: {
      deletionStatus: (code) => {
        seen.push(code);
        return Promise.resolve(states[code] ?? null);
      },
    },
  });
  const get = (query: string, method = "GET") => handler(new Request(`https://edge.example/threads-meta-callbacks/deletion-status${query}`, { method }));
  for (const [code, status] of [...Object.entries(states), ["Unkn0123456789ab", "unknown"]]) {
    const res = await get(`?code=${code}`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { confirmation_code: code, status });
  }
  for (const query of ["", "?code=", "?code=short", "?code=has%20space%201234", "?code=a&code=b", `?code=${"x".repeat(65)}`]) {
    const res = await get(query);
    assert.equal(res.status, 400, query);
    assert.deepEqual(await res.json(), { ok: false, error: "INVALID_CODE" });
  }
  assert.equal((await get("?code=Recv0123456789ab", "POST")).status, 405);
  assert.deepEqual(seen, [...Object.keys(states), "Unkn0123456789ab"]);

  const odd = createThreadsDeletionStatusHandler({ store: { deletionStatus: () => Promise.resolve("deleted" as "completed") } });
  assert.equal((await odd(new Request("https://edge.example/s?code=Recv0123456789ab"))).status, 503);
  const down = createThreadsDeletionStatusHandler({ store: { deletionStatus: () => Promise.reject(new Error("db: secret detail")) } });
  const res = await down(new Request("https://edge.example/s?code=Recv0123456789ab"));
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { ok: false, error: "STORE_UNAVAILABLE" });
  const slow = createThreadsDeletionStatusHandler({ store: { deletionStatus: () => new Promise<never>(() => {}) }, storeTimeoutMs: 20 });
  assert.equal((await slow(new Request("https://edge.example/s?code=Recv0123456789ab"))).status, 503);
});

test("isolation: the module imports nothing; only its Edge entry and tests import it", async () => {
  const source = await Deno.readTextFile(new URL("./threads_meta_callback.ts", import.meta.url));
  assert.equal(/^\s*(import|export\s+\*|export\s+\{[^}]*\}\s+from)\b/mu.test(source), false);
  assert.equal(/\b(fetch|Deno\.|console\.)/u.test(source.replace(/^\s*\/\/.*$/gmu, "")), false);
  const root = new URL("../../../../", import.meta.url);
  const importers: string[] = [];
  async function walk(dir: URL, rel: string) {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const path = `${rel}${entry.name}`;
      if (entry.isDirectory) await walk(new URL(`${entry.name}/`, dir), `${path}/`);
      else if (/\.(ts|tsx|mjs|js)$/u.test(entry.name) && /["'][^"']*threads_meta_callback(\.ts)?["']/u.test(await Deno.readTextFile(new URL(entry.name, dir)))) {
        importers.push(path);
      }
    }
  }
  await walk(new URL("supabase/", root), "supabase/");
  await walk(new URL("apps/", root), "apps/");
  assert.deepEqual(importers.sort(), [
    "supabase/functions/_shared/social/threads_meta_callback_test.ts",
    "supabase/functions/threads-meta-callbacks/http.ts",
  ]);
});

// --- G4-02 #10 (Issue #561): typed events, replay, cross-account, stop-before-delete, no logs, no network ---------------

type Recorded = { method: string; account: string | null; event: Record<string, unknown> };
function eventStore(accounts: Record<string, string> = { "1784140000000001": "sa_threads_alice" }) {
  const seen: Recorded[] = [];
  const stopped = new Set<string>();
  const stopKeys = new Set<string>();
  const codes = new Map<string, string>();
  const store: ThreadsMetaCallbackStore = {
    accountByProviderUser: (id) => Promise.resolve(accounts[id] ?? null),
    markDeauthorized: (account, event) => {
      seen.push({ method: "stop", account, event: { ...event } });
      stopKeys.add(`${account}:${event.eventKey}`);
      stopped.add(account);
      return Promise.resolve();
    },
    requestDeletion: (account, user, event) => {
      seen.push({ method: "delete", account, event: { ...event } });
      const key = account ?? `unknown:${user}`;
      if (!codes.has(key)) codes.set(key, `Code${String(codes.size).padStart(12, "0")}`);
      return Promise.resolve(codes.get(key)!);
    },
  };
  return { store, seen, stopped, stopKeys, codes };
}

test("events: deauthorization and data deletion request are separate typed events keyed by the signed payload", async () => {
  const { store, seen } = eventStore();
  const handler = handlerWith(store);
  const signed = await signedRequest(SECRET, ok());
  const body = new URLSearchParams({ signed_request: signed }).toString();
  await handler("deauthorize", form(body));
  await handler("data_deletion", form(body));
  const expectedKey = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(signed.split(".")[1]))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
  assert.deepEqual(seen.map((s) => [s.method, s.account, s.event.kind]), [
    ["stop", "sa_threads_alice", "deauthorization"],
    ["stop", "sa_threads_alice", "data_deletion_request"],
    ["delete", "sa_threads_alice", "data_deletion_request"],
  ]);
  for (const s of seen) {
    assert.deepEqual(Object.keys(s.event).sort(), ["eventKey", "issuedAt", "kind", "providerUserId"]);
    assert.equal(s.event.eventKey, expectedKey);
    assert.equal(s.event.providerUserId, "1784140000000001");
    assert.equal(s.event.issuedAt, NOW);
  }
  // Another request (another issued_at) is another event.
  await handler("deauthorize", await signedForm(ok("1784140000000001", { issued_at: NOW - 1 })));
  assert.notEqual(seen.at(-1)!.event.eventKey, expectedKey);
  assert.match(String(seen.at(-1)!.event.eventKey), /^[0-9a-f]{64}$/u);
});

test("replay or Meta's retry of the same signed request: the same answer, nothing new recorded", async () => {
  const { store, stopKeys, codes } = eventStore();
  const handler = handlerWith(store);
  const body = new URLSearchParams({ signed_request: await signedRequest(SECRET, ok()) }).toString();
  const first = await handler("data_deletion", form(body));
  const second = await handler("data_deletion", form(body));
  assert.equal(first.status, 200);
  assert.deepEqual(await second.json(), await first.json());
  assert.equal(stopKeys.size, 1);
  assert.equal(codes.size, 1);
  for (let i = 0; i < 2; i += 1) assert.equal((await handler("deauthorize", form(body))).status, 204);
  assert.equal(stopKeys.size, 1, "the same signed payload is the same event for the stop too");
});

test("cross-account: a request signed for one person never touches another person's or another brand's account", async () => {
  const accounts = { "1784140000000001": "sa_threads_brand_a_alice", "1784140000000002": "sa_threads_u_bob" };
  const { store, seen, stopped } = eventStore(accounts);
  const handler = handlerWith(store);
  assert.equal((await handler("deauthorize", await signedForm(ok("1784140000000001")))).status, 204);
  assert.equal((await handler("data_deletion", await signedForm(ok("1784140000000001")))).status, 200);
  assert.deepEqual([...stopped], ["sa_threads_brand_a_alice"]);
  assert.equal(seen.some((s) => s.account === "sa_threads_u_bob" || s.event.providerUserId === "1784140000000002"), false);
  // Bob's id under alice's valid signature (payload swapped), or signed with any other secret: refused, nothing recorded.
  const good = await signedRequest(SECRET, ok("1784140000000001"));
  const swapped = `${good.split(".")[0]}.${b64url(new TextEncoder().encode(JSON.stringify(ok("1784140000000002"))))}`;
  const before = seen.length;
  for (const signed of [swapped, await signedRequest("another-app-secret-0123456789abcdef", ok("1784140000000002"))]) {
    for (const kind of ["deauthorize", "data_deletion"] as const) {
      const res = await handler(kind, form(new URLSearchParams({ signed_request: signed }).toString()));
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { ok: false, error: "INVALID_SIGNED_REQUEST" });
    }
  }
  assert.equal(seen.length, before);
  assert.deepEqual([...stopped], ["sa_threads_brand_a_alice"]);
});

test("data deletion stops the account before recording; a failure at either step is 503 and no code is invented", async () => {
  const detail = "relation social_accounts: permission denied sa_threads_alice 1784140000000001";
  const order: string[] = [];
  const stopFails = recordingStore({
    markDeauthorized: () => {
      order.push("stop");
      return Promise.reject(new Error(detail));
    },
    requestDeletion: () => {
      order.push("delete");
      return Promise.resolve("Code0123456789ab");
    },
  });
  const res1 = await handlerWith(stopFails.store)("data_deletion", await signedForm(ok()));
  assert.equal(res1.status, 503);
  assert.deepEqual(order, ["stop"], "nothing is recorded as requested when the stop failed");
  const recordFails = recordingStore({ requestDeletion: () => Promise.reject(new Error(detail)) });
  const res2 = await handlerWith(recordFails.store)("data_deletion", await signedForm(ok()));
  assert.equal(res2.status, 503);
  const text = await res2.text();
  assert.equal(text.includes("permission denied") || text.includes("1784140000000001") || text.includes("Code"), false);
  assert.deepEqual(recordFails.calls, ["lookup 1784140000000001", "deauthorize sa_threads_alice data_deletion_request"]);
  // An unknown person: nothing to stop; the request is still recorded (no enumeration).
  const unknown = recordingStore();
  assert.equal((await handlerWith(unknown.store)("data_deletion", await signedForm(ok("1784149999999999")))).status, 200);
  assert.deepEqual(unknown.calls, ["lookup 1784149999999999", "delete null 1784149999999999"]);
});

test("nothing is logged and nothing goes out, on every path (success, refusal, failure, timeout)", async () => {
  const methods = ["log", "info", "warn", "error", "debug", "trace"] as const;
  const original = Object.fromEntries(methods.map((m) => [m, console[m]]));
  const originalFetch = globalThis.fetch;
  let logged = 0;
  let fetched = 0;
  for (const m of methods) console[m] = () => { logged += 1; };
  globalThis.fetch = (() => { fetched += 1; return Promise.reject(new Error("no network")); }) as typeof fetch;
  try {
    const failing = recordingStore({ requestDeletion: () => Promise.reject(new Error("secret token sa_threads_alice")) });
    const hanging = recordingStore({ accountByProviderUser: () => new Promise<never>(() => {}) });
    for (const handler of [handlerWith(recordingStore().store), handlerWith(failing.store), handlerWith(hanging.store, { storeTimeoutMs: 10 })]) {
      for (const kind of ["deauthorize", "data_deletion"] as const) {
        for (const req of [
          await signedForm(ok()),
          await signedForm(ok(), "not-the-app-secret-0123456789abcdef"),
          form("signed_request=a.b"),
          form("x".repeat(9000)),
          form("", "application/json"),
        ]) await (await handler(kind, req)).body?.cancel();
      }
    }
    const status = createThreadsDeletionStatusHandler({ store: { deletionStatus: () => Promise.reject(new Error("db down")) } });
    await (await status(new Request("https://edge.example/x/deletion-status?code=Code0123456789ab"))).body?.cancel();
  } finally {
    for (const m of methods) console[m] = original[m];
    globalThis.fetch = originalFetch;
  }
  assert.equal(logged, 0);
  assert.equal(fetched, 0);
});
