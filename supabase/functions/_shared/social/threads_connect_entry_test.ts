import assert from "node:assert/strict";
import test from "node:test";
import { handler as disabledHandler } from "../../../candidates/postona_threads_auth_runtime/disabled_entry.ts";
import { handler as edgeHandler } from "../../threads-oauth-connect-user/index.ts";
import {
  CANONICAL_PREFIX,
  createThreadsConnectEntry,
  harmonizedThreadsEnv,
  THREADS_CONNECT_ENABLE_ENV,
  THREADS_ENV_ALIASES,
} from "./threads_connect_entry.ts";
import { createThreadsConnectHandler, THREADS_CONNECT_EDGE_WIRED } from "./threads_connect_edge.ts";

// F4 entry adapter, offline. Fake values only, distinctive so a leak into a response is easy to spot.
const SECRET = "fake_app_secret_LEAKCHECK_0123456789";
const OPEN = { wired: true };
const post = (body: unknown = { action: "start" }) =>
  new Request("https://edge.example/functions/v1/threads-oauth-connect-user", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer caller-jwt-fixture" },
    body: JSON.stringify(body),
  });
function env(values: Record<string, string>) {
  const reads: string[] = [];
  return { reads, read: (name: string) => { reads.push(name); return values[name]; } };
}
const neverLoad = () => Promise.reject(new Error("composition must not be loaded"));

test("in source the static gate is closed and the Edge entry IS H5's disabled handler", async () => {
  assert.equal(THREADS_CONNECT_EDGE_WIRED, false);
  assert.equal(edgeHandler, disabledHandler, "the deployed entry is exactly the hard-disabled handler");
  const response = edgeHandler(post()) as Response;
  assert.equal(response.status, 503);
  assert.equal(await response.text(), '{"error":"THREADS_CONNECT_DISABLED"}');
});

test("closed gates: no environment is read and nothing is loaded or constructed", () => {
  for (const gates of [undefined, { wired: false }]) {
    const e = env({ [THREADS_CONNECT_ENABLE_ENV]: "true" });
    const entry = createThreadsConnectEntry({ read: e.read, gates, loadComposition: neverLoad });
    assert.equal(entry, disabledHandler, JSON.stringify(gates));
    assert.deepEqual(e.reads, [], "the environment is not even read");
  }
});

test("open gates but the runtime switch is not exactly \"true\": still the disabled answer, nothing loaded", async () => {
  for (const value of [undefined, "", "TRUE", "1", "yes", "true "]) {
    const e = env(value === undefined ? {} : { [THREADS_CONNECT_ENABLE_ENV]: value });
    const response = await createThreadsConnectEntry({ read: e.read, gates: OPEN, loadComposition: neverLoad })(post());
    assert.equal(response.status, 503, String(value));
    assert.equal(await response.text(), '{"error":"THREADS_CONNECT_DISABLED"}');
    assert.deepEqual(e.reads, [THREADS_CONNECT_ENABLE_ENV]);
  }
});

test("a canonical name and its alias that disagree are refused before anything is loaded; no value is echoed", async () => {
  for (const [name, alias] of Object.entries(THREADS_ENV_ALIASES)) {
    const e = env({ [THREADS_CONNECT_ENABLE_ENV]: "true", [CANONICAL_PREFIX + name]: `${SECRET}-a`, [alias]: `${SECRET}-b` });
    const response = await createThreadsConnectEntry({ read: e.read, gates: OPEN, loadComposition: neverLoad })(post());
    assert.equal(response.status, 503, name);
    const text = await response.text();
    assert.equal(text, '{"ok":false,"error":"THREADS_CONNECT_RUNTIME_UNAVAILABLE"}');
    assert.ok(!text.includes(SECRET));
  }
});

test("the harmonized reader: canonical first, alias only as a fallback, nothing else", () => {
  const h = harmonizedThreadsEnv((name) => ({
    POSTONA_THREADS_APP_ID: "111",
    THREADS_APP_SECRET: SECRET,
    THREADS_REDIRECT_URI: "https://postona.example/threads/callback",
    POSTONA_THREADS_CALLBACK: "",
    POSTONA_THREADS_DB_OWNER: "offline_owner",
    SUPABASE_SERVICE_ROLE_KEY: "must-not-be-read-through",
  } as Record<string, string>)[name]);
  assert.equal(h.ok, true);
  if (!h.ok) return;
  assert.equal(h.read("POSTONA_THREADS_APP_ID"), "111");
  assert.equal(h.read("POSTONA_THREADS_APP_SECRET"), SECRET, "alias fallback");
  assert.equal(h.read("POSTONA_THREADS_CALLBACK"), "https://postona.example/threads/callback", "an empty canonical value falls back");
  assert.equal(h.read("POSTONA_THREADS_DB_OWNER"), "offline_owner");
  assert.equal(h.read("POSTONA_THREADS_ATTESTATION_KEY"), undefined);
  assert.equal(h.read("SUPABASE_SERVICE_ROLE_KEY"), undefined, "only POSTONA_THREADS_* names are readable");
  assert.equal(harmonizedThreadsEnv((name) => (name === "POSTONA_THREADS_APP_ID" || name === "THREADS_APP_ID" ? "111" : undefined)).ok, true, "equal values agree");
});

test("past every gate the H5 composition is built once with G4's handler factory and the harmonized reader", async () => {
  const builds: Array<{ factory: unknown; appId: string | undefined }> = [];
  const loadComposition = () => Promise.resolve({
    buildForApprovedSourceIntegration(factory: unknown, read: (name: string) => string | undefined) {
      builds.push({ factory, appId: read("POSTONA_THREADS_APP_ID") });
      return { sourceHandler: () => Promise.resolve(Response.json({ ok: true, via: "source" })) };
    },
  });
  const e = env({ [THREADS_CONNECT_ENABLE_ENV]: "true", THREADS_APP_ID: "222" });
  const entry = createThreadsConnectEntry({ read: e.read, gates: OPEN, loadComposition });
  for (let i = 0; i < 3; i += 1) assert.deepEqual(await (await entry(post())).json(), { ok: true, via: "source" });
  assert.equal(builds.length, 1, "constructed once");
  assert.equal(builds[0].factory, createThreadsConnectHandler);
  assert.equal(builds[0].appId, "222", "the alias reaches the runtime only through the canonical name");
});

test("a construction that throws (H5 refuses the config) fails closed every time and is retried, never cached as success", async () => {
  let attempts = 0;
  const loadComposition = () => Promise.resolve({
    buildForApprovedSourceIntegration() {
      attempts += 1;
      throw new Error(`CONFIG_UNAVAILABLE ${SECRET}`);
    },
  });
  const entry = createThreadsConnectEntry({ read: env({ [THREADS_CONNECT_ENABLE_ENV]: "true" }).read, gates: OPEN, loadComposition });
  for (let i = 0; i < 2; i += 1) {
    const response = await entry(post());
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.equal(text, '{"ok":false,"error":"THREADS_CONNECT_RUNTIME_UNAVAILABLE"}');
    assert.ok(!text.includes(SECRET));
  }
  assert.equal(attempts, 2);
});

test("the Edge index stays free of the real composition (H5 isolation invariant) and only delegates to the adapter", async () => {
  const entry = await Deno.readTextFile(new URL("../../threads-oauth-connect-user/index.ts", import.meta.url));
  assert.doesNotMatch(entry, /server_factory|nondeployable|Deno\.env|createSourceServer/);
  assert.match(entry, /from "\.\.\/_shared\/social\/threads_connect_entry\.ts"/);
  const adapter = await Deno.readTextFile(new URL("./threads_connect_entry.ts", import.meta.url));
  assert.doesNotMatch(adapter, /^import[^\n]*nondeployable/m, "the composition is never statically imported");
  assert.doesNotMatch(adapter, /console\.(log|warn|error)/);
});
