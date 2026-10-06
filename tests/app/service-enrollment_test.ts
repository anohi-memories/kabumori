// Common-account Phase 2 (H1/C1 corrective): Kabumori enrollment.
// - the shared logic: strict answers (R5), session-bound transport and cancellation (R4);
// - the positive-ready rule for side effects (R3);
// - source wiring of auth.ts / auth-provider.tsx / _layout.tsx (PR #94's root news-detail preserved).
// The real AuthProvider is also driven through a hook runtime in tests/node/ (R2/R3/R4).
import assert from "node:assert/strict";
import test from "node:test";

import {
  createEnrollmentGate,
  createSessionBoundTransport,
  EnrollmentCancelledError,
  EnrollmentUnavailableError,
  enrollmentBlockedCopy,
  parseServiceAnswer,
  reactivateServiceExplicitly,
  startServiceAutomatically,
} from "../../src/lib/service-enrollment.ts";
import { serviceReadySession, type ServiceState } from "../../src/lib/service-session.ts";

const ACTIVE = { status: "active", service: "kabumori", started: true, shared_account: false };
const UNKNOWN = { kind: "blocked", reason: "UNKNOWN" };

test("R5: the exact active answer is ready; every incomplete or wrong answer fails closed", () => {
  assert.deepEqual(parseServiceAnswer("kabumori", ACTIVE), { kind: "ready", started: true, sharedAccountNotice: false });
  assert.deepEqual(parseServiceAnswer("kabumori", { ...ACTIVE, shared_account: true }), { kind: "ready", started: true, sharedAccountNotice: true });
  const { started: _s, ...withoutStarted } = ACTIVE;
  const { shared_account: _a, ...withoutShared } = ACTIVE;
  const malformed: unknown[] = [
    withoutStarted, { ...ACTIVE, started: null }, { ...ACTIVE, started: "true" }, { ...ACTIVE, started: 1 }, { ...ACTIVE, started: 0 },
    withoutShared, { ...ACTIVE, shared_account: null }, { ...ACTIVE, service: "x_autopost" }, { ...ACTIVE, extra: 1 },
    { ...ACTIVE, status: "Active" }, { status: "active" }, null, undefined, [], "active", 42,
    { status: "reenroll_required", service: "kabumori" }, { status: "reenroll_required", service: "kabumori", lifecycle_version: 2.5 },
    { status: "reenroll_required", service: "kabumori", lifecycle_version: -1 }, { status: "reenroll_required", service: "x_autopost", lifecycle_version: 2 },
    { status: "blocked", reason: "NEW_REASON" }, { status: "blocked", reason: "ACCOUNT_LOCKED", extra: true },
    { status: "not_registered", service: "kabumori" }, { status: "started", service: "kabumori" },
  ];
  for (const data of malformed) assert.deepEqual(parseServiceAnswer("kabumori", data), UNKNOWN, JSON.stringify(data));
  assert.deepEqual(parseServiceAnswer("kabumori", { status: "reenroll_required", service: "kabumori", lifecycle_version: 9 }), { kind: "reenroll_required", lifecycleVersion: 9 });
  assert.deepEqual(parseServiceAnswer("kabumori", { status: "lifecycle_changed", service: "kabumori", lifecycle_version: 10 }), { kind: "reenroll_required", lifecycleVersion: 10 });
  for (const reason of ["ACCOUNT_DELETION_IN_PROGRESS", "ACCOUNT_LOCKED", "SERVICE_DELETION_IN_PROGRESS", "SERVICE_SUSPENDED", "SERVICE_NOT_READY"]) {
    assert.deepEqual(parseServiceAnswer("kabumori", { status: "blocked", reason }), { kind: "blocked", reason });
  }
});

type Entry = { fn: string; token: string; body: unknown; signal: AbortSignal };
function fakeServer(answer: (entry: Entry) => unknown | "hold") {
  const requests: Entry[] = [];
  const fetchImpl = ((url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const entry = { fn: String(url).split("/rpc/")[1], token: headers.Authorization.replace(/^Bearer /u, ""), body: JSON.parse(String(init.body)), signal: init.signal as AbortSignal };
    requests.push(entry);
    const reply = answer(entry);
    if (reply === "hold") {
      return new Promise((_resolve, reject) => entry.signal.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => reply });
  }) as unknown as typeof fetch;
  return { requests, fetchImpl };
}
const transportFor = (token: string, fetchImpl: typeof fetch) =>
  createSessionBoundTransport({ url: "https://fixture.supabase.co/", apiKey: "sb_publishable_fixture", accessToken: token, fetch: fetchImpl });

test("R4: requests carry the token they were created with, to the exact RPC, and are never sent once cancelled", async () => {
  const server = fakeServer(() => ACTIVE);
  const transport = transportFor("token-A", server.fetchImpl);
  await startServiceAutomatically(transport, "kabumori", new AbortController().signal);
  await reactivateServiceExplicitly(transport, "kabumori", 4, new AbortController().signal);
  assert.deepEqual(server.requests.map((r) => [r.fn, r.token, r.body]), [
    ["start_kabumori_service", "token-A", {}],
    ["reactivate_kabumori_service", "token-A", { p_expected_lifecycle_version: 4 }],
  ]);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(startServiceAutomatically(transport, "kabumori", aborted.signal), EnrollmentCancelledError);
  await assert.rejects(reactivateServiceExplicitly(transport, "kabumori", 4, aborted.signal), EnrollmentCancelledError);
  assert.equal(server.requests.length, 2);
  assert.deepEqual(await reactivateServiceExplicitly(transport, "kabumori", 0, new AbortController().signal), UNKNOWN, "no version, no restart request");
  assert.equal(server.requests.length, 2);
});

test("R4: transient failures are retryable; a removed login is blocked", async () => {
  const offline = createSessionBoundTransport({ url: "https://f", apiKey: "k", accessToken: "t", fetch: (() => Promise.reject(new TypeError("Network request failed"))) as unknown as typeof fetch });
  await assert.rejects(startServiceAutomatically(offline, "kabumori", new AbortController().signal), EnrollmentUnavailableError);
  const gone = createSessionBoundTransport({ url: "https://f", apiKey: "k", accessToken: "t",
    fetch: (async () => ({ ok: false, status: 403, json: async () => ({ code: "42501", message: "ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND" }) })) as unknown as typeof fetch });
  assert.deepEqual(await startServiceAutomatically(gone, "kabumori", new AbortController().signal), { kind: "blocked", reason: "ACCOUNT_NOT_FOUND" });
});

test("R4: delayed A -> switch to B / sign-out: A is cancelled and never carries B's token", async () => {
  const server = fakeServer((entry) => (entry.token.startsWith("token-A") ? "hold" : ACTIVE));
  const gate = createEnrollmentGate((context, signal) => startServiceAutomatically(transportFor(context.accessToken, server.fetchImpl), "kabumori", signal));
  const a = gate.ensure({ userId: "user-A", accessToken: "token-A" });
  await new Promise((r) => setTimeout(r, 0));
  const b = gate.ensure({ userId: "user-B", accessToken: "token-B" });
  await assert.rejects(a, EnrollmentCancelledError);
  assert.equal((await b).kind, "ready");
  assert.deepEqual(server.requests.map((r) => r.token), ["token-A", "token-B"]);
  assert.ok(server.requests[0].signal.aborted);
  const again = gate.ensure({ userId: "user-A", accessToken: "token-A2" });
  await new Promise((r) => setTimeout(r, 0));
  gate.reset();
  await assert.rejects(again, EnrollmentCancelledError);
  assert.equal(server.requests.length, 3);
});

test("same person: concurrent and later events share one enrollment, even with a refreshed token", async () => {
  const server = fakeServer(() => ACTIVE);
  const gate = createEnrollmentGate((context, signal) => startServiceAutomatically(transportFor(context.accessToken, server.fetchImpl), "kabumori", signal));
  await Promise.all([gate.ensure({ userId: "u", accessToken: "t1" }), gate.ensure({ userId: "u", accessToken: "t1" })]);
  await gate.ensure({ userId: "u", accessToken: "t2" });
  assert.equal(server.requests.length, 1);
});

test("R3: side effects get a session only on a positive, settled ready for that exact person", () => {
  const session = { user: { id: "user-A" } };
  const states: ServiceState[] = [
    { phase: "signed_out" },
    { phase: "pending", userId: "user-A", request: 1 },
    { phase: "refused", userId: "user-A", request: 1, access: { kind: "blocked", reason: "SERVICE_NOT_READY" } },
    { phase: "pending", userId: "user-A", request: 2 }, // retry pending
    { phase: "refused", userId: "user-A", request: 2, access: { kind: "blocked", reason: "SERVICE_NOT_READY" } },
    { phase: "failed", userId: "user-A", request: 3, message: "x" },
    { phase: "refused", userId: "user-A", request: 4, access: { kind: "reenroll_required", lifecycleVersion: 3 } },
    { phase: "ready", userId: "user-B", request: 5 }, // another person's ready
  ];
  for (const state of states) {
    assert.equal(serviceReadySession(session, false, state), null, JSON.stringify(state));
    assert.equal(serviceReadySession(session, true, state), null);
  }
  const ready: ServiceState = { phase: "ready", userId: "user-A", request: 6 };
  assert.equal(serviceReadySession(session, true, ready), null, "not while loading");
  assert.equal(serviceReadySession(null, false, ready), null);
  assert.equal(serviceReadySession(session, false, ready), session);
});

test("every refusal has Japanese copy; only transient-looking ones offer a retry", () => {
  assert.equal(enrollmentBlockedCopy("SERVICE_NOT_READY").canRetry, true);
  assert.equal(enrollmentBlockedCopy("UNKNOWN").canRetry, true);
  for (const reason of ["ACCOUNT_DELETION_IN_PROGRESS", "ACCOUNT_LOCKED", "SERVICE_DELETION_IN_PROGRESS", "SERVICE_SUSPENDED", "ACCOUNT_NOT_FOUND"] as const) {
    assert.equal(enrollmentBlockedCopy(reason).canRetry, false, reason);
  }
});

async function source(path: string) {
  return Deno.readTextFile(new URL(`../../${path}`, import.meta.url));
}
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:])\/\/.*$/gmu, "$1");

test("Kabumori enrolls only through the reviewed RPCs over the session-bound transport; no direct writes", async () => {
  const auth = code(await source("src/lib/auth.ts"));
  assert.match(auth, /startServiceAutomatically\(transportFor\(context\), 'kabumori', signal\)/);
  assert.match(auth, /reactivateServiceExplicitly\(transportFor\(context\), 'kabumori', lifecycleVersion, signal\)/);
  assert.match(auth, /accessToken: session\.access_token/);
  assert.doesNotMatch(auth, /supabase\.(rpc|from)\(/, "enrollment never goes through the shared client");
  assert.doesNotMatch(auth, /ensure_my_profile|'x_autopost'/);
  for (const path of ["src/lib/auth.ts", "src/lib/service-enrollment.ts", "src/lib/service-session.ts", "src/providers/auth-provider.tsx"]) {
    const text = code(await source(path));
    assert.doesNotMatch(text, /\.(insert|update|upsert|delete)\(/, path);
    // auth.ts also holds the e-mail sign-in form helpers; only its enrollment block is checked.
    const scope = path === "src/lib/auth.ts"
      ? text.slice(text.indexOf("function contextOf"), text.indexOf("export function resetServiceEnrollment"))
      : text;
    assert.doesNotMatch(scope, /email/i, `${path}: no e-mail based matching or merge`);
    assert.doesNotMatch(text, /console\.|AsyncStorage\.(setItem|getItem)/, `${path}: the token is never logged or stored`);
  }
});

test("the X module is the same logic (only the 5-line header differs)", async () => {
  const kabumori = await source("src/lib/service-enrollment.ts");
  const x = await source("apps/social-mobile/src/domain/service-enrollment.ts");
  const body = (text: string) => text.split("\n").slice(5).join("\n");
  assert.equal(body(x), body(kabumori));
});

test("the provider marks every accepted session pending before enrolling, and the explicit restart is one click, now", async () => {
  const provider = code(await source("src/providers/auth-provider.tsx"));
  const accept = provider.slice(provider.indexOf("function acceptSession"), provider.indexOf("supabase.auth.getSession()"));
  assert.ok(accept.indexOf("phase: 'pending'") > -1 && accept.indexOf("phase: 'pending'") < accept.indexOf("prepareSession(nextSession)"));
  assert.match(provider, /if \(!mounted\.current \|\| request !== generation\.current\) return;/);
  assert.match(provider, /settled\.failure instanceof EnrollmentCancelledError\) return;/);
  const reenroll = provider.slice(provider.indexOf("reenroll: () => {"));
  assert.match(reenroll, /explicitInFlight\.current \|\|/);
  assert.match(reenroll, /service\.userId !== current\.user\.id/);
  assert.match(reenroll, /reactivateKabumori\(current, lifecycleVersion\)/);
  assert.match(provider, /serviceSession: serviceReadySession\(session, loading, service\)/);
});

test("the root layout opens the app and its side effects only on serviceSession, and keeps PR #94's root news-detail", async () => {
  const layout = await source("src/app/_layout.tsx");
  assert.match(layout, /<Stack\.Screen name="news-detail" \/>/, "PR #94 root detail registration preserved");
  assert.match(layout, /useRegisterPushToken\(serviceSession\)/);
  assert.match(layout, /usePushNotificationNavigation\(serviceSession\)/);
  assert.doesNotMatch(layout, /useRegisterPushToken\(session\)|usePushNotificationNavigation\(session\)/);
  const link = layout.indexOf("if (link) return <PasswordResetScreen");
  const access = layout.indexOf("session && serviceAccess");
  const failure = layout.indexOf("session && profileError");
  const app = layout.indexOf("serviceSession ? (");
  const signedIn = layout.indexOf("<SignedInNavigator />");
  assert.ok(link > -1 && access > link && failure > access && app > failure && signedIn > app, "recovery, refusal, failure, then the app only when ready");
});
