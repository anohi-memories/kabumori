// Offline: run with no --allow-net and no --allow-env (read only, for the index.ts check):
//   deno test --no-config --cached-only --allow-read=. supabase/functions/threads-meta-callbacks/http_test.ts
import assert from "node:assert/strict";
import test from "node:test";
import { createGatedHandler, createHandler, type Env, noDurableStore, type StoreLoader } from "./http.ts";
import { signedRequest } from "../../tests/postona_threads_meta_callback_contract_test.ts";

const SECRET = "fake-threads-app-secret-0123456789abcdef";
const fullEnv: Record<string, string> = {
  THREADS_APP_SECRET: SECRET,
  THREADS_META_DELETION_STATUS_URL: "https://postona.example/threads/deletion",
};
function recordingEnv(values: Record<string, string> = fullEnv) {
  const reads: string[] = [];
  const env: Env = {
    get: (name) => {
      reads.push(name);
      return values[name];
    },
  };
  return { env, reads };
}
function fakeStore() {
  const calls: string[] = [];
  let loads = 0;
  const loader: StoreLoader = () => {
    loads += 1;
    return {
      accountByProviderUser: (id) => {
        calls.push(`lookup ${id}`);
        return Promise.resolve(id === "1784140000000001" ? "sa_threads_alice" : null);
      },
      markDeauthorized: (a) => {
        calls.push(`deauthorize ${a}`);
        return Promise.resolve();
      },
      requestDeletion: (a, u) => {
        calls.push(`delete ${a} ${u}`);
        return Promise.resolve("Code0123456789ab");
      },
      deletionStatus: (c) => {
        calls.push(`status ${c}`);
        return Promise.resolve("received");
      },
    };
  };
  return { loader, calls, loads: () => loads };
}
const signed = async () =>
  new URLSearchParams({
    signed_request: await signedRequest(SECRET, {
      algorithm: "HMAC-SHA256",
      issued_at: Math.floor(Date.now() / 1000),
      user_id: "1784140000000001",
    }),
  }).toString();
const post = (route: string, body: string) =>
  new Request(`https://edge.example/threads-meta-callbacks/${route}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

test("the deployable entry is closed whatever the environment says: 503 before env, body or store", async () => {
  const { env, reads } = recordingEnv();
  const store = fakeStore();
  const handler = createHandler(env, store.loader);
  const body = await signed();
  const requests = [
    post("deauthorize", body),
    post("data-deletion", body),
    new Request("https://edge.example/threads-meta-callbacks/deletion-status?code=Code0123456789ab"),
    new Request("https://edge.example/threads-meta-callbacks/anything", { method: "OPTIONS" }),
  ];
  for (const request of requests) {
    const res = await handler(request);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { ok: false, error: "THREADS_META_CALLBACKS_DISABLED" });
    assert.equal(request.bodyUsed, false);
  }
  assert.deepEqual(reads, []);
  assert.equal(store.loads(), 0);
  assert.deepEqual(store.calls, []);
});

test("with the gate lifted there is still no durable store: 503 STORE_UNAVAILABLE, nothing acknowledged", async () => {
  const { env, reads } = recordingEnv();
  const handler = createGatedHandler(true, env, noDurableStore);
  for (const request of [post("deauthorize", await signed()), post("data-deletion", await signed())]) {
    const res = await handler(request);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { ok: false, error: "STORE_UNAVAILABLE" });
  }
  assert.deepEqual(reads, []);
});

test("gate lifted with a fake store: routes reach the handlers; unknown routes are 404; a missing secret is 503", async () => {
  const store = fakeStore();
  const { env } = recordingEnv();
  const handler = createGatedHandler(true, env, store.loader);
  assert.equal((await handler(post("deauthorize", await signed()))).status, 204);
  const deletion = await handler(post("data-deletion/", await signed()));
  assert.deepEqual(await deletion.json(), {
    url: "https://postona.example/threads/deletion?code=Code0123456789ab",
    confirmation_code: "Code0123456789ab",
  });
  const status = await handler(new Request("https://edge.example/threads-meta-callbacks/deletion-status?code=Code0123456789ab"));
  assert.deepEqual(await status.json(), { confirmation_code: "Code0123456789ab", status: "received" });
  for (const route of ["", "deauthorize/extra", "revoke"]) {
    const res = await handler(post(route, await signed()));
    assert.equal(res.status, 404, route);
  }
  assert.deepEqual(store.calls, [
    "lookup 1784140000000001",
    "deauthorize sa_threads_alice",
    "lookup 1784140000000001",
    "delete sa_threads_alice 1784140000000001",
    "status Code0123456789ab",
  ]);
  const noSecret = createGatedHandler(true, recordingEnv({}).env, fakeStore().loader);
  const res = await noSecret(post("data-deletion", await signed()));
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { ok: false, error: "CONFIG_UNAVAILABLE" });
});

test("index.ts only serves the gated entry with the default (absent) store", async () => {
  const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const code = index.replace(/^\s*\/\/.*$/gmu, "").trim();
  assert.equal(code, 'import { createHandler } from "./http.ts";\n\nDeno.serve(createHandler(Deno.env));');
});
