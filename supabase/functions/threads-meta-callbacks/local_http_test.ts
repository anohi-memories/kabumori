// G4-02 #10 (Issue #561): the Edge over real local HTTP. Loopback only; every other host is denied by permissions:
//   deno test --no-config --cached-only --allow-net=127.0.0.1 supabase/functions/threads-meta-callbacks/local_http_test.ts
// The store here is NON-DURABLE and test-only: it never says a deletion is completed and never claims Meta was told
// anything (there is nothing to tell). It shows the HTTP contract, not a deployable store.
import assert from "node:assert/strict";
import test from "node:test";
import { createGatedHandler, createHandler, type Env, type StoreLoader } from "./http.ts";
import { signedRequest } from "../../tests/postona_threads_meta_callback_contract_test.ts";

const SECRET = "fake-threads-app-secret-0123456789abcdef";
const env = (values: Record<string, string>) => {
  const reads: string[] = [];
  const get = (n: string) => {
    reads.push(n);
    return values[n];
  };
  return { reads, env: { get } satisfies Env };
};
const configured = {
  THREADS_APP_SECRET: SECRET,
  THREADS_META_DELETION_STATUS_URL: "https://postona.example/threads/deletion",
};

/** In memory only. Keyed like the durable store must be: one stop per (account, event), one code per account. */
function nonDurableTestStore(options: { down?: boolean } = {}) {
  const stops = new Set<string>();
  const codes = new Map<string, string>();
  const loader: StoreLoader = () => ({
    accountByProviderUser: (id) =>
      options.down
        ? Promise.reject(new Error("db down"))
        : Promise.resolve(id === "1784140000000001" ? "sa_threads_alice" : null),
    markDeauthorized: (account, event) => {
      stops.add(`${account}:${event.kind}:${event.eventKey}`);
      return Promise.resolve();
    },
    requestDeletion: (account, user) => {
      const key = account ?? `unknown:${user}`;
      if (!codes.has(key)) codes.set(key, `Rcv${crypto.randomUUID().replaceAll("-", "")}`);
      return Promise.resolve(codes.get(key)!);
    },
    // Recorded, never "completed": the deletion itself belongs to G5 T10 and does not exist here.
    deletionStatus: (code) => Promise.resolve([...codes.values()].includes(code) ? "received" : null),
  });
  return { loader, stops, codes };
}

async function serve(handler: (r: Request) => Promise<Response>, run: (base: string) => Promise<void>) {
  const ac = new AbortController();
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, signal: ac.signal, onListen: () => {} }, handler);
  try {
    await run(`http://127.0.0.1:${server.addr.port}/functions/v1/threads-meta-callbacks`);
  } finally {
    ac.abort();
    await server.finished;
  }
}
const form = (body: string, type = "application/x-www-form-urlencoded") => ({
  method: "POST",
  headers: { "content-type": type },
  body,
});
const signedBody = async (user = "1784140000000001", secret = SECRET) =>
  new URLSearchParams({
    signed_request: await signedRequest(secret, {
      algorithm: "HMAC-SHA256",
      issued_at: Math.floor(Date.now() / 1000),
      user_id: user,
    }),
  }).toString();
async function call(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  const text = await res.text();
  return { status: res.status, text, cache: res.headers.get("cache-control"), json: () => JSON.parse(text) };
}

test("permissions: only loopback is reachable from this process (Meta / Threads hosts are denied)", async () => {
  for (const host of ["graph.threads.net", "graph.facebook.com", "www.facebook.com"]) {
    assert.notEqual((await Deno.permissions.query({ name: "net", host })).state, "granted", host);
  }
  await assert.rejects(() => fetch("https://graph.threads.net/me"), Deno.errors.NotCapable);
});

test("the deployable entry over HTTP: every route and method is 503 DISABLED; the environment is never read", async () => {
  const { env: e, reads } = env(configured);
  await serve(createHandler(e), async (base) => {
    for (
      const [path, init] of [
        ["/deauthorize", form(await signedBody())],
        ["/data-deletion", form(await signedBody())],
        ["/deletion-status?code=Code0123456789ab", undefined],
        ["/revoke", form("")],
        ["/deauthorize", { method: "GET" }],
      ] as const
    ) {
      const res = await call(base + path, init);
      assert.equal(res.status, 503, path);
      assert.deepEqual(res.json(), { ok: false, error: "THREADS_META_CALLBACKS_DISABLED" });
      assert.equal(res.cache, "no-store");
    }
  });
  assert.deepEqual(reads, []);
});

test("gate lifted with a non-durable test store, over HTTP: the whole contract", async () => {
  const store = nonDurableTestStore();
  await serve(createGatedHandler(true, env(configured).env, store.loader), async (base) => {
    // deauthorize: 204, no body, a known or an unknown person alike
    const known = await call(`${base}/deauthorize`, form(await signedBody()));
    const unknown = await call(`${base}/deauthorize`, form(await signedBody("1784149999999999")));
    assert.deepEqual([known.status, known.text, unknown.status, unknown.text], [204, "", 204, ""]);
    // data deletion: { url, confirmation_code }; the same request again: the same answer
    const body = await signedBody();
    const first = await call(`${base}/data-deletion`, form(body));
    const again = await call(`${base}/data-deletion`, form(body));
    assert.equal(first.status, 200);
    const answer = first.json();
    assert.deepEqual(Object.keys(answer).sort(), ["confirmation_code", "url"]);
    assert.deepEqual(again.json(), answer);
    assert.equal(answer.url, `https://postona.example/threads/deletion?code=${answer.confirmation_code}`);
    assert.equal(first.text.includes("1784140000000001") || first.text.includes(SECRET), false);
    // an unknown person: the same shape (no enumeration)
    const stranger = await call(`${base}/data-deletion`, form(await signedBody("1784149999999999")));
    assert.deepEqual([stranger.status, Object.keys(stranger.json()).sort()], [200, ["confirmation_code", "url"]]);
    // status: only "received" (never completed here); an unknown code looks like any other unknown
    const status = await call(`${base}/deletion-status?code=${answer.confirmation_code}`);
    assert.deepEqual(status.json(), { confirmation_code: answer.confirmation_code, status: "received" });
    assert.deepEqual((await call(`${base}/deletion-status?code=Nope0123456789`)).json(), {
      confirmation_code: "Nope0123456789",
      status: "unknown",
    });
    // refusals: fixed codes, nothing recorded
    const stopsBefore = store.stops.size;
    const codesBefore = store.codes.size;
    for (
      const [path, init, status, error] of [
        [
          "/deauthorize",
          form(await signedBody("1784140000000001", "not-the-app-secret-0123456789abcdef")),
          400,
          "INVALID_SIGNED_REQUEST",
        ],
        ["/data-deletion", form("signed_request=abc.def"), 400, "INVALID_SIGNED_REQUEST"],
        ["/data-deletion", form(`${body}&${body}`), 400, "INVALID_SIGNED_REQUEST"],
        ["/data-deletion", form(body, "application/json"), 415, "UNSUPPORTED_MEDIA_TYPE"],
        ["/data-deletion", form("signed_request=" + "a".repeat(9000)), 413, "PAYLOAD_TOO_LARGE"],
        ["/deauthorize", { method: "GET" }, 405, "METHOD_NOT_ALLOWED"],
        ["/deletion-status?code=x", undefined, 400, "INVALID_CODE"],
        ["/revoke", form(body), 404, "NOT_FOUND"],
      ] as const
    ) {
      const res = await call(base + path, init);
      assert.deepEqual([res.status, res.json()], [status, { ok: false, error }], path);
      assert.equal(res.cache, "no-store");
    }
    assert.deepEqual([store.stops.size, store.codes.size], [stopsBefore, codesBefore]);
    // Stops recorded: one per (account, event); the stranger's requests stopped nothing.
    assert.deepEqual([...store.stops].map((s) => s.split(":").slice(0, 2).join(":")).sort(), [
      "sa_threads_alice:data_deletion_request",
      "sa_threads_alice:deauthorization",
    ]);
  });
});

test("a store that is down, over HTTP: 503 STORE_UNAVAILABLE, never acknowledged, no detail", async () => {
  await serve(
    createGatedHandler(true, env(configured).env, nonDurableTestStore({ down: true }).loader),
    async (base) => {
      for (const route of ["deauthorize", "data-deletion"]) {
        const res = await call(`${base}/${route}`, form(await signedBody()));
        assert.deepEqual([res.status, res.json()], [503, { ok: false, error: "STORE_UNAVAILABLE" }]);
        assert.equal(res.text.includes("db down"), false);
      }
    },
  );
});
