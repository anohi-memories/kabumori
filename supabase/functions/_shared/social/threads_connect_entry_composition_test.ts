import assert from "node:assert/strict";
import test from "node:test";
import { createThreadsConnectEntry, loadDefaultComposition, THREADS_CONNECT_ENABLE_ENV } from "./threads_connect_entry.ts";
import { fakeConfig } from "../../../candidates/postona_threads_auth_runtime/wiring/offline.fixture.ts";

// The F4 entry adapter with the REAL H5 composition (actual SDK + driver construction, H5 config validation, G4 HTTP
// contract), offline. Needs H5's import map:
//   deno test --cached-only --config supabase/candidates/postona_threads_auth_runtime/wiring/deno.json \
//     --allow-read=supabase supabase/functions/_shared/social/threads_connect_entry_composition_test.ts
// Run WITHOUT --allow-net: every answer below is decided before any network or database access (an attempt would
// throw and turn into a 503, so the exact codes prove none happened). Dummy values only (H5's offline fixture).
const OPEN = { wired: true };
const canonical: Record<string, string> = {
  [THREADS_CONNECT_ENABLE_ENV]: "true",
  POSTONA_THREADS_PROJECT_URL: fakeConfig.projectUrl,
  POSTONA_THREADS_PROJECT_REF: fakeConfig.projectRef,
  POSTONA_THREADS_PUBLISHABLE_KEY: fakeConfig.publishableKey,
  POSTONA_THREADS_DB_HOST: fakeConfig.hostname,
  POSTONA_THREADS_DB_PORT: String(fakeConfig.port),
  POSTONA_THREADS_DB_NAME: fakeConfig.database,
  POSTONA_THREADS_DB_OWNER: fakeConfig.owner,
  POSTONA_THREADS_DB_PASSWORD: fakeConfig.password,
  POSTONA_THREADS_DB_CA_PEM: fakeConfig.caPem,
  POSTONA_THREADS_APP_ID: fakeConfig.appId,
  POSTONA_THREADS_APP_SECRET: fakeConfig.appSecret,
  POSTONA_THREADS_CALLBACK: fakeConfig.callback,
  POSTONA_THREADS_ATTESTATION_KEY: fakeConfig.attestationKey,
  POSTONA_THREADS_G4_AUTH_PROFILE: "personal", // G4-02 #2: G5's personal MVP (g5pv)
};
const SECRETS = [fakeConfig.password, fakeConfig.appSecret, fakeConfig.attestationKey, fakeConfig.publishableKey];
const request = (body: unknown, auth: string | null = "Bearer caller-jwt-fixture") =>
  new Request("https://edge.example/functions/v1/threads-oauth-connect-user", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) },
    body: JSON.stringify(body),
  });
async function answer(entry: (r: Request) => Response | Promise<Response>, r: Request) {
  const response = await entry(r);
  const text = await response.text();
  for (const secret of SECRETS) assert.ok(!text.includes(secret), "no configured value is echoed");
  return { status: response.status, body: JSON.parse(text) as Record<string, unknown> };
}

test("real composition through the adapter: refusals decided before any network/database access", async () => {
  for (const values of [canonical, aliasVariant()]) {
    const entry = createThreadsConnectEntry({ read: (name) => values[name], gates: OPEN });
    assert.deepEqual(await answer(entry, request({ action: "start" }, null)), { status: 401, body: { ok: false, error: "AUTH_REQUIRED" } });
    assert.deepEqual(await answer(entry, request({ action: "start", userId: "someone-else" })), { status: 400, body: { ok: false, error: "REQUEST_INVALID" } });
    assert.deepEqual(await answer(entry, request({ action: "callback", callback_url: "https://evil.example/?code=x&state=y" })), { status: 400, body: { ok: false, error: "CALLBACK_INVALID" } });
    assert.deepEqual(await answer(entry, request({ action: "callback", callback_url: `${fakeConfig.callback}?code=x&code=y&state=z` })), { status: 400, body: { ok: false, error: "CALLBACK_INVALID" } }, "a duplicated code (replay shape) is refused");
    assert.deepEqual(await answer(entry, request({ action: "callback", callback_url: `${fakeConfig.callback}?code=x&state=z`, social_account_id: "sa_" + "b".repeat(24) })), { status: 400, body: { ok: false, error: "REQUEST_INVALID" } }, "no account id can be smuggled in");
  }
});

test("G4-02 #2 real composition: no (or an unknown) G5 profile -> unavailable, nothing else decided", async () => {
  for (const profile of [undefined, "", "g5oe"]) {
    const values: Record<string, string | undefined> = { ...canonical, POSTONA_THREADS_G4_AUTH_PROFILE: profile };
    const entry = createThreadsConnectEntry({ read: (name) => values[name], gates: OPEN });
    assert.deepEqual(await answer(entry, request({ action: "start" }, null)), { status: 503, body: { ok: false, error: "THREADS_CONNECT_RUNTIME_UNAVAILABLE" } }, String(profile));
  }
  for (const profile of ["full", "personal"]) {
    const entry = createThreadsConnectEntry({ read: (name) => ({ ...canonical, POSTONA_THREADS_G4_AUTH_PROFILE: profile })[name], gates: OPEN });
    assert.deepEqual(await answer(entry, request({ action: "start" }, null)), { status: 401, body: { ok: false, error: "AUTH_REQUIRED" } }, profile);
  }
});

test("real composition: a config H5 refuses (production-like owner, wrong DB host, non-HTTPS callback) fails closed", async () => {
  for (const [name, value] of [["POSTONA_THREADS_DB_OWNER", "postgres"], ["POSTONA_THREADS_DB_OWNER", "service_role"], ["POSTONA_THREADS_DB_HOST", "db.example.com"], ["POSTONA_THREADS_CALLBACK", "http://postona.example/callback"]]) {
    const entry = createThreadsConnectEntry({ read: (n) => (n === name ? value : canonical[n]), gates: OPEN });
    assert.deepEqual(await answer(entry, request({ action: "start" })), { status: 503, body: { ok: false, error: "THREADS_CONNECT_RUNTIME_UNAVAILABLE" } }, `${name}=${value}`);
  }
});

function aliasVariant(): Record<string, string> {
  const values = { ...canonical };
  values.THREADS_APP_ID = values.POSTONA_THREADS_APP_ID; delete values.POSTONA_THREADS_APP_ID;
  values.THREADS_APP_SECRET = values.POSTONA_THREADS_APP_SECRET; delete values.POSTONA_THREADS_APP_SECRET;
  values.THREADS_REDIRECT_URI = values.POSTONA_THREADS_CALLBACK; delete values.POSTONA_THREADS_CALLBACK;
  return values;
}

test("G4-02 #1: past the gates the entry loads G4's composition (G4's owner bridge), not H5's nondeployable", async () => {
  const loaded = await loadDefaultComposition();
  const g4 = await import("../../../candidates/postona_g4_threads_personal_auth/composition.ts");
  assert.equal(loaded, g4, "the default loader is G4's composition module");
  const h5 = await import("../../../candidates/postona_threads_auth_runtime/wiring/nondeployable.ts");
  assert.notEqual(loaded, h5);
  const source = await Deno.readTextFile(new URL("../../../candidates/postona_g4_threads_personal_auth/composition.ts", import.meta.url));
  const code = source.split("\n").filter((line) => !/^\s*(\/\/|\/\*\*|\*)/.test(line)).join("\n");
  assert.match(code, /bridge: createG4ThreadsOwnerBridge\(/, "the runtime's bridge is G4's");
  assert.doesNotMatch(code, /createOwnerTransport|Deno\.(env|serve)/, "no H5 transport, no env read, no serve");
});

test("G4-02 #2: the composition is built only with a pinned G5 profile (full | personal)", async () => {
  const g4 = await import("../../../candidates/postona_g4_threads_personal_auth/composition.ts");
  assert.equal(g4.G4_AUTH_PROFILE_ENV, "POSTONA_THREADS_G4_AUTH_PROFILE");
  assert.equal(g4.g4AuthProfile("full"), "full");
  assert.equal(g4.g4AuthProfile("personal"), "personal");
  for (const value of [undefined, "", "FULL", "g5pv", "personal "]) {
    assert.throws(() => g4.g4AuthProfile(value), String(value));
  }
  // the entry's own seam reads the profile through the same reader as H5's config (the POSTONA_THREADS_ prefix passes it)
  const src = (await Deno.readTextFile(new URL("../../../candidates/postona_g4_threads_personal_auth/composition.ts", import.meta.url)))
    .split("\n").filter((line) => !line.trimStart().startsWith("//")).join("\n");
  assert.match(src, /g4AuthProfile\(read\(G4_AUTH_PROFILE_ENV\)\)/);
});
