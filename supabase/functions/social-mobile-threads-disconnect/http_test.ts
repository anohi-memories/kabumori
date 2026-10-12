import assert from "node:assert/strict";
import test from "node:test";
import { createHandler } from "./http.ts";

test("the deployable entry is closed whatever the environment says: 503, no Auth or database call", async () => {
  const calls: string[] = [];
  const handler = createHandler(
    { get: (name: string) => ({ SUPABASE_URL: "https://p.example", SUPABASE_ANON_KEY: "anon_public_key" } as Record<string, string>)[name] },
    (url) => {
      calls.push(url);
      return Promise.resolve(new Response("{}", { status: 200 }));
    },
  );
  const response = await handler(new Request("https://edge.example/social-mobile-threads-disconnect", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer offline_dummy" },
    body: JSON.stringify({ action: "disconnect", social_account_id: "sa_th_alice", expected_handle: "alice" }),
  }));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, error: "THREADS_DISCONNECT_DISABLED" });
  assert.deepEqual(calls, []);
});
