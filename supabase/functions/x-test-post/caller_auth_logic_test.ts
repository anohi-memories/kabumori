// Unit tests of the x-test-post caller gate (G3 Issue #318 TASK 4/50). MOCK_ONLY, no network, no env access.
import assert from "node:assert/strict";
import {
  authorizeXTestPostCaller, callerClassOf, isInternalCaller, secretEquals, X_TEST_POST_PREVIEW_MODES,
} from "./caller_auth_logic.ts";

const env = (values: Record<string, string>) => ({ get: (n: string) => values[n] });
const SR = "fake-service-role-key-0123456789";
const CRON = "fake-cron-secret-0123456789";
const ENV = env({ SUPABASE_SERVICE_ROLE_KEY: SR, X_TEST_POST_CRON_SECRET: CRON });
const admin = (authorized: boolean) => { let calls = 0; return { fn: () => { calls += 1; return Promise.resolve({ authorized }); }, calls: () => calls }; };

Deno.test("mode classes: the handler's seven preview modes, the manual publish, and everything else = the scheduled dispatch", () => {
  assert.equal(X_TEST_POST_PREVIEW_MODES.length, 7);
  for (const m of X_TEST_POST_PREVIEW_MODES) assert.equal(callerClassOf(m), "operator_preview");
  assert.equal(callerClassOf("publish_morning_greeting_manual"), "manual_publish");
  for (const m of [undefined, null, "", "dispatch", "USEFUL_TIP_DRY_RUN", 1, {}, ["useful_tip_dry_run"]]) assert.equal(callerClassOf(m), "scheduled_dispatch", String(m));
});

Deno.test("secretEquals: exact match only; empty / unset expected never matches", async () => {
  assert.equal(await secretEquals("abc", "abc"), true);
  for (const [p, e] of [["abc", "abd"], ["abc", "abcd"], ["", ""], [null, "abc"], ["abc", undefined], ["abc", ""]] as const) assert.equal(await secretEquals(p, e), false, `${p}/${e}`);
});

Deno.test("internal caller: X-Cron-Secret or the exact service-role bearer; nothing else", async () => {
  const h = (v: Record<string, string>) => new Headers(v);
  assert.equal(await isInternalCaller(h({ "X-Cron-Secret": CRON }), ENV), true);
  assert.equal(await isInternalCaller(h({ Authorization: `Bearer ${SR}` }), ENV), true);
  assert.equal(await isInternalCaller(h({ Authorization: `bearer ${SR}` }), ENV), true, "scheme is case-insensitive");
  for (const v of [{}, { "X-Cron-Secret": SR }, { Authorization: `Bearer ${CRON}` }, { Authorization: `Bearer ${SR} extra` }, { Authorization: SR }, { "X-Cron-Secret": `${CRON}x` }]) {  // header values are whitespace-trimmed by HTTP itself
    assert.equal(await isInternalCaller(h(v as Record<string, string>), ENV), false, JSON.stringify(v));
  }
  assert.equal(await isInternalCaller(h({ "X-Cron-Secret": "" }), env({ X_TEST_POST_CRON_SECRET: "" })), false);
});

Deno.test("decision table: dispatch = internal only (admin never asked); preview = internal or admin; manual publish deferred; admin errors fail closed", async () => {
  const none = new Headers();
  const internal = new Headers({ "X-Cron-Secret": CRON });
  const a = admin(true);
  assert.deepEqual(await authorizeXTestPostCaller({ mode: undefined, headers: none, env: ENV, resolveAdmin: a.fn }), { ok: false, status: 401, code: "X_TEST_POST_CALLER_UNAUTHORIZED" });
  assert.equal(a.calls(), 0, "the scheduled dispatch never consults the admin port");
  assert.deepEqual(await authorizeXTestPostCaller({ mode: undefined, headers: internal, env: ENV, resolveAdmin: a.fn }), { ok: true, caller: "internal" });
  assert.deepEqual(await authorizeXTestPostCaller({ mode: "useful_tip_dry_run", headers: none, env: ENV, resolveAdmin: a.fn }), { ok: true, caller: "admin" });
  assert.deepEqual(await authorizeXTestPostCaller({ mode: "useful_tip_dry_run", headers: none, env: ENV, resolveAdmin: admin(false).fn }), { ok: false, status: 401, code: "X_TEST_POST_CALLER_UNAUTHORIZED" });
  assert.deepEqual(await authorizeXTestPostCaller({ mode: "test_morning_greeting_image", headers: none, env: ENV, resolveAdmin: () => Promise.reject(new Error("auth down")) }),
    { ok: false, status: 401, code: "X_TEST_POST_CALLER_UNAUTHORIZED" });
  assert.deepEqual(await authorizeXTestPostCaller({ mode: "test_morning_greeting_image", headers: none, env: ENV, resolveAdmin: () => Promise.resolve({ authorized: "yes" as never }) }),
    { ok: false, status: 401, code: "X_TEST_POST_CALLER_UNAUTHORIZED" });
  assert.deepEqual(await authorizeXTestPostCaller({ mode: "publish_morning_greeting_manual", headers: none, env: ENV, resolveAdmin: a.fn }), { ok: true, caller: "deferred_to_manual_publish_check" });
});

Deno.test("source: the gate logs nothing, reads no env itself and never echoes a credential", async () => {
  const source = await Deno.readTextFile(new URL("./caller_auth_logic.ts", import.meta.url));
  for (const banned of ["console.", "Deno.env", "fetch("]) assert.ok(!source.includes(banned), banned);
});

Deno.test("secretEquals compares the WHOLE digest: a wrong secret whose SHA-256 shares the first bytes still fails", async () => {
  const first = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))[0];
  const target = await first(CRON);
  let twin = "";
  for (let i = 0; i < 100_000 && !twin; i += 1) if (await first(`wrong-${i}`) === target) twin = `wrong-${i}`;
  assert.ok(twin, "a first-byte twin exists");
  assert.equal(await secretEquals(twin, CRON), false);
});
