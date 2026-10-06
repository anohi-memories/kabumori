// Common-account Phase 2: Kabumori enrolls every accepted session through the reviewed lifecycle RPC
// public.start_kabumori_service(). The decision logic (src/lib/service-enrollment.ts) is exercised with
// an injected client; the wiring into auth.ts / auth-provider.tsx / _layout.tsx is pinned from source.
import assert from "node:assert/strict";
import test from "node:test";

import {
  createEnrollmentGate,
  enrollmentBlockedCopy,
  EnrollmentUnavailableError,
  enrollService,
  type EnrollmentClient,
  type EnrollmentOutcome,
  type EntitlementRow,
} from "../../src/lib/service-enrollment.ts";

type Calls = { reads: number; starts: number };

function fakeClient(
  rows: EntitlementRow[] | null,
  start: { data: unknown; error: { message: string; code?: string } | null },
  readError: { message: string } | null = null,
): EnrollmentClient & { calls: Calls } {
  const calls: Calls = { reads: 0, starts: 0 };
  return {
    calls,
    readOwnEntitlements: () => {
      calls.reads += 1;
      return Promise.resolve({ data: readError ? null : rows, error: readError });
    },
    startService: () => {
      calls.starts += 1;
      return Promise.resolve(start);
    },
  };
}

const ACTIVE_STARTED = { data: { status: "active", service: "kabumori", started: true }, error: null };
const ACTIVE_EXISTING = { data: { status: "active", service: "kabumori", started: false }, error: null };

test("a new Auth user is enrolled through the start RPC once and the app may open", async () => {
  const client = fakeClient([], ACTIVE_STARTED);
  const outcome = await enrollService(client, "kabumori");
  assert.deepEqual(outcome, { kind: "ready", started: true, sharedAccountNotice: false });
  assert.deepEqual(client.calls, { reads: 1, starts: 1 });
});

test("an existing common account that only uses X gets Kabumori added, with the shared-account notice", async () => {
  const client = fakeClient([{ service_key: "x_autopost", status: "active" }], ACTIVE_STARTED);
  const outcome = await enrollService(client, "kabumori");
  assert.deepEqual(outcome, { kind: "ready", started: true, sharedAccountNotice: true });
  assert.equal(client.calls.starts, 1, "only the Kabumori start RPC is called");
});

test("an already active Kabumori entitlement is idempotent: ready, nothing started, no notice", async () => {
  const client = fakeClient(
    [{ service_key: "kabumori", status: "active" }, { service_key: "x_autopost", status: "active" }],
    ACTIVE_EXISTING,
  );
  const outcome = await enrollService(client, "kabumori");
  assert.deepEqual(outcome, { kind: "ready", started: false, sharedAccountNotice: false });
});

test("an ended Kabumori entitlement is never restarted silently; only an explicit re-enrollment calls start", async () => {
  const ended = [{ service_key: "kabumori", status: "ended" }];
  const silent = fakeClient(ended, ACTIVE_STARTED);
  assert.deepEqual(await enrollService(silent, "kabumori"), { kind: "reenroll_required" });
  assert.equal(silent.calls.starts, 0, "no start RPC without the person's action");

  const explicit = fakeClient(ended, ACTIVE_STARTED);
  const outcome = await enrollService(explicit, "kabumori", { allowReenroll: true });
  assert.equal(outcome.kind, "ready");
  assert.equal(explicit.calls.starts, 1);
});

test("lifecycle refusals fail closed with the reason the RPC gave", async () => {
  for (const reason of [
    "ACCOUNT_DELETION_IN_PROGRESS",
    "ACCOUNT_LOCKED",
    "SERVICE_DELETION_IN_PROGRESS",
    "SERVICE_SUSPENDED",
    "SERVICE_NOT_READY",
  ]) {
    const client = fakeClient([], { data: { status: "blocked", reason }, error: null });
    assert.deepEqual(await enrollService(client, "kabumori"), { kind: "blocked", reason });
  }
});

test("an answer the client does not understand is never treated as ready", async () => {
  const shapes: unknown[] = [
    { status: "blocked", reason: "SOMETHING_NEW" },
    { status: "active", service: "x_autopost", started: true },
    { status: "active" },
    null,
    "active",
  ];
  for (const data of shapes) {
    const outcome = await enrollService(fakeClient([], { data, error: null }), "kabumori");
    assert.deepEqual(outcome, { kind: "blocked", reason: "UNKNOWN" }, JSON.stringify(data));
  }
});

test("a removed login (still-valid token) is blocked, not retried", async () => {
  for (const message of ["ACCOUNT_LIFECYCLE_ACCOUNT_NOT_FOUND", "ACCOUNT_LIFECYCLE_AUTH_REQUIRED"]) {
    const client = fakeClient([], { data: null, error: { message, code: "42501" } });
    assert.deepEqual(await enrollService(client, "kabumori"), { kind: "blocked", reason: "ACCOUNT_NOT_FOUND" });
  }
});

test("a transient failure is a retryable error and decides nothing", async () => {
  const network = fakeClient([], { data: null, error: { message: "TypeError: Network request failed" } });
  await assert.rejects(enrollService(network, "kabumori"), EnrollmentUnavailableError);

  const unreadable = fakeClient(null, ACTIVE_STARTED, { message: "fetch failed" });
  await assert.rejects(enrollService(unreadable, "kabumori"), EnrollmentUnavailableError);
  assert.equal(unreadable.calls.starts, 0, "nothing is started when the current state could not be read");
});

function deferred() {
  let resolve!: (value: EnrollmentOutcome) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<EnrollmentOutcome>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test("repeated auth events for one person share one enrollment; a decided outcome is reused", async () => {
  const runs: boolean[] = [];
  const pending = deferred();
  const gate = createEnrollmentGate((allowReenroll) => {
    runs.push(allowReenroll);
    return pending.promise;
  });
  const first = gate.ensure("user-a");
  const second = gate.ensure("user-a"); // INITIAL_SESSION + SIGNED_IN + the sign-in call itself
  const third = gate.ensure("user-a");
  assert.equal(first, second);
  assert.equal(second, third);
  pending.resolve({ kind: "ready", started: true, sharedAccountNotice: false });
  await first;
  await gate.ensure("user-a"); // TOKEN_REFRESHED later
  assert.deepEqual(runs, [false], "exactly one logical initialization");
});

test("a transient failure is not remembered: the next attempt starts again; another person or reset starts fresh", async () => {
  let calls = 0;
  const gate = createEnrollmentGate(() => {
    calls += 1;
    return calls === 1
      ? Promise.reject(new EnrollmentUnavailableError())
      : Promise.resolve({ kind: "ready", started: false, sharedAccountNotice: false } as EnrollmentOutcome);
  });
  await assert.rejects(gate.ensure("user-a"), EnrollmentUnavailableError);
  await gate.ensure("user-a");
  assert.equal(calls, 2);
  await gate.ensure("user-b");
  assert.equal(calls, 3, "another person is enrolled separately");
  gate.reset();
  await gate.ensure("user-b");
  assert.equal(calls, 4, "reset (sign-out, explicit retry) forgets the outcome");
});

test("an explicit re-enrollment runs with allowReenroll and later events share it", async () => {
  const runs: boolean[] = [];
  const gate = createEnrollmentGate((allowReenroll) => {
    runs.push(allowReenroll);
    return Promise.resolve({ kind: "ready", started: true, sharedAccountNotice: false } as EnrollmentOutcome);
  });
  await gate.reenroll("user-a");
  await gate.ensure("user-a");
  assert.deepEqual(runs, [true]);
});

test("every refusal has Japanese copy; only transient-looking ones offer a retry", () => {
  assert.equal(enrollmentBlockedCopy("SERVICE_NOT_READY").canRetry, true);
  assert.equal(enrollmentBlockedCopy("UNKNOWN").canRetry, true);
  for (const reason of ["ACCOUNT_DELETION_IN_PROGRESS", "ACCOUNT_LOCKED", "SERVICE_DELETION_IN_PROGRESS", "SERVICE_SUSPENDED", "ACCOUNT_NOT_FOUND"] as const) {
    const copy = enrollmentBlockedCopy(reason);
    assert.equal(copy.canRetry, false, reason);
    assert.match(copy.title, /[ぁ-んァ-ン一-龥]/u);
  }
});

async function source(path: string) {
  return Deno.readTextFile(new URL(`../../${path}`, import.meta.url));
}

test("Kabumori enrolls only through the reviewed RPC; no direct client write to common-account tables", async () => {
  const auth = await source("src/lib/auth.ts");
  assert.match(auth, /supabase\.rpc\('start_kabumori_service'\)/);
  assert.match(auth, /from\('service_entitlements'\)\.select\('service_key,status'\)/);
  assert.doesNotMatch(auth, /rpc\('ensure_my_profile'\)/, "the profile is created by the service start, not separately");
  for (const path of ["src/lib/auth.ts", "src/lib/service-enrollment.ts", "src/providers/auth-provider.tsx"]) {
    const text = await source(path);
    assert.doesNotMatch(text, /from\('(common_accounts|service_entitlements)'\)\.(insert|update|upsert|delete)/, path);
    assert.doesNotMatch(text, /start_x_autopost_service/, `${path} must not enroll the other app's service`);
  }
  const logic = await source("src/lib/service-enrollment.ts");
  assert.doesNotMatch(logic, /email/i, "no e-mail based matching or merge");
});

test("the root layout keeps a refused enrollment closed and touches service data only when ready", async () => {
  const layout = await source("src/app/_layout.tsx");
  const accessBranch = layout.indexOf("session && serviceAccess");
  const profileBranch = layout.indexOf("session && profileError");
  const signedIn = layout.indexOf("<SignedInNavigator");
  assert.ok(accessBranch > -1 && profileBranch > -1 && signedIn > -1);
  assert.ok(accessBranch < profileBranch && profileBranch < signedIn, "refusal, then transient failure, then the app");
  assert.match(layout, /const serviceSession = session && !serviceAccess && !profileError \? session : null;/);
  assert.match(layout, /useRegisterPushToken\(serviceSession\)/);
  assert.match(layout, /usePushNotificationNavigation\(serviceSession\)/);
});

test("the provider enrolls every accepted session and forgets the outcome on sign-out and retry", async () => {
  const provider = await source("src/providers/auth-provider.tsx");
  assert.match(provider, /prepareSession\(nextSession\)/);
  const nullBranch = provider.slice(provider.indexOf("if (!nextSession) {"), provider.indexOf("try {"));
  assert.match(nullBranch, /resetServiceEnrollment\(\)/);
  const retry = provider.slice(provider.indexOf("retry: () => {"), provider.indexOf("reenroll: () => {"));
  assert.match(retry, /resetServiceEnrollment\(\)/);
  const auth = await source("src/lib/auth.ts");
  const signOut = auth.slice(auth.indexOf("export async function signOut"), auth.indexOf("export async function requestPasswordReset"));
  assert.match(signOut, /resetServiceEnrollment\(\)/);
});

test("the shared-account notice is shown once per person, not on every later auth event", async () => {
  const provider = await source("src/providers/auth-provider.tsx");
  assert.match(provider, /outcome\.sharedAccountNotice && noticeShownFor\.current !== nextSession\.user\.id/);
  assert.match(provider, /noticeShownFor\.current = nextSession\.user\.id;\s+setEnrollmentNotice\(ENROLLMENT_NOTICE\);/);
  const nullBranch = provider.slice(provider.indexOf("if (!nextSession) {"), provider.indexOf("try {"));
  assert.match(nullBranch, /noticeShownFor\.current = null;/);
});
